/**
 * What is actually put on the wire as `start_date` / `start_time`.
 *
 * ## Why a declared strategy is not enough
 *
 * The capability manifest records a `timezoneStrategy`. Recording one is not the
 * same as applying one, and the difference is silent: a manifest that says
 * `convert_to_utc` while the client keeps sending Phoenix wall-clock produces a
 * seven-hour error in which part of the day every temperature belongs to, and
 * nothing in the response says so. The strategy therefore has to be *executed*
 * here, by one function, whose output is recorded in the snapshot attestation —
 * so a reader can check what was sent rather than what was intended.
 *
 * ## Both timestamps travel
 *
 * Every conversion returns the requested **local** wall clock and the
 * **transmitted** values together with the unambiguous UTC instant. All three go
 * into the attestation. Without the local one, a converted capture cannot be
 * traced back to the hour an analyst asked for; without the transmitted one,
 * nobody can tell whether the conversion happened.
 *
 * ## Day boundaries
 *
 * Conversion moves the civil date whenever the local hour and the offset cross
 * midnight: 19:00 on 3 August in Phoenix (UTC−7) is 02:00 on **4 August** UTC.
 * The date is recomputed from the instant, never carried over from the request.
 *
 * Offsets are resolved through the IANA database via `Intl`, not from a hardcoded
 * −7. Phoenix does not observe daylight saving, but a constant would be a fact
 * about Arizona compiled into a function whose signature promises a timezone.
 */

export const TIMEZONE_STRATEGIES = ['send_local_wallclock_unconverted', 'convert_to_utc'] as const
export type TimezoneStrategy = (typeof TIMEZONE_STRATEGIES)[number]

export class TimezoneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimezoneError'
  }
}

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTER_CACHE.get(timeZone)
  if (cached) return cached
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch (cause) {
    throw new TimezoneError(
      `"${timeZone}" is not an IANA timezone this runtime knows. ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  FORMATTER_CACHE.set(timeZone, formatter)
  return formatter
}

/** The civil fields a zone shows at a given instant. */
function civilFieldsAt(timeZone: string, instantMs: number) {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs))
  const read = (type: Intl.DateTimeFormatPartTypes) => {
    const found = parts.find((part) => part.type === type)
    if (!found) throw new TimezoneError(`Intl did not return a "${type}" part for ${timeZone}.`)
    return Number(found.value)
  }
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  }
}

/** Offset of `timeZone` at `instantMs`, in minutes east of UTC. */
export function zoneOffsetMinutes(timeZone: string, instantMs: number): number {
  const civil = civilFieldsAt(timeZone, instantMs)
  const asIfUtc = Date.UTC(
    civil.year,
    civil.month - 1,
    civil.day,
    civil.hour,
    civil.minute,
    civil.second,
  )
  return Math.round((asIfUtc - instantMs) / 60_000)
}

/**
 * The instant a local wall-clock time denotes in a zone.
 *
 * Two passes: guess the offset from the naive instant, then re-read the offset at
 * the corrected instant. A single pass is wrong within an hour of a DST
 * transition, which Phoenix never has and a zone this function accepts might.
 */
export function localWallClockToUtcMs(
  timeZone: string,
  date: string,
  time: string,
): number {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!dateMatch) throw new TimezoneError(`Date "${date}" is not YYYY-MM-DD.`)
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!timeMatch) throw new TimezoneError(`Time "${time}" is not a 24-hour HH:MM.`)

  const naive = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
  )
  const firstOffset = zoneOffsetMinutes(timeZone, naive)
  const firstGuess = naive - firstOffset * 60_000
  const secondOffset = zoneOffsetMinutes(timeZone, firstGuess)
  return secondOffset === firstOffset ? firstGuess : naive - secondOffset * 60_000
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0')

/** `YYYY-MM-DDTHH:MM:SS±HH:MM` for an instant, as seen in a zone. */
function isoWithOffset(timeZone: string, instantMs: number): string {
  const civil = civilFieldsAt(timeZone, instantMs)
  const offset = zoneOffsetMinutes(timeZone, instantMs)
  const sign = offset < 0 ? '-' : '+'
  const absolute = Math.abs(offset)
  return (
    `${pad(civil.year, 4)}-${pad(civil.month)}-${pad(civil.day)}` +
    `T${pad(civil.hour)}:${pad(civil.minute)}:${pad(civil.second)}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  )
}

export interface TransmittedTime {
  strategy: TimezoneStrategy
  /** The zone the operator picked the hour in. */
  timezone: string
  /** The civil date and wall-clock hour that was asked for. */
  requestedLocalDate: string
  requestedLocalTime: string
  /** That wall clock as an unambiguous instant, with its offset. */
  requestedLocalIso: string
  /** Exactly what goes into the request body. */
  transmittedDate: string
  transmittedTime: string
  /** The same instant in UTC, whatever the strategy. */
  transmittedIsoUtc: string
  /** True when the strategy moved the civil date. */
  crossesDayBoundary: boolean
}

/**
 * Apply a timezone strategy to one requested local hour.
 *
 * `send_local_wallclock_unconverted` transmits the wall clock verbatim — the
 * project's documented position while the interpretation is unconfirmed.
 * `convert_to_utc` recomputes both the date and the time from the instant, which
 * is the only correct way to do it: converting the time while keeping the date is
 * a bug that only shows itself either side of midnight.
 */
export function applyTimezoneStrategy(input: {
  strategy: TimezoneStrategy
  timezone: string
  analysisDate: string
  localTime: string
}): TransmittedTime {
  const { strategy, timezone, analysisDate, localTime } = input
  const instant = localWallClockToUtcMs(timezone, analysisDate, localTime)
  const requestedLocalIso = isoWithOffset(timezone, instant)
  const utc = new Date(instant)
  const utcDate = utc.toISOString().slice(0, 10)
  const utcTime = utc.toISOString().slice(11, 16)

  const transmittedDate = strategy === 'convert_to_utc' ? utcDate : analysisDate
  const transmittedTime = strategy === 'convert_to_utc' ? utcTime : localTime

  return {
    strategy,
    timezone,
    requestedLocalDate: analysisDate,
    requestedLocalTime: localTime,
    requestedLocalIso,
    transmittedDate,
    transmittedTime,
    transmittedIsoUtc: utc.toISOString(),
    crossesDayBoundary: transmittedDate !== analysisDate,
  }
}

/** The whole plan for one capture, in submission order. */
export function planTransmittedTimes(input: {
  strategy: TimezoneStrategy
  timezone: string
  analysisDate: string
  localTimes: readonly string[]
}): TransmittedTime[] {
  return input.localTimes.map((localTime) =>
    applyTimezoneStrategy({
      strategy: input.strategy,
      timezone: input.timezone,
      analysisDate: input.analysisDate,
      localTime,
    }),
  )
}
