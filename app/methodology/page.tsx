import { CLAIMS, claimsByTier } from '@/lib/claims/registry'
import { loadDatasetManifest, loadSourceProvenance, loadStopDataset } from '@/lib/data/stops'
import { AREAS_OF_INTEREST } from '@/lib/geo/aoi'
import { planTiles } from '@/lib/geo/tiles'
import {
  BASE_SCENARIO,
  DRIFT_QUARTERS,
  REFERENCE_TEMPERATURES_C,
  enumerateScenarios,
} from '@/lib/metrics/exposure'
import { DEMAND_PROFILES, DEMAND_PROFILE_LABEL } from '@/lib/metrics/demand'
import { ROUTE_CHOICE_LABEL, ROUTE_CHOICE_MODELS, WAIT_CAP_LABEL, WAIT_CAP_SCENARIOS } from '@/lib/metrics/waiting'
import { DEFAULT_ANOMALY_PARAMETERS } from '@/lib/metrics/anomaly'
import { DEFAULT_MIN_SEPARATION_METERS } from '@/lib/metrics/selection'
import { ANALYSIS_TIMEZONE, EARLIEST_ANALYSIS_DATE, TIMEZONE_ASSUMPTION } from '@/lib/agent/request'
import { Badge } from '@/components/evidence/Badge'

export const dynamic = 'force-static'

export const metadata = { title: 'Methodology — Heat Priority Engine' }

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="hpe-card mt-4 p-5">
      <h2 className="text-base font-semibold text-ink-900">{title}</h2>
      <div className="mt-2 space-y-3 text-[13px] leading-relaxed text-ink-700">{children}</div>
    </section>
  )
}

export default function MethodologyPage() {
  const dataset = loadStopDataset()
  const manifest = loadDatasetManifest()
  const provenance = loadSourceProvenance()
  const centralPlan = planTiles(AREAS_OF_INTEREST[0]!, 9)

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-bold tracking-tight text-ink-900">Methodology</h1>
      <p className="mt-1 max-w-2xl text-[13px] text-ink-700">
        Two metrics, computed separately and never blended. Every assumption below is stated with
        what would falsify it. If a number appears in the product and is not explained here, treat
        that as a bug.
      </p>

      <Section id="thesis" title="The position this product takes">
        <p className="text-ink-900">
          <strong>
            Find where Phoenix transit riders would accumulate the greatest estimated heat exposure — and
            where FortyGuard reveals heat that is unusually severe for the surrounding area.
          </strong>
        </p>
        <p>
          Those are two different questions with two different answers, so they get two metrics on
          two axes. There is <strong>no weight slider</strong> anywhere in this product, and no
          combined score.
        </p>
        <p>
          An earlier version had one, and it was removed for a reason that needs no measurement
          to state: <strong>nothing converts degrees into riders</strong>. A weight slider asks the
          user for an exchange rate no source publishes, and normalising both quantities onto one
          0–100 scale asserts that rate silently. The diagnostic figures that accompanied the
          decision were computed on a spatial abstraction this product no longer has, so they have
          been removed rather than quoted.
        </p>
      </Section>

      <Section id="exposure" title="Metric A — Estimated scenario exposure load">
        <p className="rounded bg-ink-50 p-2 font-mono text-[12px] text-ink-900">
          ESEL(stop) = Σ<sub>h</sub> riders(h) × wait(h) × max(0, T(h) − T<sub>ref</sub>)
        </p>
        <p>
          <strong>Unit: scenario °C·rider-minutes</strong>, over the analysed hours only. Not a
          daily total and not a health outcome — a dimensioned quantity comparable between stops
          within a run.
        </p>
        <p className="rounded border border-flag-700/30 bg-flag-100/40 p-2">
          <strong>Every word of the name is load-bearing.</strong> <em>Estimated</em>: no term is
          measured at a stop. <em>Scenario</em>: the number is conditional on five settings nobody
          has observed, and changes when they change. <em>Exposure load</em>: a modelled product of
          three quantities, not a dose anyone received. The riders are a published quarterly
          average pushed through an unobserved hourly profile — <strong>nobody counted a rider at
          this stop in this hour</strong>. The wait is read off a timetable, not observed. Nothing
          here is a measurement of exposure, and the product never says it is.
        </p>

        <h3 className="pt-2 text-sm font-semibold text-ink-900">
          1 — How daily ridership becomes riders(h)
        </h3>
        <p className="rounded bg-ink-50 p-2 font-mono text-[12px] text-ink-900">
          riders(h) = R × w(h),  Σ<sub>h=0..23</sub> w(h) = 1,  w(h) = 0 where no service runs
        </p>
        <p>
          <code>R</code> is the published average daily riders for the stop, day category and fiscal
          quarter. <code>w</code> is a probability distribution over the 24 clock hours, so{' '}
          <strong>Σ riders(h) = R exactly</strong> — enforced by construction and asserted by a
          regression test. No profile invents riders and none loses them. A rider is never allocated
          to an hour with no scheduled departure.
        </p>
        <p>
          The shape of <code>w</code> is unobserved, so three materially different profiles are
          carried in the scenario envelope rather than one being presented as fact:
        </p>
        <ul className="ml-4 list-disc">
          {DEMAND_PROFILES.map((profile) => (
            <li key={profile}>
              <code>{profile}</code> — {DEMAND_PROFILE_LABEL[profile]}
            </li>
          ))}
        </ul>

        <h3 className="pt-2 text-sm font-semibold text-ink-900">2 — Waiting time</h3>
        <p className="rounded bg-ink-50 p-2 font-mono text-[12px] text-ink-900">
          wait(h) = E[ min(W, cap) ],  W = time to the next departure,  arrival uniform on hour h
        </p>
        <p>
          This is random incidence: a passenger is more likely to land inside a long gap than a
          short one, in proportion to how much of that gap falls inside the hour, and waits on
          average half of whichever part they land in. It{' '}
          <strong>reduces to headway / 2 only when every gap is equal</strong>.
        </p>
        <p>
          Three departures at :00, :05 and :10 and then nothing until the next hour give a mean
          headway of 20 minutes — which would suggest a 10-minute wait — while the formula returns
          21.25, because most arriving passengers land in the 50-minute hole. A departures-per-hour
          count cannot tell those two timetables apart at all, which is why the GTFS extraction
          keeps <strong>actual departure minutes</strong> rather than counts.
        </p>

        <h4 className="pt-1 text-[13px] font-semibold text-ink-900">
          Gaps that cross the clock-hour boundary
        </h4>
        <p>
          A gap is <strong>clipped to the analysed hour before it is weighted</strong>: only the
          part of a gap a passenger can arrive in belongs to that hour. Charging the whole gap is
          wrong in both directions, and one timetable shows it. Departures at 09:00 and 11:40 and
          nothing between form a single 160-minute gap, so the whole-gap form Σgap²/(2Σgap) returns{' '}
          <strong>80 minutes for every hour it touches</strong>:
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-ink-200 text-left text-ink-500">
                <th className="py-1 pr-2">analysed hour</th>
                <th className="py-1 pr-2">whole gap</th>
                <th className="py-1">clipped to the hour</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-ink-100">
                <td className="py-1 pr-2 font-mono">09:00–10:00</td>
                <td className="py-1 pr-2 font-mono">80</td>
                <td className="py-1 font-mono font-semibold">130</td>
              </tr>
              <tr>
                <td className="py-1 pr-2 font-mono">10:00–11:00</td>
                <td className="py-1 pr-2 font-mono">80</td>
                <td className="py-1 font-mono font-semibold">70</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          The whole-gap figure cannot be right for both hours, and is right for neither: it
          understates the hour that opens a long gap and overstates the one that closes it, which
          in a heat metric moves load to the wrong time of day. The closed form Σgap²/(2Σgap) is
          recovered exactly — and only — when the gaps happen to tile the hour.
        </p>

        <h4 className="pt-1 text-[13px] font-semibold text-ink-900">What a cap does, exactly</h4>
        <p className="rounded bg-ink-50 p-2 font-mono text-[12px] text-ink-900">
          E[ min(W, c) ] = (1 / 60) × ∫ min( W(t), c ) dt   — <em>not</em> min( E[W], c )
        </p>
        <p>
          A cap truncates <strong>each passenger&rsquo;s own wait, inside the integral, before
          averaging</strong>. It is not the expected wait computed first and then clipped. The two
          are different quantities, and <code>E[min(W,c)] ≤ min(E[W],c)</code> always.
        </p>
        <p>
          The truncation is what the modelled behaviour actually says. The cap exists because
          assumption A3 — uniform arrival — is documented to fail at long headways: a rider facing
          an 11-hour gap consults the timetable and turns up near the departure. That is a claim
          about each rider&rsquo;s own wait, so it belongs inside the integral. Capping the average
          instead would clip the summary while leaving the arrival distribution untouched, which
          describes no rider at all.
        </p>
        <p>
          One departure at 14:30, analysed hour 14:00–15:00, cap 15 min: uncapped 720.00 min,{' '}
          <strong>E[min(W,15)] = 13.13</strong>, min(E[W],15) = 15.00. The reported figure sits{' '}
          <em>below</em> the cap, because arrivals between 14:15 and 14:30 are averaged in at their
          real wait and only the later arrivals are truncated. A figure equal to the cap would be
          the signature of the wrong definition.
        </p>
        <p>
          Three consequences follow from the definition and are asserted by tests: the reported
          wait never exceeds the cap; it is non-decreasing in the cap, so{' '}
          <code>cap_5 ≤ cap_10 ≤ cap_15 ≤ uncapped</code>; and the cap is reported as applied
          exactly when it changed the answer.
        </p>

        <h3 className="pt-2 text-sm font-semibold text-ink-900">3 — Route choice, bracketed</h3>
        <p>
          Which departures a rider will board is unobserved. Interchangeable routes are handled
          through their <strong>union timetable</strong>; otherwise the envelope brackets the range:
        </p>
        <ul className="ml-4 list-disc">
          {ROUTE_CHOICE_MODELS.map((model) => (
            <li key={model}>
              <code>{model}</code> — {ROUTE_CHOICE_LABEL[model]}
            </li>
          ))}
        </ul>
        <p>
          The frequency-share weighting is <strong>unsourced</strong> — no route-level boarding
          split is published — and its identifier says so, so it can never be displayed as an
          observed weighting. In every model the route weights form a{' '}
          <strong>convex combination</strong>, so a rider waits once, not once per route.
        </p>

        <h3 className="pt-2 text-sm font-semibold text-ink-900">
          3b — Day types, and why weekend is not weekday
        </h3>
        <p>
          Three day types are extracted <strong>separately</strong> from the GTFS feed, and each is
          paired with the ridership column the source publishes for it. Weekend ridership was
          previously combined with the <em>weekday</em> timetable — an error of 30–40% in the wait
          term on exactly the days service is thinnest.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-ink-200 text-left text-ink-500">
                <th className="py-1 pr-2">day type</th>
                <th className="py-1 pr-2">timetable</th>
                <th className="py-1 pr-2">ridership column</th>
                <th className="py-1">trips in the modal pattern</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['weekday', 'weekday', 'Weekday', '7,854'],
                ['saturday', 'Saturday', 'Weekend', '5,476'],
                ['sunday', 'Sunday', 'Weekend', '4,815'],
              ].map(([type, timetable, column, trips]) => (
                <tr key={type} className="border-b border-ink-100">
                  <td className="py-1 pr-2 font-mono">{type}</td>
                  <td className="py-1 pr-2">{timetable}</td>
                  <td className="py-1 pr-2">{column}</td>
                  <td className="hpe-num py-1">{trips}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          The source splits Weekday from Weekend but not Saturday from Sunday, so the single Weekend
          average is applied to each weekend day (<strong>A8</strong>). The timetables are not
          shared — that is the part the source does let us separate.
        </p>
        <p>
          The service pattern for each day type is the <strong>most frequent</strong> set of active
          service ids across the dates of that day type, not the date with the most trips: the feed
          holds 17 distinct weekday patterns whose trip counts differ by under 1.5%, so &ldquo;the
          largest&rdquo; picks a school-plus-special outlier and calls it typical. GTFS times of
          24:00 and later are stored <strong>unwrapped</strong>; projecting them onto clock hours is
          a named assumption (<strong>A9</strong>), not a silent modulo.
        </p>

        <h3 className="pt-2 text-sm font-semibold text-ink-900">
          3c — Missing data is missing, never zero
        </h3>
        <p>
          A quarter that publishes no figure for a stop makes every scenario naming that quarter{' '}
          <strong>unavailable</strong> for it. Coercing to zero gave the stop an exposure of 0,
          ranked it last, and then reported it as assumption-sensitive to the very quarter that was
          never there. The denominator shown is the number of scenarios a candidate could actually
          be evaluated under.
        </p>
        <p>
          The same rule governs heat. The load is a sum over the analysed hours, so it is produced
          only for stops covered in <strong>every</strong> analysed hour: a partial sum is smaller
          for a reason indistinguishable from a genuinely cooler or quieter stop.
        </p>

        <h3 className="pt-2 text-sm font-semibold text-ink-900">4 — Reference temperature</h3>
        <p>
          <code>T_ref</code> defaults to <strong>{BASE_SCENARIO.referenceTemperatureC} °C because
          that is FortyGuard&rsquo;s documented API default</strong> for its{' '}
          <code>exceedance</code> and <code>persistence</code> analytics. It is an API convention,
          taken so the reference is at least sourced from the data provider.{' '}
          <strong>It is not a health or heat-stress threshold</strong>, and none should be inferred
          from it — no source used here publishes one. Swept across{' '}
          {REFERENCE_TEMPERATURES_C.join(' / ')} °C.
        </p>
        <p className="rounded border border-flag-700/30 bg-flag-100/40 p-2">
          <strong>And it is only degrees once the probe says so.</strong> This product expresses
          metric A in °C only when the capability probe has confirmed <em>both</em> the value field
          and the unit against a real API response. The shipped build has confirmed neither — no
          FortyGuard key has been issued — so the unit reads{' '}
          <em>unconfirmed thermal unit</em>. A documented analytic unit says nothing about which
          property the response returned, and knowing which property to read says nothing about
          what it measures. Neither fact alone is enough.
        </p>

        <h3 className="pt-2 text-sm font-semibold text-ink-900">
          Assumptions, and what would falsify each
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-ink-200 text-left text-ink-500">
                <th className="py-1 pr-2">id</th>
                <th className="py-1 pr-2">assumption</th>
                <th className="py-1 pr-2">in the envelope as</th>
                <th className="py-1">falsified by</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['A1', 'Daily ridership is allocated by a profile summing to 1, zero where no service runs.', 'demandProfile', 'Automatic passenger counter data by hour.'],
                ['A2', 'The published figure counts riders who wait at the stop.', '— cannot be bracketed', 'A data dictionary. If it includes alightings, exposure is an over-estimate.'],
                ['A3', 'Passengers arrive uniformly over the hour, so wait is E[W] over gaps clipped to that hour.', '—', 'Observed arrival distributions, or real-time rather than scheduled gaps.'],
                ['A4', 'Which route a rider boards is unknown; the range is bracketed.', 'routeChoice', 'Route-level boarding counts at the stop.'],
                ['A5', 'A cap truncates each rider’s own wait — E[min(W,c)], not min(E[W],c). The base applies the longest cap, 15 min.', 'waitCap', 'Observed waits at low-frequency stops.'],
                ['A6', 'Heat counts above an API-default reference, not a health threshold.', 'referenceTemperatureC', 'A published transit-specific heat-stress threshold.'],
                ['A7', 'The ridership period does not match the schedule or the thermal date.', 'ridershipQuarter', 'A ridership quarter contemporaneous with both.'],
                ['A8', 'The source splits Weekday/Weekend but not Saturday/Sunday, so one weekend average is applied to each weekend day. The timetables are NOT shared.', '—', 'Ridership published separately for Saturday and Sunday.'],
                ['A9', 'GTFS times past 24:00 are projected onto clock hours assuming the preceding service day ran the same timetable.', '—', 'Analysing a specific dated service rather than a modal one.'],
              ].map(([id, text, dimension, falsified]) => (
                <tr key={id} className="border-b border-ink-100 align-top">
                  <td className="py-1 pr-2 font-mono">{id}</td>
                  <td className="py-1 pr-2">{text}</td>
                  <td className="py-1 pr-2 font-mono text-ink-500">{dimension}</td>
                  <td className="py-1 text-ink-500">{falsified}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="pt-2 text-sm font-semibold text-ink-900">Source periods</h3>
        <ul className="ml-4 list-disc space-y-1">
          <li>
            <strong>Ridership — FY2024 Q4, Apr–Jun 2024.</strong> Valley Metro quarters are{' '}
            <em>fiscal</em> (July–June), not calendar. Coverage{' '}
            {dataset.counts.ridershipCoveragePct}% of active stops. The fiscal reading is inferred
            from the sibling layer <code>RidershipDataPortal_Bus</code>, whose earliest quarter{' '}
            <code>Q2015_2</code> matches its own description &ldquo;bus stops as of October 27,
            2014&rdquo; only under a July–June year; Valley Metro publishes no data dictionary.
          </li>
          <li>
            <strong>Schedule — effective July 2026.</strong> Official GTFS, ODC-BY. Coverage{' '}
            {dataset.counts.serviceCoveragePct}%.
          </li>
          <li>
            <strong>Heat — the analysis date you choose.</strong>
          </li>
        </ul>
        <p>
          Those three periods <strong>do not match</strong>. That is disclosed rather than corrected
          away, and drift is modelled by recomputing on the neighbouring published quarters (
          {DRIFT_QUARTERS.join(', ')}) — a sourced scenario, unlike a uniform multiplier, which
          cannot change a ranking at all.
        </p>
        <p>
          FY2024 Q4 is the <strong>latest quarter passing our completeness checks</strong> — not
          &ldquo;the latest complete quarter&rdquo;, which we are not in a position to assert.
          Quarters after it are published, and on our checks they fall apart: Phoenix weekday
          totals drop from 43,092 to 19,324 to 5,413, with individual stops going from ~41
          riders/day to 0.26. A fall that steep is far more consistent with partial reporting than
          with ridership collapsing by 87%, so those quarters are not used.
        </p>
        <p>
          <strong>Those checks are ours alone.</strong> Valley Metro publishes no completeness
          flag, no data dictionary and no revision notice for this layer, so nothing independent
          confirms that FY2024 Q4 is itself complete — only that it does not fail the tests we
          could run. If a reconciliation against a published control total ever becomes available,
          this wording should be replaced with what it establishes.
        </p>
      </Section>

      <Section id="envelope" title="Scenario envelope">
        <p>
          Five things are unobserved. Each is a scenario dimension, and the product reports the{' '}
          <strong>envelope across their full cross product</strong> —{' '}
          {enumerateScenarios().length} scenarios. It is an envelope over stated assumptions,{' '}
          <strong>not a confidence interval</strong>: nothing here is a sampling distribution, so
          calling the spread an uncertainty interval would misrepresent what it is.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-ink-200 text-left text-ink-500">
                <th className="py-1 pr-2">dimension</th>
                <th className="py-1 pr-2">base</th>
                <th className="py-1">settings swept</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-ink-100 align-top">
                <td className="py-1 pr-2 font-mono">demandProfile</td>
                <td className="py-1 pr-2 font-mono">{BASE_SCENARIO.demandProfile}</td>
                <td className="py-1">{DEMAND_PROFILES.join(', ')}</td>
              </tr>
              <tr className="border-b border-ink-100 align-top">
                <td className="py-1 pr-2 font-mono">routeChoice</td>
                <td className="py-1 pr-2 font-mono">{BASE_SCENARIO.routeChoice}</td>
                <td className="py-1">{ROUTE_CHOICE_MODELS.join(', ')}</td>
              </tr>
              <tr className="border-b border-ink-100 align-top">
                <td className="py-1 pr-2 font-mono">waitCap</td>
                <td className="py-1 pr-2 font-mono">{BASE_SCENARIO.waitCap}</td>
                <td className="py-1">
                  {WAIT_CAP_SCENARIOS.map((cap) => WAIT_CAP_LABEL[cap]).join('; ')}
                </td>
              </tr>
              <tr className="border-b border-ink-100 align-top">
                <td className="py-1 pr-2 font-mono">referenceTemperatureC</td>
                <td className="py-1 pr-2 font-mono">{BASE_SCENARIO.referenceTemperatureC}</td>
                <td className="py-1">{REFERENCE_TEMPERATURES_C.join(', ')} °C</td>
              </tr>
              <tr className="align-top">
                <td className="py-1 pr-2 font-mono">ridershipQuarter</td>
                <td className="py-1 pr-2 font-mono">{BASE_SCENARIO.ridershipQuarter}</td>
                <td className="py-1">{DRIFT_QUARTERS.join(', ')}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          <strong>
            The result of a run is the split, not the plan size: N robust priorities + M
            assumption-dependent candidates.
          </strong>{' '}
          A selection is <em>robust</em> only when it is chosen in every one of the{' '}
          {enumerateScenarios().length} scenarios. Anything else is an{' '}
          <em>assumption-dependent candidate</em> — in the plan because of a setting nobody has
          observed.
        </p>
        <p>
          Both kinds are reported with two figures, because one does not imply the other:
        </p>
        <ul className="ml-4 list-disc space-y-1">
          <li>
            <strong>selection frequency</strong> — how many of the {enumerateScenarios().length}{' '}
            scenarios select it;
          </li>
          <li>
            <strong>rank range</strong> — the best and worst position it takes across the scenarios
            that do select it. A candidate chosen 323 times out of 324 but swinging between rank 8
            and rank 48 is not the same object as one that is always rank 3, and a frequency alone
            hides that.
          </li>
        </ul>
        <p>
          The settings that drop a candidate are named on its detail panel, so fragility can be
          inspected rather than merely flagged.
        </p>
      </Section>

      <Section id="anomaly" title="Metric B — Local thermal anomaly">
        <p className="rounded bg-ink-50 p-2 font-mono text-[12px] text-ink-900">
          z(cell) = ( v − median(N) ) / ( 1.4826 × MAD(N) ),  N = other cells within{' '}
          {DEFAULT_ANOMALY_PARAMETERS.radiusMeters} m
        </p>
        <p>
          This is the question ridership cannot answer and a coarse gridded product cannot answer:
          is this place hot <em>for where it is</em>? A downtown stop being hot is not news. A stop
          being 2σ hotter than everything within a kilometre is.
        </p>
        <ul className="ml-4 list-disc space-y-1">
          <li>
            <strong>Median and MAD, not mean and σ</strong> — the thing being detected is exactly
            what would contaminate a mean-based background. Median/MAD have a 50% breakdown point,
            so a genuine hot spot does not inflate the baseline it is measured against. The 1.4826
            factor makes MAD a consistent estimator of σ, so z reads on the familiar scale.
          </li>
          <li>
            <strong>Leave-one-out by construction</strong> — a cell is excluded from its own
            background. Without that, a strong anomaly partly defines what it is compared to and is
            systematically under-detected.
          </li>
          <li>
            <strong>Minimum {DEFAULT_ANOMALY_PARAMETERS.minNeighbours} neighbours</strong>, and a
            degenerate (flat) neighbourhood returns <code>null</code>, not a huge z from dividing by
            something tiny.
          </li>
        </ul>

        <h3 className="pt-2 text-sm font-semibold text-ink-900">Out-of-sample validation</h3>
        <p>
          A hot cell at one moment could be noise. So the background is fitted independently per
          snapshot and the anomalies are compared <strong>across held-out snapshots</strong>: the
          earliest snapshot is the fit, the rest are the holdout. Two figures are reported on every
          run — the rank correlation of z between fit and holdout, and how much of the fit's top
          decile stays in the holdout's top decile, against a 10% chance level.
        </p>
        <p>
          Something driven by the ground — asphalt, no canopy, a west-facing wall — should still
          be there at 17:00, and noise should not. At least two held-out snapshots are required
          before the anomaly axis is claimed at all: two readings agreeing once is what a
          slow-moving surface produces either way.
          Verdicts: <code>PERSISTENT</code> (correlation ≥ 0.6 and retention ≥ 50%),{' '}
          <code>WEAK</code>, <code>NOT_PERSISTENT</code>. Anything below persistent is stated on the
          run and downgrades the confidence of every stop.
        </p>
      </Section>

      <Section id="selection" title="Selection — weight-free">
        <p>Exposure and anomaly stay on their own axes. Selection uses Pareto layering:</p>
        <ol className="ml-4 list-decimal space-y-1">
          <li>a stop is on front 1 if no other stop beats it on <em>both</em> metrics;</li>
          <li>front 2 is the same rule applied to what is left, and so on;</li>
          <li>
            within a front, order by <code>min(exposure percentile, anomaly percentile)</code> — a
            max-min rule that favours stops strong on their weaker axis;
          </li>
          <li>
            fill the capacity front by front, keeping selections at least{' '}
            {DEFAULT_MIN_SEPARATION_METERS} m apart, relaxed only if the capacity cannot otherwise
            be filled — and the relaxation is reported.
          </li>
        </ol>
        <p>
          No step multiplies the two metrics, adds them, or scales one against the other. There is
          no exchange rate to justify because none is used. Ties break on stop id, so the same
          inputs always produce the same plan.
        </p>
        <p>
          The <strong>matrix</strong> in the panel classifies every stop by the median of each axis:
          both high, exposure-driven, anomaly-driven, or neither. That is a communication device
          layered on top of the same two numbers, not a third metric.
        </p>
      </Section>

      <Section id="fortyguard" title="FortyGuard, and its documented contradictions">
        <p>
          Requests go to <code>POST /v1/heatmap</code> and are tracked with{' '}
          <code>GET /v1/status/&#123;activity_id&#125;</code>. The area is split into tiles under a
          9 mi² ceiling — below the smallest documented plan limit of 10 mi² (API Basic and Startup;
          Premium allows 50). Central Phoenix ({centralPlan.aoiAreaSqMi.toFixed(1)} mi²) becomes{' '}
          {centralPlan.tiles.length} tiles per snapshot.
        </p>
        <ul className="ml-4 list-disc space-y-1">
          <li>
            <strong>Date floor.</strong> API docs say 2019-01-01; the hackathon FAQ says 2021-01-01.
            The stricter bound ({EARLIEST_ANALYSIS_DATE}) is enforced.
          </li>
          <li>
            <strong>Resolution.</strong> Marketing says “10 mi²” (an area ceiling, not a
            resolution); the FAQ says ~20 m; the API accepts 60/80/100 m. Only the API values are
            used.
          </li>
          <li>
            <strong>Filter types.</strong> The limitations page lists 1–3; the endpoint page and
            OpenAPI list 1–4. Only <code>filter_type: 1</code> is used.
          </li>
          <li>
            <strong>Timezone.</strong> {TIMEZONE_ASSUMPTION} The product works in{' '}
            {ANALYSIS_TIMEZONE}.
          </li>
          <li>
            <strong>Value field.</strong> No source publishes the property name holding the
            temperature. Detection is a closed whitelist that fails loudly on an ambiguous or
            unknown schema rather than guessing.
          </li>
        </ul>
      </Section>

      <Section id="claims" title="Claim register">
        <p>
          Enforced in code, not just prose: each run records which claims it may assert, and this
          page renders the same registry the product reads.
        </p>
        {(['allowed', 'conditional', 'blocked'] as const).map((tier) => (
          <div key={tier}>
            <h3 className="mt-3 flex items-center gap-2 text-sm font-semibold text-ink-900">
              <Badge tone={tier === 'allowed' ? 'ok' : tier === 'conditional' ? 'warn' : 'stop'}>
                {tier}
              </Badge>
              <span className="capitalize">{tier}</span>
            </h3>
            <ul className="mt-1 space-y-1.5">
              {claimsByTier(tier).map((entry) => (
                <li key={entry.id} className="border-l-2 border-ink-200 pl-2">
                  <span className="block text-ink-900">{entry.statement}</span>
                  {entry.requires && (
                    <span className="block text-[12px] text-flag-700">
                      Allowed when: {entry.requires}
                    </span>
                  )}
                  {entry.because && (
                    <span className="block text-[12px] text-stop-700">Blocked: {entry.because}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="text-[12px] text-ink-500">{CLAIMS.length} registered claims.</p>
      </Section>

      <Section id="provenance" title="Data provenance">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-ink-200 text-left text-ink-500">
                <th className="py-1 pr-3">Source</th>
                <th className="py-1 pr-3">Records</th>
                <th className="py-1 pr-3">Last edited</th>
                <th className="py-1">SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {provenance.sources.map((source) => (
                <tr key={source.key} className="border-b border-ink-100 align-top">
                  <td className="py-1 pr-3">
                    <span className="block text-ink-900">{source.title}</span>
                    <span className="block text-ink-500">{source.producer}</span>
                  </td>
                  <td className="hpe-num py-1 pr-3">{source.record_count.toLocaleString('en-US')}</td>
                  <td className="hpe-num py-1 pr-3">
                    {source.service_last_edit_utc?.slice(0, 10) ?? 'not published'}
                  </td>
                  <td className="py-1 font-mono text-[10px] break-all">{source.artifact.sha256}</td>
                </tr>
              ))}
              <tr className="align-top">
                <td className="py-1 pr-3">
                  <span className="block text-ink-900">Generated analysis dataset</span>
                  <span className="block text-ink-500">joins all of the above + GTFS</span>
                </td>
                <td className="hpe-num py-1 pr-3">
                  {manifest.artifact.records.toLocaleString('en-US')}
                </td>
                <td className="hpe-num py-1 pr-3">{dataset.generatedAtUtc.slice(0, 10)}</td>
                <td className="py-1 font-mono text-[10px] break-all">{manifest.artifact.sha256}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-[12px] text-ink-500">
          GTFS is licensed ODC-BY via City of Phoenix Open Data. The two tracked Valley Metro
          ArcGIS extracts carry exact-item grants for unrestricted sharing, modification and use.
          The City BusStops and quarterly-ridership extracts are recorded as sources but are not
          distributed in this repository.
        </p>
      </Section>

      <Section id="shelter" title="Why shelter status is always “unknown”">
        <p>
          Phoenix publishes 3,164 sheltered stops for FY2024-25. The published amenity fields carry
          20 non-null values on the City layer, zero positive integers on the Valley Metro layer,
          and exactly one text value equal to “1”. Those fields are <em>incomplete</em>, not
          negative.
        </p>
        <p>
          So this product reports <code>unknown</code> for all{' '}
          {dataset.counts.activeStops.toLocaleString('en-US')} active stops, and never recommends
          installing anything. It prioritises where to look.
        </p>
      </Section>

      <footer className="mt-6 pb-8 text-[11px] text-ink-500">
        Independent hackathon project. Not endorsed by, affiliated with, or verified by the City of
        Phoenix or Valley Metro.
      </footer>
    </div>
  )
}
