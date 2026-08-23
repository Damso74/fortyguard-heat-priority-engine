import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadDatasetManifest, loadSourceProvenance, loadStopDataset } from '@/lib/data/stops'
import { DAY_TYPES } from '@/lib/types'

/**
 * Regression guard on the published counts this project depends on.
 *
 * These are not arbitrary snapshot values: each is a record count from an
 * official layer or a coverage statistic derived from two of them. If one moves,
 * either an upstream layer changed or the pipeline broke — and the difference
 * has to be explained in docs/data-provenance.md before the value here is edited.
 */

const ROOT = process.cwd()
const spikeMetrics = JSON.parse(
  readFileSync(join(ROOT, 'outputs', 'spike_metrics.json'), 'utf-8'),
) as Record<string, Record<string, number | boolean | string>>

describe('spike baseline metrics', () => {
  it('pins the source record counts', () => {
    expect(spikeMetrics.sources).toEqual({
      phoenix_city_bus_stops: 4104,
      valley_metro_phoenix_stops: 4289,
      valley_metro_active_phoenix_stops: 4288,
      historical_valley_metro_phoenix_stops: 4758,
    })
  })

  it('pins the join statistics', () => {
    expect(spikeMetrics.join).toMatchObject({
      direct_stop_id_matches: 4072,
      stop_code_only_matches: 0,
      unmatched_valley_stops: 216,
      city_coverage_pct: 99.22,
      coordinate_delta_median_m: 0.04,
      coordinate_delta_p95_m: 0.06,
    })
  })

  it('pins the shelter-inventory contradiction that blocks any installation claim', () => {
    expect(spikeMetrics.shelter_inventory).toMatchObject({
      city_non_null: 20,
      city_positive: 20,
      valley_positive_integer: 0,
      valley_string_one: 1,
      official_sheltered_stop_total_fy2025: 3164,
      usable_for_unshaded_classification: false,
    })
  })
})

describe('generated analysis dataset', () => {
  const dataset = loadStopDataset()
  const manifest = loadDatasetManifest()

  it('holds every active Phoenix stop', () => {
    expect(dataset.stops).toHaveLength(4288)
    expect(dataset.counts.activeStops).toBe(4288)
    expect(dataset.version).toBe(2)
  })

  it('carries documented ridership with a unit, a period and a day category', () => {
    // Newer BusRidershipByQuarterForPortal service; better coverage than the
    // superseded BusStopQuarterlyRidership layer, which gave 3960.
    expect(dataset.counts.withDocumentedRidership).toBe(3991)
    expect(dataset.counts.ridershipCoveragePct).toBe(93.07)

    const withRidership = dataset.stops.filter((stop) => stop.ridership !== null)
    expect(withRidership.length).toBeGreaterThan(3900)
    for (const stop of withRidership.slice(0, 100)) {
      expect(stop.ridership!.baseQuarter).toBe('2024_4')
      // Every drift quarter is retained, and weekday/weekend stay separate
      // figures rather than one blended number.
      for (const quarter of ['2024_4', '2024_3', '2024_2']) {
        expect(stop.ridership!.byQuarter).toHaveProperty(quarter)
        expect(stop.ridership!.byQuarter[quarter]).toHaveProperty('weekday')
        expect(stop.ridership!.byQuarter[quarter]).toHaveProperty('weekend')
      }
    }
  })

  it('carries scheduled service derived from the official GTFS feed, per day type', () => {
    expect(dataset.counts.withScheduledService).toBe(4265)
    expect(dataset.counts.serviceCoveragePct).toBe(99.46)

    // Each day type is extracted separately. Weekend service is genuinely
    // thinner, which is exactly why it may not borrow the weekday timetable.
    expect(dataset.counts.serviceCoverageByDayType).toEqual({
      weekday: 4265,
      saturday: 4218,
      sunday: 4215,
    })

    const withService = dataset.stops.filter((stop) => stop.service !== null)
    for (const stop of withService.slice(0, 100)) {
      for (const dayType of DAY_TYPES) {
        const service = stop.service!.byDayType[dayType]
        if (!service) continue
        expect(service.hourlyDepartures).toHaveLength(24)
        expect(service.routeCount).toBeGreaterThan(0)

        // Actual departure minutes, sorted — not counts. Values at or beyond
        // 1440 are GTFS times of 24:00 and later, preserved rather than wrapped.
        const perRoute = Object.values(service.routeDepartures)
        expect(perRoute.length).toBe(service.routeCount)
        let departureTotal = 0
        let afterMidnight = 0
        for (const minutes of perRoute) {
          departureTotal += minutes.length
          expect([...minutes].sort((a, b) => a - b)).toEqual(minutes)
          for (const minute of minutes) {
            expect(minute).toBeGreaterThanOrEqual(0)
            // GTFS permits times past 24:00; nothing here should exceed 48:00.
            expect(minute).toBeLessThan(2880)
            if (minute >= 1440) afterMidnight += 1
          }
        }

        // The hourly roll-up is on CLOCK hours, so it must agree with the
        // departure times only after the same projection.
        const hourlyTotal = service.hourlyDepartures.reduce((sum, count) => sum + count, 0)
        expect(departureTotal).toBe(hourlyTotal)
        expect(hourlyTotal).toBe(service.dailyDepartures)
        expect(afterMidnight).toBe(service.departuresAfterMidnight)
      }
    }
  })

  it('preserves GTFS times past 24:00 somewhere in the feed', () => {
    // 1,035 weekday departures sit at or past midnight. If the parser wrapped
    // them the count would be zero and the service-day distinction would be
    // silently gone.
    const total = dataset.stops.reduce(
      (sum, stop) => sum + (stop.service?.byDayType.weekday?.departuresAfterMidnight ?? 0),
      0,
    )
    expect(total).toBeGreaterThan(0)
  })

  it('records executable completeness checks that select the base quarter', () => {
    const completeness = dataset.provenance.ridership.completenessChecks
    // The claim "later quarters fail our checks" is computed, not asserted.
    expect(completeness.quarters['2025_1']!.passes).toBe(false)
    expect(completeness.quarters['2025_2']!.passes).toBe(false)
    expect(completeness.quarters['2025_3']!.passes).toBe(false)
    expect(completeness.quarters['2024_4']!.passes).toBe(true)
    expect(completeness.latestPassing).toBe('2024_4')
    expect(completeness.selected).toBe('2024_4')
    expect(completeness.selectedIsLatestPassing).toBe(true)
    // And the product never claims those checks were reconciled elsewhere.
    expect(completeness.checks.independentlyReconciled).toBe(false)
  })

  it('never converts an unknown shelter into a negative claim', () => {
    const statuses = new Set(dataset.stops.map((stop) => stop.shelterStatus))
    expect([...statuses]).toEqual(['unknown'])
    expect(dataset.counts.shelterStatusKnown).toBe(0)
  })

  it('leaves missing ridership and missing service as null, never zero', () => {
    const noRidership = dataset.stops.filter((stop) => stop.ridership === null)
    expect(noRidership.length).toBe(4288 - 3991)
    for (const stop of noRidership) expect(stop.ridership).toBeNull()

    const noService = dataset.stops.filter((stop) => stop.service === null)
    expect(noService.length).toBe(4288 - 4265)
    for (const stop of noService) expect(stop.service).toBeNull()
  })

  it('keeps the undocumented City index out of every computation', () => {
    // It is retained for comparison only; nothing downstream reads it.
    const withLegacy = dataset.stops.filter((stop) => stop.legacyRidershipIndex !== null)
    expect(withLegacy.length).toBeGreaterThan(3900)
    const provenance = dataset.provenance as Record<string, { caveat?: string }>
    expect(provenance.legacyRidershipIndex?.caveat).toMatch(/cross-check only/)
  })

  it('holds only valid Phoenix-area coordinates and unique ids', () => {
    const ids = new Set<number>()
    for (const stop of dataset.stops) {
      expect(stop.lat).toBeGreaterThan(33.2)
      expect(stop.lat).toBeLessThan(33.8)
      expect(stop.lon).toBeGreaterThan(-112.4)
      expect(stop.lon).toBeLessThan(-111.8)
      ids.add(stop.id)
    }
    expect(ids.size).toBe(dataset.stops.length)
  })

  it('matches the SHA-256 recorded in its manifest', () => {
    const bytes = readFileSync(join(ROOT, manifest.artifact.path))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.artifact.sha256)
    expect(manifest.artifact.records).toBe(4288)
    // Four upstream artefacts feed the join.
    expect(manifest.derivedFrom).toHaveLength(4)
  })
})

describe('source provenance manifest', () => {
  const provenance = loadSourceProvenance()
  const generatedManifest = loadDatasetManifest()

  it('verifies retained raw hashes and records excluded-source hashes', () => {
    expect(provenance.sources.length).toBeGreaterThanOrEqual(4)
    for (const source of provenance.sources) {
      const path = join(ROOT, source.artifact.path)
      if (existsSync(path)) {
        const bytes = readFileSync(path)
        expect(createHash('sha256').update(bytes).digest('hex'), `${source.key} hash`).toBe(
          source.artifact.sha256,
        )
      } else {
        expect(['phoenix_bus_stops', 'valley_metro_quarterly_ridership']).toContain(source.key)
        expect(generatedManifest.derivedFrom).toContainEqual({
          path: source.artifact.path,
          sha256: source.artifact.sha256,
        })
      }
      expect(source.record_count).toBeGreaterThan(0)
      expect(source.known_limitations.length).toBeGreaterThan(0)
      expect(source.layer_url).toMatch(/^https:\/\//)
    }
  })

  it('records the counts the pipeline depends on', () => {
    const byKey = new Map(provenance.sources.map((source) => [source.key, source]))
    expect(byKey.get('phoenix_bus_stops')?.record_count).toBe(4104)
    expect(byKey.get('valley_metro_phoenix_stops')?.record_count).toBe(4289)
    expect(byKey.get('valley_metro_phoenix_stops_2023')?.record_count).toBe(4758)
    expect(byKey.get('valley_metro_quarterly_ridership')?.record_count).toBeGreaterThan(7000)
  })

  it('records the GTFS feed with its licence', () => {
    const gtfs = JSON.parse(
      readFileSync(join(ROOT, 'data', 'raw', 'valley_metro_gtfs_metadata.json'), 'utf-8'),
    ) as { licence: string; artifact: { path: string; sha256: string }; download_url: string }

    expect(gtfs.licence).toMatch(/ODC-BY/)
    const bytes = readFileSync(join(ROOT, gtfs.artifact.path))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(gtfs.artifact.sha256)
    // The stable CKAN URL is recorded — never the presigned S3 URL it redirects
    // to, which carries an AWS access key id and signature.
    expect(gtfs.download_url).toContain('phoenixopendata.com')
    expect(JSON.stringify(gtfs)).not.toMatch(/X-Amz-Signature|AKIA/)
  })
})
