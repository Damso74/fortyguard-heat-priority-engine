import { z } from 'zod'
import { AREAS_OF_INTEREST, DEFAULT_AOI_ID } from '@/lib/geo/aoi'

/**
 * Request validation and the project's timezone position.
 *
 * FortyGuard documents `start_time` as "HH:MM in 24-hour format" and never says
 * which timezone it is interpreted in. The one adjacent clue is that
 * `time_of_measure` returns "the hour of day (0-23, UTC)". That is evidence, not
 * a contract, so this project:
 *
 * - works in `America/Phoenix` (UTC−7, no daylight saving) for everything the
 *   user sees and picks;
 * - sends the chosen wall-clock time unchanged;
 * - records the assumption on every run and in every export;
 * - has the capability probe test the question directly by submitting the same
 *   local hour and checking whether the returned pattern matches midday or
 *   early-morning conditions.
 *
 * The spike used `date.today() - 1 day` from the machine's local clock, which is
 * wrong on any machine outside Arizona. Dates are now computed in Phoenix time.
 */

export const ANALYSIS_TIMEZONE = 'America/Phoenix'
/** Phoenix is UTC−7 year round; Arizona does not observe daylight saving. */
export const ANALYSIS_UTC_OFFSET_HOURS = -7

export const TIMEZONE_ASSUMPTION =
  'Snapshot times are chosen and displayed in America/Phoenix (UTC-7, no daylight saving) and sent to the API unchanged. FortyGuard does not document which timezone start_time is interpreted in; the capability probe tests this and the answer is recorded in docs/fortyguard-capability-report.md.'

/**
 * Earliest date this project will request.
 *
 * The API documentation says 2019-01-01; the hackathon FAQ says 1 January 2021.
 * The sources contradict each other, so the stricter bound is used.
 */
export const EARLIEST_ANALYSIS_DATE = '2021-01-01'

export const CAPACITY_OPTIONS = [10, 20, 50, 80] as const

export const DEFAULT_SNAPSHOT_TIMES = ['11:00', '14:00', '17:00'] as const

/**
 * The day type a calendar date actually falls on.
 *
 * `analysisDate` is a calendar date; a timetable belongs to a day type. Nothing
 * previously connected the two, so a request could analyse Saturday's service on
 * a Monday and report it as "Saturday" without qualification.
 *
 * Parsed as a plain civil date — `Date.UTC` on the components — rather than
 * through `new Date(string)`, whose local-timezone interpretation would shift
 * the weekday for anyone west of UTC.
 */
export function dayTypeForDate(analysisDate: string): 'weekday' | 'saturday' | 'sunday' {
  const [year, month, day] = analysisDate.split('-').map(Number)
  const weekday = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay()
  if (weekday === 6) return 'saturday'
  if (weekday === 0) return 'sunday'
  return 'weekday'
}

/**
 * The civil date before this one. Plain date arithmetic, no local timezone.
 *
 * `new Date(string)` would interpret the date in the host's zone and shift the
 * answer for anyone west of UTC, which is how a project analysing Phoenix ends
 * up computing yesterday from a laptop in Lisbon.
 */
export function previousCivilDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const instant = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1) - 86_400_000
  return new Date(instant).toISOString().slice(0, 10)
}

/**
 * The day type that actually ran the night before this **date**.
 *
 * The small hours of a civil date are served by the *previous* service day's
 * post-midnight trips, and that previous day is frequently a different day type:
 * 01:10 on a Saturday is served by Friday's weekday service, 01:10 on a Sunday by
 * Saturday's, and 01:10 on a Monday by Sunday's.
 *
 * Derived from the date rather than from the day type, which is the difference
 * that matters. `precedingDayType('weekday')` cannot distinguish Monday — served
 * by Sunday's thin timetable — from Wednesday, served by Tuesday's full one, so
 * it has to answer conservatively for both. Given a real date there is no
 * ambiguity to be conservative about.
 */
export function precedingDayTypeForDate(analysisDate: string): 'weekday' | 'saturday' | 'sunday' {
  return dayTypeForDate(previousCivilDate(analysisDate))
}

/** Current date in Phoenix, independent of the host machine's timezone. */
export function phoenixDate(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + ANALYSIS_UTC_OFFSET_HOURS * 3_600_000)
  return shifted.toISOString().slice(0, 10)
}

/** Yesterday in Phoenix — the newest date guaranteed to be fully historical. */
export function defaultAnalysisDate(now: Date = new Date()): string {
  return phoenixDate(new Date(now.getTime() - 86_400_000))
}

/**
 * Snapshot times are **whole clock hours, each appearing once**.
 *
 * Both constraints are structural, not cosmetic:
 *
 * - The engine keys temperature by clock hour (`hourOf(snapshot)`) and pairs it
 *   with an expected wait computed over `[h:00, h+1:00)`. A snapshot at `14:30`
 *   would be silently filed under hour 14 and multiplied by hour 14's wait, so
 *   the request would be answered with a question nobody asked. Minutes are
 *   rejected rather than truncated.
 * - Two snapshots in the same hour collapse onto the same key: the second
 *   overwrites the first in `temperatureByHour`, while both still count towards
 *   the anomaly validation's snapshot list and towards the number of heatmap
 *   requests a live run would pay for. Duplicates are rejected rather than
 *   deduplicated silently, because the caller asked for something the engine
 *   cannot deliver and should be told so.
 */
const SnapshotTimesSchema = z
  .array(
    z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'snapshot times must be HH:MM')
      .refine((time) => time.endsWith(':00'), {
        message:
          'snapshot times must be whole hours (HH:00). Temperature is joined to an expected ' +
          'wait computed over a whole clock hour, so a minute value cannot be honoured.',
      }),
  )
  .min(1)
  .max(6)
  .refine(
    (times) => new Set(times.map((time) => time.slice(0, 2))).size === times.length,
    {
      message:
        'snapshot times must be distinct hours. Two snapshots in the same hour resolve to one ' +
        'temperature, so the second would be discarded after being paid for.',
    },
  )

export const RunRequestSchema = z.object({
  aoiId: z
    .string()
    .refine((id) => AREAS_OF_INTEREST.some((area) => area.id === id), {
      message: `aoiId must be one of: ${AREAS_OF_INTEREST.map((a) => a.id).join(', ')}`,
    })
    .default(DEFAULT_AOI_ID),
  capacity: z.coerce.number().int().min(1).max(500).default(50),
  // No weights, and no scenario. The product takes an analytical position:
  // exposure and anomaly are reported on separate axes and selection is
  // weight-free. See docs/scoring-methodology.md.
  //
  // `dayType`, not `dayCategory`: the timetable analysed is the timetable of the
  // day being analysed. Saturday and Sunday are separate because the feed runs
  // 5,476 and 4,815 trips on them respectively.
  /**
   * Optional. Defaults to the day type `analysisDate` actually falls on.
   *
   * Supplying one that disagrees with the date is allowed — "what would Saturday
   * service look like on this hot Monday?" is a reasonable question — but it is
   * a counterfactual, and the run labels it as one. Silently pairing Saturday's
   * timetable with a Monday's temperatures and calling the result "Saturday" was
   * the ambiguity this field now resolves.
   */
  dayType: z.enum(['weekday', 'saturday', 'sunday']).optional(),
  analysisDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'analysisDate must be YYYY-MM-DD')
    .default(() => defaultAnalysisDate()),
  snapshotTimes: SnapshotTimesSchema.default([...DEFAULT_SNAPSHOT_TIMES]),
  excludedIds: z.array(z.string().max(64)).max(500).default([]),
  includedIds: z.array(z.string().max(64)).max(500).default([]),
})

export type ParsedRunRequest = z.infer<typeof RunRequestSchema>

export interface DateWindowIssue {
  code: 'TOO_EARLY' | 'TOO_FAR_AHEAD'
  message: string
}

/**
 * Check the requested date against the documented acceptance window.
 * Returns an issue rather than throwing so the UI can explain it inline.
 */
export function checkAnalysisWindow(
  analysisDate: string,
  snapshotTimes: readonly string[],
  now: Date = new Date(),
): DateWindowIssue | null {
  if (analysisDate < EARLIEST_ANALYSIS_DATE) {
    return {
      code: 'TOO_EARLY',
      message: `FortyGuard rejects dates before ${EARLIEST_ANALYSIS_DATE} (the stricter of two contradictory published bounds).`,
    }
  }

  const latestAccepted = now.getTime() + 12 * 3_600_000
  for (const time of snapshotTimes) {
    const parts = time.split(':')
    const hours = Number(parts[0] ?? '0')
    const minutes = Number(parts[1] ?? '0')
    // Interpret the requested wall-clock time in Phoenix, then compare in UTC.
    const asUtc = Date.parse(`${analysisDate}T${time}:00Z`)
    if (!Number.isFinite(asUtc)) continue
    const instant = asUtc - ANALYSIS_UTC_OFFSET_HOURS * 3_600_000
    void hours
    void minutes
    if (instant > latestAccepted) {
      return {
        code: 'TOO_FAR_AHEAD',
        message: `Snapshot ${analysisDate} ${time} is more than 12 hours ahead of now; the heatmap endpoint rejects it.`,
      }
    }
  }
  return null
}
