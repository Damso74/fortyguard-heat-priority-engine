import { describe, expect, it } from 'vitest'
import { cleanArcGisLabel, isRidershipQuarter, parsePublishedNumber } from '@/lib/ridership/source'
import { normaliseRidershipFeature } from '@/app/api/ridership/route'

describe('Valley Metro ridership source boundary', () => {
  it('parses published string fields without converting missing data to zero', () => {
    expect(parsePublishedNumber(' 41.25 ')).toBe(41.25)
    expect(parsePublishedNumber('0')).toBe(0)
    expect(parsePublishedNumber('')).toBeNull()
    expect(parsePublishedNumber(null)).toBeNull()
    expect(parsePublishedNumber('-2')).toBeNull()
    expect(parsePublishedNumber('not-a-number')).toBeNull()
  })

  it('accepts only the explicitly published quarter fields', () => {
    expect(isRidershipQuarter('2024_4')).toBe(true)
    expect(isRidershipQuarter('2025_3')).toBe(true)
    expect(isRidershipQuarter('2025_4')).toBe(false)
    expect(isRidershipQuarter("2024_4' OR 1=1")).toBe(false)
  })

  it('normalises the narrow ArcGIS response and rejects invalid geometry', () => {
    const stop = normaliseRidershipFeature(
      {
        attributes: {
          OBJECTID: 17,
          StopID: 512,
          BusStopNum: 512,
          Nextride: 512,
          Location: '  EB McDowell\u0000 Rd   & Central Av  ',
          Juris: 'Phoenix',
          Status: 'Active',
          avg2024_4: '94.95',
          tot2024_4: '5887',
        },
        geometry: { x: -112.0733, y: 33.4656 },
      },
      '2024_4',
      'Weekday',
    )

    expect(stop).toMatchObject({
      stopId: 512,
      name: 'EB McDowell Rd & Central Av',
      publishedAverage: 94.95,
      publishedQuarterTotal: 5887,
      dayCategory: 'Weekday',
    })
    expect(
      normaliseRidershipFeature(
        { attributes: { OBJECTID: 1, StopID: 2 }, geometry: { x: 900, y: 33 } },
        '2024_4',
        'Weekday',
      ),
    ).toBeNull()
  })

  it('cleans control characters and supplies a bounded fallback label', () => {
    expect(cleanArcGisLabel('\u0007 Stop   name ', 'Fallback')).toBe('Stop name')
    expect(cleanArcGisLabel(null, 'Fallback')).toBe('Fallback')
  })
})
