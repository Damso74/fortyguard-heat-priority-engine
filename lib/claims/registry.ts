/**
 * The claim registry is the single place that decides what this product is
 * allowed to say. Copy shown in the UI is looked up here rather than written
 * inline, so a blocked claim cannot reach a screen by accident.
 *
 * See docs/limitations-and-claims.md for the prose version of this table.
 */

export type ClaimTier = 'allowed' | 'conditional' | 'blocked'

export interface ClaimDefinition {
  id: string
  tier: ClaimTier
  /** Wording the product may use verbatim when the claim is permitted. */
  statement: string
  /** What must be true for a conditional claim to become allowed. */
  requires?: string
  /** Why a blocked claim is blocked. */
  because?: string
}

export const CLAIMS: readonly ClaimDefinition[] = [
  /* ---------------------------------------------------------------- allowed */
  {
    id: 'stop_count',
    tier: 'allowed',
    statement:
      'The number of active Phoenix transit stops read from the Valley Metro authoritative layer.',
  },
  {
    id: 'join_rate',
    tier: 'allowed',
    statement:
      'The share of Phoenix stop records matched by exact stop_id between the two official layers.',
  },
  {
    id: 'two_metrics_reported_separately',
    tier: 'allowed',
    statement:
      'Two metrics computed deterministically and reported on separate axes, never blended into ' +
      'a score.',
  },
  {
    id: 'robustness_split',
    tier: 'allowed',
    statement:
      'How many selections hold under every stated assumption, and how many do not, with each ' +
      'candidate’s selection frequency and rank range.',
  },
  {
    id: 'data_mode',
    tier: 'allowed',
    statement: 'Whether the thermal layer is live, cached-real, or explicitly synthetic.',
  },
  {
    id: 'fortyguard_returned_values',
    tier: 'allowed',
    statement: 'The values FortyGuard actually returned, with the field name they came from.',
  },
  {
    id: 'selection_capacity',
    tier: 'allowed',
    statement:
      'The number of locations selected, described as a selection or inspection capacity.',
  },
  {
    id: 'provenance',
    tier: 'allowed',
    statement: 'The source, download date and SHA-256 of every dataset used.',
  },
  {
    id: 'raw_layer_redistribution_permitted',
    tier: 'allowed',
    statement:
      'The two raw ArcGIS extracts whose redistribution terms are unresolved are excluded from ' +
      'the tracked repository; every ArcGIS raw extract still published here has an exact-item grant.',
  },
  {
    id: 'heat_ridership_overlap',
    tier: 'allowed',
    statement:
      'Where published ridership and the thermal layer overlap within the analysed area.',
  },
  {
    id: 'quarter_completeness',
    tier: 'allowed',
    statement:
      'Which published ridership quarters pass this project’s own completeness checks, and that ' +
      'those checks are not independently reconciled.',
  },
  {
    id: 'named_self_attestation',
    tier: 'allowed',
    statement:
      'That a named person attested to having reviewed a specific run id. This product has no ' +
      'authentication, so the name is unverified and this is not an approval.',
  },

  /* ------------------------------------------------------------ conditional */
  {
    id: 'ridership_unit',
    tier: 'conditional',
    statement: 'The unit of the published ridership figure.',
    requires:
      'A statement from the City of Phoenix documenting the unit, period and collection date of RIDERSHIP.',
  },
  {
    id: 'ridership_daily',
    tier: 'conditional',
    statement: 'That the ridership figure represents daily boardings.',
    requires: 'The same documentation as ridership_unit, explicitly stating a daily period.',
  },
  {
    id: 'thermal_unit_celsius',
    tier: 'conditional',
    statement: 'That the thermal value is a temperature in degrees Celsius.',
    requires:
      'A capability probe confirming THREE separate things: which property carries the value, ' +
      'that the property holds a temperature at all, and that its unit is literally °C. A ' +
      'documented analytic unit says nothing about which property the response returned; knowing ' +
      'which property to read says nothing about what it measures; and a `--temperature-field` ' +
      'flag selects a property rather than confirming any of it.',
  },
  {
    id: 'thermal_precision',
    tier: 'conditional',
    statement: 'That the thermal value is accurate to a stated tolerance.',
    requires:
      'A completed FortyGuard capability probe confirming the value field, its unit and its ' +
      'stated accuracy.',
  },
  {
    id: 'anomaly_persists',
    tier: 'conditional',
    statement: 'That a location is anomalously hot for its surroundings across the afternoon.',
    requires:
      'At least two held-out snapshots agreeing with the fit, on a real capture. Two readings ' +
      'agreeing once is what a slow-moving surface produces regardless of whether the anomaly is ' +
      'a real feature of the ground.',
  },
  {
    id: 'intervention_effect',
    tier: 'conditional',
    statement: 'That a specific intervention changes conditions at a location.',
    requires:
      'A before/after measurement design with a control, at a spatial scale the sensor can resolve.',
  },
  {
    id: 'population_coverage',
    tier: 'conditional',
    statement: 'The number of people who pass through a selected location.',
    requires: 'A ridership dataset with a documented unit, period and coverage.',
  },

  /* ---------------------------------------------------------------- blocked */
  {
    id: 'people_protected',
    tier: 'blocked',
    statement: 'That N people are protected by the plan.',
    because:
      'No counterfactual exists, and the ridership unit is undocumented. This is two unfounded claims stacked.',
  },
  {
    id: 'temperature_reduced',
    tier: 'blocked',
    statement: 'That the plan reduces temperature by N degrees.',
    because:
      'The finest documented API granularity is 60 m, far larger than a bus shelter. A neighbourhood grid cannot attribute cooling to a shelter-scale object.',
  },
  {
    id: 'dollars_saved',
    tier: 'blocked',
    statement: 'That the plan saves or costs N dollars.',
    because: 'No costing dataset is present. No dollar figure is generated anywhere in this product.',
  },
  {
    id: 'stop_is_unsheltered',
    tier: 'blocked',
    statement: 'That a stop has no shelter, inferred from an empty or zero amenity field.',
    because:
      'Phoenix publishes 3164 sheltered stops for FY2024-25 while the amenity fields carry 20 non-null values. The fields are incomplete, not negative.',
  },
  {
    id: 'official_endorsement',
    tier: 'blocked',
    statement: 'That this plan is endorsed by, or compliant with, the City of Phoenix or Valley Metro.',
    because: 'This is an independent hackathon project built on their public open data.',
  },
  {
    id: 'causal_impact',
    tier: 'blocked',
    statement: 'That acting on this ranking causes a measured outcome.',
    because: 'No causal design, no control group, no outcome measurement exists in this product.',
  },
  {
    id: 'vulnerability_score',
    tier: 'blocked',
    statement: 'That a location scores high or low on social vulnerability.',
    because: 'No sourced social dataset is loaded. The scoring engine has no such factor.',
  },
  {
    id: 'feasibility_score',
    tier: 'blocked',
    statement: 'That a location is easy or hard to build at.',
    because: 'No right-of-way, utility or construction dataset is loaded.',
  },
] as const

const BY_ID = new Map(CLAIMS.map((claim) => [claim.id, claim]))

export function claim(id: string): ClaimDefinition {
  const found = BY_ID.get(id)
  if (!found) throw new Error(`Unknown claim id: ${id}`)
  return found
}

export function claimsByTier(tier: ClaimTier): ClaimDefinition[] {
  return CLAIMS.filter((entry) => entry.tier === tier)
}

/**
 * Claim ids a run may assert, given its gate outcomes. Everything else is
 * reported as blocked in the run manifest.
 */
export function resolveAllowedClaims(input: {
  hasRealThermalSignal: boolean
  hasShelterInventory: boolean
  ridershipUnitDocumented: boolean
  /** Probe confirmed the value field AND a literal Celsius unit. */
  celsiusConfirmed?: boolean
  /** Enough held-out snapshots to validate the anomaly out of sample. */
  sufficientHoldouts?: boolean
}): { allowed: string[]; blocked: string[] } {
  const allowed = new Set<string>(claimsByTier('allowed').map((entry) => entry.id))
  const blocked = new Set<string>(claimsByTier('blocked').map((entry) => entry.id))

  if (!input.hasRealThermalSignal) {
    // A synthetic layer may not be described as a FortyGuard measurement.
    allowed.delete('fortyguard_returned_values')
    blocked.add('fortyguard_returned_values')
  }
  if (input.celsiusConfirmed) allowed.add('thermal_unit_celsius')
  else blocked.add('thermal_unit_celsius')
  if (input.sufficientHoldouts && input.hasRealThermalSignal) allowed.add('anomaly_persists')
  else blocked.add('anomaly_persists')
  if (!input.hasShelterInventory) {
    blocked.add('stop_is_unsheltered')
  }
  if (input.ridershipUnitDocumented) {
    allowed.add('ridership_unit')
  } else {
    blocked.add('ridership_daily')
  }
  return { allowed: [...allowed].sort(), blocked: [...blocked].sort() }
}
