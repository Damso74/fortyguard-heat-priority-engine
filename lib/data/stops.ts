import type { StopDataset } from '@/lib/types'
import datasetJson from '@/data/generated/phoenix_transit_stops.json'
import manifestJson from '@/data/manifests/generated-dataset.json'
import provenanceJson from '@/data/manifests/source-provenance.json'

/**
 * The generated stop dataset, imported statically so the deployment bundle
 * always contains it (no runtime filesystem assumptions on serverless).
 *
 * The dataset is derived, never edited by hand: `scripts/fetch/fetch_arcgis.py`
 * downloads the official layers and `scripts/generate/build_analysis_dataset.py`
 * joins them. Its SHA-256 is pinned in `data/manifests/generated-dataset.json`
 * and asserted by the data tests.
 */

export interface DatasetManifest {
  generatedAtUtc: string
  artifact: {
    path: string
    sha256: string
    /**
     * Digest of the document with `generatedAtUtc` removed.
     *
     * `sha256` moves on every rebuild because the timestamp is inside the file,
     * which makes it useless as a reproducibility target. This is the value a
     * clean-clone rebuild must reproduce, and it is what `npm run verify` and CI
     * compare.
     */
    canonicalSha256: string
    bytes: number
    records: number
  }
  derivedFrom: Array<{ path: string; sha256: string }>
}

export interface SourceProvenanceEntry {
  key: string
  title: string
  producer: string
  layer_url: string
  downloaded_at_utc: string
  service_last_edit_utc: string | null
  record_count: number
  requested_projection: string
  fields_used_by_this_project: string[]
  known_limitations: string[]
  terms_of_use: string
  artifact: { path: string; sha256: string; bytes: number }
}

export function loadStopDataset(): StopDataset {
  return datasetJson as unknown as StopDataset
}

export function loadDatasetManifest(): DatasetManifest {
  return manifestJson as unknown as DatasetManifest
}

export function loadSourceProvenance(): {
  generated_at_utc: string
  generator: string
  sources: SourceProvenanceEntry[]
} {
  return provenanceJson as unknown as {
    generated_at_utc: string
    generator: string
    sources: SourceProvenanceEntry[]
  }
}

/** Share of stops carrying a published ridership figure. */
export function ridershipCoverage(dataset: StopDataset = loadStopDataset()): number {
  if (dataset.stops.length === 0) return 0
  return (
    dataset.stops.filter((stop) => stop.ridership !== null).length /
    dataset.stops.length
  )
}

/** Share of stops carrying a scheduled service profile. */
export function serviceCoverage(dataset: StopDataset = loadStopDataset()): number {
  if (dataset.stops.length === 0) return 0
  return dataset.stops.filter((stop) => stop.service !== null).length / dataset.stops.length
}

/** Age in days of the Valley Metro layer, or null when it is not published. */
export function stopLayerAgeDays(now: Date = new Date()): number | null {
  const provenance = loadSourceProvenance()
  const entry = provenance.sources.find((source) => source.key === 'valley_metro_phoenix_stops')
  if (!entry?.service_last_edit_utc) return null
  const edited = Date.parse(entry.service_last_edit_utc)
  if (!Number.isFinite(edited)) return null
  return Math.max(0, (now.getTime() - edited) / 86_400_000)
}
