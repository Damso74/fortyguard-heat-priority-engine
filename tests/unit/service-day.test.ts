import { describe, expect, it } from 'vitest'
import type { TransitStop } from '@/lib/types'
import {
  clockTimetableFor,
  precedingDayType,
  projectServiceDayToClock,
} from '@/lib/metrics/exposure'
import {
  dayTypeForDate,
  precedingDayTypeForDate,
  previousCivilDate,
} from '@/lib/agent/request'
import { expectedWait } from '@/lib/metrics/waiting'

/**
 * The thermal civil date and the GTFS service day are two different things.
 *
 * A departure at `24:30` is stored as minute 1470. It is on the service day that
 * began the previous morning, and it happens at 00:30 on the **next** civil date.
 * Wrapping each day type's own `24:xx` trips onto its own early hours — which is
 * what a plain modulo does — attributes Saturday-morning service to Saturday's
 * timetable when Friday ran it, and does so silently, because the wrapped
 * timetable is perfectly well-formed.
 *
 * These dates are real: 31 July 2026 is a Friday and 3 August 2026 is a Monday.
 */

/** Distinct, recognisable timetables so a misattribution is visible in the output. */
const WEEKDAY_MINUTES = [7 * 60, 8 * 60, 1440 + 20, 1440 + 50] // 07:00, 08:00, 24:20, 24:50
const SATURDAY_MINUTES = [9 * 60, 1440 + 35] // 09:00, 24:35
const SUNDAY_MINUTES = [10 * 60, 1440 + 5] // 10:00, 24:05

function stopWith(): TransitStop {
  const service = (minutes: number[]) => ({
    dailyDepartures: minutes.length,
    routeCount: 1,
    hourlyDepartures: Array.from({ length: 24 }, () => 0),
    routeDepartures: { R1: minutes },
    departuresAfterMidnight: minutes.filter((minute) => minute >= 1440).length,
  })
  return {
    id: 1,
    code: null,
    name: 'Test stop',
    description: '',
    lat: 33.45,
    lon: -112.07,
    routes: ['R1'],
    ridership: null,
    service: {
      byDayType: {
        weekday: service(WEEKDAY_MINUTES),
        saturday: service(SATURDAY_MINUTES),
        sunday: service(SUNDAY_MINUTES),
      },
    },
    legacyRidershipIndex: null,
    matchMethod: 'stop_id',
    shelterStatus: 'unknown',
  }
}

/* ========================================================================== */
/* The projection itself                                                      */
/* ========================================================================== */

describe('GTFS service-day minutes project onto clock hours in two distinct ways', () => {
  it('keeps 24:xx out of its own service day’s calendar date', () => {
    // In-day: only what happens before midnight on the analysed date.
    expect(projectServiceDayToClock(WEEKDAY_MINUTES, 'inDay')).toEqual([420, 480])
    // After midnight: what the SAME service day contributes to the NEXT date.
    expect(projectServiceDayToClock(WEEKDAY_MINUTES, 'afterMidnight')).toEqual([20, 50])
  })

  it('does not fold a 24:xx departure back into its own morning', () => {
    const inDay = projectServiceDayToClock(WEEKDAY_MINUTES, 'inDay')
    // A plain `minute % 1440` would put 24:20 at 00:20 of the same date. It is
    // 00:20 of the following one.
    expect(inDay).not.toContain(20)
    expect(inDay).not.toContain(50)
  })
})

/* ========================================================================== */
/* Midnight transitions, from the date                                        */
/* ========================================================================== */

describe('the preceding service day is read off the date', () => {
  it('knows which day each test date is', () => {
    expect(dayTypeForDate('2026-07-31')).toBe('weekday') // Friday
    expect(dayTypeForDate('2026-08-01')).toBe('saturday')
    expect(dayTypeForDate('2026-08-02')).toBe('sunday')
    expect(dayTypeForDate('2026-08-03')).toBe('weekday') // Monday
    expect(dayTypeForDate('2026-08-05')).toBe('weekday') // Wednesday
  })

  it('steps back a civil date without consulting the host timezone', () => {
    expect(previousCivilDate('2026-08-01')).toBe('2026-07-31')
    expect(previousCivilDate('2026-01-01')).toBe('2025-12-31')
    expect(previousCivilDate('2024-03-01')).toBe('2024-02-29')
  })

  it('weekday → Saturday: Saturday’s small hours are Friday’s service', () => {
    expect(precedingDayTypeForDate('2026-08-01')).toBe('weekday')
    const timetable = clockTimetableFor(stopWith(), 'saturday', precedingDayTypeForDate('2026-08-01'))!
    // Saturday's own 09:00, plus FRIDAY's 24:20 and 24:50 at 00:20 and 00:50.
    expect(timetable.R1).toEqual([20, 50, 540])
    // Saturday's own 24:35 belongs to Sunday morning, not to Saturday's.
    expect(timetable.R1).not.toContain(35)
  })

  it('Saturday → Sunday: Sunday’s small hours are Saturday’s service', () => {
    expect(precedingDayTypeForDate('2026-08-02')).toBe('saturday')
    const timetable = clockTimetableFor(stopWith(), 'sunday', precedingDayTypeForDate('2026-08-02'))!
    // Sunday's own 10:00, plus SATURDAY's 24:35 at 00:35.
    expect(timetable.R1).toEqual([35, 600])
    expect(timetable.R1).not.toContain(5)
  })

  it('Sunday → Monday: Monday’s small hours are Sunday’s thin service', () => {
    expect(precedingDayTypeForDate('2026-08-03')).toBe('sunday')
    const timetable = clockTimetableFor(stopWith(), 'weekday', precedingDayTypeForDate('2026-08-03'))!
    // Monday's own 07:00 and 08:00, plus SUNDAY's 24:05 at 00:05.
    expect(timetable.R1).toEqual([5, 420, 480])
    expect(timetable.R1).not.toContain(20)
  })

  it('distinguishes Monday from Wednesday, which the day type alone cannot', () => {
    // Both dates are `weekday`. Their preceding service days are not.
    expect(precedingDayTypeForDate('2026-08-03')).toBe('sunday') // Monday
    expect(precedingDayTypeForDate('2026-08-05')).toBe('weekday') // Wednesday

    const monday = clockTimetableFor(stopWith(), 'weekday', precedingDayTypeForDate('2026-08-03'))!
    const wednesday = clockTimetableFor(stopWith(), 'weekday', precedingDayTypeForDate('2026-08-05'))!
    expect(monday.R1).not.toEqual(wednesday.R1)
    // Sunday runs one post-midnight trip at 00:05; a weekday runs two.
    expect(monday.R1!.filter((minute) => minute < 60)).toEqual([5])
    expect(wednesday.R1!.filter((minute) => minute < 60)).toEqual([20, 50])
  })

  it('falls back to the conservative modal answer when no date applies', () => {
    // A counterfactual has no real preceding date to appeal to, so the thinnest
    // plausible service is assumed and the early-hours wait is never understated.
    expect(precedingDayType('weekday')).toBe('sunday')
    expect(precedingDayType('saturday')).toBe('weekday')
    expect(precedingDayType('sunday')).toBe('saturday')
  })
})

/* ========================================================================== */
/* What it does to a wait                                                     */
/* ========================================================================== */

describe('the transition changes the expected wait in the small hours', () => {
  it('gives a different 00:00 wait on Monday than a same-day wrap would', () => {
    const stop = stopWith()
    const correct = clockTimetableFor(stop, 'weekday', 'sunday')!
    // What the plain modulo produced: the weekday's OWN 24:20 folded back into
    // its own morning, so Monday inherits Friday-night frequency.
    const wrapped = { R1: [20, 50, 420, 480] }

    const hour = 0
    const right = expectedWait(correct, hour, 'union_timetable').waitMinutes!
    const wrong = expectedWait(wrapped, hour, 'union_timetable').waitMinutes!

    expect(right).not.toBeCloseTo(wrong, 3)
    // Sunday's single 00:05 trip leaves the rest of the hour waiting for 07:00,
    // so the honest wait is the longer one.
    expect(right).toBeGreaterThan(wrong)
  })

  it('reports no early-morning service when the preceding day ran none', () => {
    const stop = stopWith()
    stop.service!.byDayType.sunday = {
      ...stop.service!.byDayType.sunday!,
      routeDepartures: { R1: [10 * 60] },
      departuresAfterMidnight: 0,
    }
    const timetable = clockTimetableFor(stop, 'weekday', 'sunday')!
    expect(timetable.R1!.filter((minute) => minute < 60)).toEqual([])
  })
})
