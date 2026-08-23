import type { FortyGuardFeatureCollection } from './schema'

/**
 * Resolve which feature property carries the analytic value.
 *
 * The spike auto-detected this with a substring match on `temp`/`tcm`, which
 * would happily pick `temp_flag` or the first of two competing fields and then
 * label the result "°C". That is exactly the kind of quiet guess this project
 * forbids, so detection is now a closed whitelist:
 *
 * - only names on the list below are eligible;
 * - a name must be numeric on at least `minCoverage` of features;
 * - if two eligible names both qualify, resolution FAILS rather than picking
 *   one, unless the caller passes an explicit `override` recorded by the
 *   capability probe;
 * - if none qualify, resolution FAILS and reports every property name seen.
 *
 * A failure here is intended to stop the pipeline. A wrongly identified field
 * would silently corrupt every score downstream.
 */

/** Ordered by specificity. Earlier entries win when coverage is equal. */
export const TCM_FIELD_WHITELIST = [
  'tcm',
  'temperature_celsius',
  'temperature_c',
  'temp_celsius',
  'temp_c',
  'air_temperature',
  'ambient_temperature',
  'temperature',
  'temp',
] as const

/** Analytic types that return hours, per the endpoint documentation. */
export const HOUR_FIELD_WHITELIST = [
  'time_of_measure',
  'exceedance',
  'persistence',
  'hours',
  'value',
] as const

export interface ValueFieldResolution {
  field: string
  /** Fraction of features on which the field held a finite number. */
  coverage: number
  /** How the field was decided. Recorded verbatim in the capability report. */
  resolvedBy: 'whitelist' | 'override'
  candidatesConsidered: string[]
  observedProperties: string[]
}

export class ValueFieldError extends Error {
  readonly observedProperties: string[]
  readonly candidates: string[]

  constructor(message: string, observedProperties: string[], candidates: string[]) {
    super(message)
    this.name = 'ValueFieldError'
    this.observedProperties = observedProperties
    this.candidates = candidates
  }
}

export interface ResolveOptions {
  analyticType?: string
  /** Explicit field name confirmed by a human after reading the probe output. */
  override?: string | undefined
  minCoverage?: number
}

export function resolveValueField(
  collection: FortyGuardFeatureCollection,
  options: ResolveOptions = {},
): ValueFieldResolution {
  const { analyticType = 'tcm', override, minCoverage = 0.9 } = options
  const features = collection.features
  if (features.length === 0) {
    throw new ValueFieldError('Heatmap returned zero features; no value field to resolve.', [], [])
  }

  const observed = new Set<string>()
  for (const feature of features) {
    for (const key of Object.keys(feature.properties ?? {})) observed.add(key)
  }
  const observedProperties = [...observed].sort()

  const coverageOf = (name: string): number => {
    let numeric = 0
    for (const feature of features) {
      const value = (feature.properties ?? {})[name]
      if (typeof value === 'number' && Number.isFinite(value)) numeric += 1
    }
    return numeric / features.length
  }

  if (override) {
    if (!observed.has(override)) {
      throw new ValueFieldError(
        `Override field "${override}" is not present on the returned features.`,
        observedProperties,
        [override],
      )
    }
    const coverage = coverageOf(override)
    if (coverage < minCoverage) {
      throw new ValueFieldError(
        `Override field "${override}" is numeric on only ${(coverage * 100).toFixed(1)}% of features (minimum ${(minCoverage * 100).toFixed(0)}%).`,
        observedProperties,
        [override],
      )
    }
    return {
      field: override,
      coverage,
      resolvedBy: 'override',
      candidatesConsidered: [override],
      observedProperties,
    }
  }

  const whitelist: readonly string[] =
    analyticType === 'tcm' ? TCM_FIELD_WHITELIST : HOUR_FIELD_WHITELIST

  const qualified = whitelist
    .map((name) => ({ name, coverage: observed.has(name) ? coverageOf(name) : 0 }))
    .filter((entry) => entry.coverage >= minCoverage)

  if (qualified.length === 0) {
    throw new ValueFieldError(
      `No whitelisted ${analyticType} value field found. Whitelist: ${whitelist.join(', ')}. ` +
        `Properties actually returned: ${observedProperties.join(', ') || '(none)'}. ` +
        'Run the capability probe and pass the confirmed field name as an override.',
      observedProperties,
      [...whitelist],
    )
  }

  if (qualified.length > 1) {
    throw new ValueFieldError(
      `Ambiguous ${analyticType} value field: ${qualified.map((entry) => entry.name).join(', ')} ` +
        'all qualify. Refusing to guess — pass the confirmed field name as an override.',
      observedProperties,
      qualified.map((entry) => entry.name),
    )
  }

  const winner = qualified[0]!
  return {
    field: winner.name,
    coverage: winner.coverage,
    resolvedBy: 'whitelist',
    candidatesConsidered: [...whitelist],
    observedProperties,
  }
}

/**
 * The unit for an analytic type, as documented on docs-api.fortyguard.com.
 * Returns `null` when the analytic type is unknown — never a guessed unit.
 */
export function documentedUnitFor(analyticType: string): string | null {
  switch (analyticType) {
    case 'tcm':
      return '°C'
    case 'time_of_measure':
    case 'exceedance':
    case 'persistence':
      return 'hour'
    default:
      return null
  }
}
