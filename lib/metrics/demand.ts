/**
 * How a published *daily* ridership average becomes an *hourly* one.
 *
 * This is the single least-observed step in metric A, so it is isolated here,
 * given three materially different shapes, and put in the scenario envelope
 * rather than being buried as a default.
 *
 * ## The rule
 *
 *   riders(h) = R · w(h),   with   Σ_{h=0..23} w(h) = 1
 *
 * `R` is the published average daily riders for the stop, day category and
 * fiscal quarter. `w` is a **probability distribution over the 24 clock hours**,
 * which guarantees the identity
 *
 *   Σ_{h=0..23} riders(h) = R
 *
 * exactly — enforced by construction and asserted by a regression test. No
 * profile may invent riders and none may lose them.
 *
 * ## The one hard constraint every profile obeys
 *
 * `w(h) = 0` wherever no service is scheduled in hour `h`. A rider cannot board
 * a bus that is not running, so allocating demand into a dead hour would
 * manufacture exposure out of an empty timetable. Every profile is therefore
 * normalised over **service hours only**.
 *
 * ## Why three profiles and not one
 *
 * Valley Metro publishes no hourly boarding counts, so any allocation is an
 * assumption. Offering one shape would present a guess as a fact. These three
 * disagree materially with each other — that disagreement is the honest measure
 * of how much this step is worth.
 */

export type DemandProfile =
  /** Riders follow service: w(h) ∝ scheduled departures in hour h. */
  | 'proportional_to_departures'
  /** Riders are spread evenly across every hour that has any service. */
  | 'flat_service_hours'
  /** Bimodal commute shape, renormalised onto the hours that have service. */
  | 'commute_peak'

export const DEMAND_PROFILES: readonly DemandProfile[] = [
  'proportional_to_departures',
  'flat_service_hours',
  'commute_peak',
] as const

export const DEMAND_PROFILE_LABEL: Record<DemandProfile, string> = {
  proportional_to_departures: 'Demand follows service frequency',
  flat_service_hours: 'Demand flat across service hours',
  commute_peak: 'Demand concentrated in commute peaks',
}

/**
 * Relative commute weight by clock hour, before renormalisation.
 *
 * A conventional two-peak urban shape: a sharp morning peak, a midday floor
 * that is far from zero because this is an all-day network, and a broader,
 * slightly higher afternoon peak. The numbers are a *stated shape*, not a
 * measurement, which is exactly why this profile is a scenario.
 */
const COMMUTE_SHAPE: readonly number[] = [
  0.1, 0.1, 0.1, 0.1, 0.2, 0.6, // 00–05
  1.6, 2.6, 2.2, 1.3, 1.0, 1.0, // 06–11
  1.1, 1.1, 1.2, 1.6, 2.4, 2.6, // 12–17
  1.9, 1.2, 0.8, 0.5, 0.3, 0.2, // 18–23
]

export interface Allocation {
  /** 24 values. Sums to the published daily total. */
  ridersByHour: number[]
  /** 24 weights summing to 1 (or all zero when the stop has no service). */
  weights: number[]
  serviceHours: number[]
  profile: DemandProfile
}

/**
 * Allocate a daily total across the 24 clock hours.
 *
 * Returns all-zero when the stop has no scheduled service: with no service
 * there is no boarding opportunity, and inventing one would be the exact error
 * this module exists to prevent.
 */
export function allocateDailyRiders(
  dailyRiders: number,
  hourlyDepartures: readonly number[],
  profile: DemandProfile,
): Allocation {
  const weights = new Array<number>(24).fill(0)
  const serviceHours: number[] = []

  for (let hour = 0; hour < 24; hour += 1) {
    if ((hourlyDepartures[hour] ?? 0) > 0) serviceHours.push(hour)
  }

  if (serviceHours.length === 0 || !Number.isFinite(dailyRiders) || dailyRiders <= 0) {
    return { ridersByHour: new Array<number>(24).fill(0), weights, serviceHours, profile }
  }

  const raw = new Array<number>(24).fill(0)
  for (const hour of serviceHours) {
    if (profile === 'proportional_to_departures') raw[hour] = hourlyDepartures[hour] ?? 0
    else if (profile === 'flat_service_hours') raw[hour] = 1
    else raw[hour] = COMMUTE_SHAPE[hour] ?? 0
  }

  let total = raw.reduce((sum, value) => sum + value, 0)
  if (total <= 0) {
    // A commute shape can in principle be zero on every hour a stop happens to
    // run. Fall back to flat rather than dropping the stop's riders entirely.
    for (const hour of serviceHours) raw[hour] = 1
    total = serviceHours.length
  }

  for (let hour = 0; hour < 24; hour += 1) weights[hour] = raw[hour]! / total

  // Distribute the total, then repair the last service hour with the exact
  // residual so the sum identity holds to the last representable bit rather
  // than to within accumulated rounding error.
  const ridersByHour = weights.map((weight) => dailyRiders * weight)
  const lastServiceHour = serviceHours[serviceHours.length - 1]!
  const allocated = ridersByHour.reduce((sum, value) => sum + value, 0)
  ridersByHour[lastServiceHour] = ridersByHour[lastServiceHour]! + (dailyRiders - allocated)

  return { ridersByHour, weights, serviceHours, profile }
}
