import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What this repository redistributes, checked against what it says it does.
 *
 * The defect: `data-provenance.md` said the ArcGIS layers "are not redistributed
 * beyond the local copies the fetch scripts create", and
 * `hackathon-compliance.md` said "no dataset is redistributed beyond what the
 * fetch scripts download for local analysis". Both were false. Roughly 19 MB of
 * those layers is committed and public, and committing a file to a public
 * repository is redistribution.
 *
 * A sentence cannot be trusted to stay true, so the list is derived from `git
 * ls-files` and compared against the documented one. Adding a raw source file
 * without documenting it — or documenting one that has been removed — fails here.
 *
 * This test asserts **accuracy of the claim** after the owner selected removal:
 * the two unresolved extracts must stay absent, while every remaining transit
 * source in the tracked raw tree has a recorded exact-source grant.
 */

const ROOT = process.cwd()

/**
 * Raw source extracts this repository knowingly redistributes. A non-null value
 * names the terms published on the exact source item, not a portal-wide inference.
 * `licence: null` means permission remains unresolved; silence is not permission.
 */
const DOCUMENTED_REDISTRIBUTION = [
  {
    file: 'data/raw/valley_metro_phoenix_stops.geojson',
    licence: 'Valley Metro ArcGIS item — unrestricted sharing, modification and use',
  },
  {
    file: 'data/raw/valley_metro_phoenix_stops_2023.geojson',
    licence: 'Valley Metro ArcGIS item — unrestricted sharing, modification and use',
  },
  { file: 'data/raw/valley_metro_gtfs.zip', licence: 'ODC-BY' },
] as const

/** Metadata *about* a source is a fact this project recorded, not the source. */
const METADATA_SUFFIX = '_metadata.json'

function trackedRawFiles(): string[] {
  const output = execFileSync('git', ['ls-files', 'data/raw'], {
    cwd: ROOT,
    encoding: 'utf-8',
  })
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => existsSync(join(ROOT, file)))
    .filter((file) => !file.endsWith(METADATA_SUFFIX))
    .sort()
}

describe('the redistribution claim matches the tracked tree', () => {
  it('documents exactly the raw sources that are actually committed', () => {
    expect(trackedRawFiles()).toEqual(
      DOCUMENTED_REDISTRIBUTION.map((entry) => entry.file).sort(),
    )
  })

  it('does not repeat the claim that nothing is redistributed', () => {
    const provenance = readFileSync(join(ROOT, 'docs', 'data-provenance.md'), 'utf-8')
    const compliance = readFileSync(join(ROOT, 'docs', 'hackathon-compliance.md'), 'utf-8')

    // The two sentences that were false.
    expect(provenance).not.toContain('not\nredistributed beyond the local copies')
    expect(provenance).not.toContain('are not redistributed beyond the local copies')
    expect(compliance).not.toContain(
      'No dataset is redistributed beyond what the fetch scripts download',
    )
  })

  it('records the clean public root without inventing a licence', () => {
    const provenance = readFileSync(join(ROOT, 'docs', 'data-provenance.md'), 'utf-8')
    expect(provenance).toMatch(/Status: `RESOLVED BY CLEAN REPOSITORY`/)
    expect(provenance).toMatch(/Silence is still not permission/)
    // Unresolved rows require exact-item or direct permission, never a portal-wide
    // inference. Established rows name their exact-item grant.
    expect(provenance).toMatch(/direct written permission/)
    expect(provenance).toMatch(/exact-source matrix|Exact source endpoint|Exact source/i)
    expect(provenance).toMatch(/committed and public/)
    expect(provenance).toMatch(/read-only\s+PR ref retained them/i)
    expect(provenance).toMatch(/public submission repository was created independently/i)
    expect(provenance).toMatch(/earlier publication\s+never happened/i)
    expect(provenance).toMatch(/begins at one root commit/i)
    // Every established source is named; unresolved raw extracts are absent.
    expect(provenance).toMatch(/Open Data Commons\s+Attribution License \(ODC-BY\)/)
    expect(provenance).toMatch(/freely share, modify,? and use/i)
    expect(trackedRawFiles()).not.toContain('data/raw/phoenix_bus_stops.geojson')
    expect(trackedRawFiles()).not.toContain('data/raw/valley_metro_quarterly_ridership.json')
    expect(trackedRawFiles()).not.toContain('data/raw/fortyguard_openapi.json')
  })

  it('keeps every redistributed layer re-fetchable, whatever is decided', () => {
    // Removing the extracts must not remove the ability to rebuild them, so the
    // URL, query, timestamp, counts and hash live in the manifest rather than in
    // the file itself.
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'data', 'manifests', 'source-provenance.json'), 'utf-8'),
    ) as { sources: Array<{ layer_url?: string; sha256?: string; downloaded_at_utc?: string }> }

    expect(manifest.sources.length).toBeGreaterThan(0)
    for (const source of manifest.sources) {
      expect(source.layer_url ?? '').toMatch(/^https?:\/\//)
      expect(source.downloaded_at_utc ?? '').not.toBe('')
    }
  })

  it('keeps the explicit, non-destructive removal procedure', () => {
    const script = readFileSync(
      join(ROOT, 'scripts', 'unredistribute-raw-layers.mjs'),
      'utf-8',
    )
    // It must refuse to do anything without an explicit confirmation flag:
    // removing raw data from a public repository is not a default.
    expect(script).toContain('--i-have-a-licensing-decision')
    expect(script).toMatch(/does not rewrite history/i)
    // And the files it TARGETS are the ones whose terms are unestablished. The
    // ODC-BY archive is named elsewhere in the script — under "kept
    // deliberately" — so the check has to read the removal list itself rather
    // than the whole file.
    const list = /const UNLICENSED_EXTRACTS = \[([\s\S]*?)\]/.exec(script)?.[1] ?? ''
    expect(list).toContain('phoenix_bus_stops.geojson')
    expect(list).toContain('valley_metro_quarterly_ridership.json')
    expect(list).not.toContain('valley_metro_phoenix_stops.geojson')
    expect(list).not.toContain('valley_metro_phoenix_stops_2023.geojson')
    expect(list).not.toContain('valley_metro_gtfs.zip')
    expect(script).toContain('ODC-BY permits redistribution with attribution')
  })
})
