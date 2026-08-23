import { createHash } from 'node:crypto'
import { z } from 'zod'
import capabilityJson from '@/data/manifests/fortyguard-capability.json'
import { TIMEZONE_STRATEGIES, type TimezoneStrategy } from './timezone'

/**
 * The capability probe's answers, validated at runtime.
 *
 * Four facts about the FortyGuard API are undocumented or contradictory, and each
 * one silently corrupts the product if guessed:
 *
 * - **which property carries the temperature.** No source publishes the name.
 * - **what that property means.** A named property could be an air temperature, a
 *   surface temperature, an index or a model output.
 * - **whether the value is Celsius.** The documented unit for `tcm` is °C, but
 *   that documents the *analytic*, not whatever field the response returned.
 * - **which timezone `start_time` is interpreted in.** The endpoint documents
 *   "HH:MM in 24-hour format" and never says. A seven-hour error would move every
 *   temperature to a different part of the day.
 *
 * ## Four answers, four flags
 *
 * They are tracked separately because they are separately answerable and
 * separately fatal. `--temperature-field tcm` selects a **property**; it does not
 * establish that the property is a temperature, and it says nothing about the
 * unit. Collapsing any two of these into one flag is how a product ends up
 * printing `°C` next to a number nobody has identified.
 *
 * ## Why this is parsed rather than cast
 *
 * The file is hand-edited after a human reads probe output. A typo in it used to
 * become a silent `undefined` flowing into a gate, and the most dangerous typo —
 * `"confirmed": "false"`, a string, which is truthy — would have unblocked the
 * Celsius reading. It is now parsed by a **strict** schema: unknown keys are
 * rejected (so a misspelt `confrimed` cannot leave the real flag at its default),
 * booleans must be booleans, a confirmation requires its corroborating fields, and
 * the confirmed unit must be **literally** `°C`.
 *
 * A malformed manifest throws on load. That is deliberate: the failure mode of
 * continuing is a product that quietly claims degrees it cannot support.
 *
 * ## The fingerprint
 *
 * Every answer above, plus the endpoint identity and the manifest version, hashes
 * to a `capabilityFingerprint`. Each real snapshot records the fingerprint that
 * was in force when it was captured, and a snapshot whose fingerprint differs from
 * the current one is refused rather than reinterpreted. Editing the manifest to
 * say "confirmed" does not retroactively make an old capture's numbers Celsius.
 */

/** The exact string a confirmed Celsius unit must be. Nothing else counts. */
export const LITERAL_CELSIUS = '°C'

export { TIMEZONE_STRATEGIES }
export type { TimezoneStrategy }

const ConfirmableString = z
  .object({
    confirmed: z.boolean(),
    evidence: z.string().min(1),
  })
  .strict()

const EndpointSchema = z
  .object({
    host: z.string().min(1),
    submitPath: z.string().min(1),
    statusPath: z.string().min(1),
    analyticType: z.string().min(1),
    openApiSha256: z.string().regex(/^[0-9a-f]{64}$/, 'openApiSha256 must be a sha256 hex digest'),
  })
  .strict()

const CapabilitySchema = z
  .object({
    _comment: z.string().optional(),
    capabilityVersion: z.number().int().positive(),
    probeRunId: z.string().min(1).nullable(),
    probedAtUtc: z.string().min(1).nullable(),
    probeToolVersion: z.string().min(1),
    endpoint: EndpointSchema,
    valueField: ConfirmableString.extend({ name: z.string().min(1).nullable() }).strict(),
    unit: ConfirmableString.extend({ unit: z.string().min(1).nullable() }).strict(),
    /**
     * What the named property actually is.
     *
     * Independent of `valueField` (which property to read) and of `unit` (what
     * scale it is on). A field can be located and its unit read off a response
     * header while remaining an index rather than a temperature.
     */
    semantics: ConfirmableString.extend({ meaning: z.string().min(1).nullable() }).strict(),
    timezone: ConfirmableString.extend({
      strategy: z.enum(TIMEZONE_STRATEGIES),
      interpretedAs: z.string().min(1).nullable(),
      /**
       * Whether the confirmed strategy is the one the client actually applies.
       *
       * Confirming that `start_time` is read as UTC is useless on its own: the
       * product would still be sending Phoenix wall-clock. A confirmation is only
       * load-bearing once the code acts on it, which is why the capture records
       * the transmitted timestamps alongside the requested local ones.
       */
      applied: z.boolean(),
    }).strict(),
  })
  .strict()
  // A confirmation with nothing behind it is a claim, not evidence.
  .refine((value) => !value.valueField.confirmed || value.valueField.name !== null, {
    message: 'valueField.confirmed is true but no field name is recorded.',
    path: ['valueField', 'name'],
  })
  .refine((value) => !value.unit.confirmed || value.unit.unit === LITERAL_CELSIUS, {
    message: `unit.confirmed is true but the unit is not literally "${LITERAL_CELSIUS}".`,
    path: ['unit', 'unit'],
  })
  .refine((value) => !value.semantics.confirmed || value.semantics.meaning !== null, {
    message: 'semantics.confirmed is true but no meaning is recorded.',
    path: ['semantics', 'meaning'],
  })
  // Naming a field is a prerequisite for saying what it means or what unit it is
  // on; the reverse order is a claim about a property nobody has identified.
  .refine((value) => !value.unit.confirmed || value.valueField.confirmed, {
    message: 'unit.confirmed is true but the value field it belongs to is unconfirmed.',
    path: ['unit', 'confirmed'],
  })
  .refine((value) => !value.semantics.confirmed || value.valueField.confirmed, {
    message: 'semantics.confirmed is true but the value field it describes is unconfirmed.',
    path: ['semantics', 'confirmed'],
  })
  .refine((value) => !value.timezone.confirmed || value.timezone.interpretedAs !== null, {
    message: 'timezone.confirmed is true but no interpretation is recorded.',
    path: ['timezone', 'interpretedAs'],
  })
  .refine((value) => !value.timezone.applied || value.timezone.confirmed, {
    message: 'timezone.applied is true but the timezone was never confirmed.',
    path: ['timezone', 'applied'],
  })
  .refine(
    (value) =>
      (!value.valueField.confirmed &&
        !value.unit.confirmed &&
        !value.semantics.confirmed &&
        !value.timezone.confirmed) ||
      value.probeRunId !== null,
    {
      message: 'A confirmation is recorded but no probeRunId identifies the run.',
      path: ['probeRunId'],
    },
  )

export type CapabilityConfirmation = z.infer<typeof CapabilitySchema>

let cached: CapabilityConfirmation | null = null

export function parseCapability(value: unknown): CapabilityConfirmation {
  const parsed = CapabilitySchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(
      'The FortyGuard capability manifest is invalid: ' +
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ') +
        '. The product will not run on a capability manifest it cannot parse, because the ' +
        'failure mode of continuing is claiming degrees it cannot support.',
    )
  }
  return parsed.data
}

export function loadCapability(): CapabilityConfirmation {
  if (cached) return cached
  cached = parseCapability(capabilityJson)
  return cached
}

/** Test seam. */
export function resetCapabilityCache(): void {
  cached = null
}

/**
 * The identity a snapshot is bound to.
 *
 * Covers every answer that changes how a stored number must be read, plus the
 * endpoint and manifest version that produced those answers. Evidence excerpts
 * are deliberately excluded: rewording the prose behind a confirmation does not
 * change what the confirmation permits, and invalidating every capture over a
 * typo in a comment would train people to edit the fingerprint out.
 */
export function capabilityFingerprint(
  capability: CapabilityConfirmation = loadCapability(),
): string {
  const payload = {
    capabilityVersion: capability.capabilityVersion,
    probeRunId: capability.probeRunId,
    probeToolVersion: capability.probeToolVersion,
    endpoint: {
      host: capability.endpoint.host,
      submitPath: capability.endpoint.submitPath,
      statusPath: capability.endpoint.statusPath,
      analyticType: capability.endpoint.analyticType,
      openApiSha256: capability.endpoint.openApiSha256,
    },
    valueField: { confirmed: capability.valueField.confirmed, name: capability.valueField.name },
    unit: { confirmed: capability.unit.confirmed, unit: capability.unit.unit },
    semantics: {
      confirmed: capability.semantics.confirmed,
      meaning: capability.semantics.meaning,
    },
    timezone: {
      confirmed: capability.timezone.confirmed,
      strategy: capability.timezone.strategy,
      interpretedAs: capability.timezone.interpretedAs,
      applied: capability.timezone.applied,
    },
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export interface CapabilityGate {
  /** May metric A be expressed in degrees Celsius? */
  celsiusPermitted: boolean
  /**
   * Is the number known to be a heat reading at all?
   *
   * Separate from `celsiusPermitted` because the anomaly is a **scale-free**
   * statistic: a robust z-score is unchanged by the unit, so it does not need one.
   * What it does need is for the field to be identified and its meaning
   * confirmed — otherwise the product computes a perfectly valid z-score over an
   * arbitrary numeric property and calls the result a *local heat anomaly*.
   * Scale-invariance is not evidence that the data is heat.
   */
  heatFieldIdentified: boolean
  /** May a run claim the full two-axis product on real data? */
  realProductPermitted: boolean
  missing: string[]
  statement: string
}

/**
 * What the manifest permits.
 *
 * Four independent requirements, all of which must hold before a **real** ESEL is
 * expressed in °C or an A+B product is claimed on real data:
 *
 * 1. the value field is confirmed and named — otherwise the product does not know
 *    which number it read;
 * 2. that field is confirmed to *be* a temperature — otherwise it does not know
 *    what the number is;
 * 3. the unit is confirmed and is literally `°C` — otherwise it does not know what
 *    scale that number is on;
 * 4. the timezone is confirmed **and applied** — otherwise the temperatures may
 *    belong to a different part of the day than the waits they multiply.
 *
 * Each is separately sufficient to make `max(0, T − 30 °C)` meaningless.
 */
export function evaluateCapability(
  capability: CapabilityConfirmation = loadCapability(),
): CapabilityGate {
  const missing: string[] = []
  if (!capability.valueField.confirmed) missing.push('the temperature value field')
  if (!capability.semantics.confirmed) missing.push('that the field holds a temperature at all')
  if (!capability.unit.confirmed) missing.push(`the unit as literal ${LITERAL_CELSIUS}`)
  if (!capability.timezone.confirmed) missing.push('the timezone of start_time')
  else if (!capability.timezone.applied) {
    missing.push('a timezone strategy actually applied by the client')
  }

  const heatFieldIdentified = capability.valueField.confirmed && capability.semantics.confirmed
  const celsiusPermitted = heatFieldIdentified && capability.unit.confirmed
  const realProductPermitted = missing.length === 0

  const statement = realProductPermitted
    ? `Capability probe ${capability.probeRunId} confirmed the value field ` +
      `"${capability.valueField.name}" (${capability.semantics.meaning}), unit ` +
      `${capability.unit.unit}, and that start_time is interpreted as ` +
      `${capability.timezone.interpretedAs} under the ${capability.timezone.strategy} strategy, ` +
      'which the client applies and records on every capture. Metric A may be read in °C on real ' +
      'data.'
    : `The capability probe has not confirmed ${missing.join(', ')}. Metric A is therefore NOT ` +
      'expressed in °C on real data: the reference temperature and the excess above it are ' +
      'reported in the unconfirmed units the API returned, the thermal gate uses scale-free ' +
      'relative thresholds, and the two-axis product is not claimed on a real capture.'

  return { celsiusPermitted, heatFieldIdentified, realProductPermitted, missing, statement }
}

/** Convenience wrappers used at call sites that only need one answer. */
export function celsiusReadingPermitted(
  capability: CapabilityConfirmation = loadCapability(),
): boolean {
  return evaluateCapability(capability).celsiusPermitted
}

export function capabilityStatement(
  capability: CapabilityConfirmation = loadCapability(),
): string {
  return evaluateCapability(capability).statement
}
