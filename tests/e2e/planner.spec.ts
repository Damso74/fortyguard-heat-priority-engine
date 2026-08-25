import { expect, test } from '@playwright/test'

/**
 * The demo journey, asserted end to end against a production build.
 * These mirror docs/demo-script.md step for step, so a broken demo breaks CI.
 */

const runAnalysis = async (page: import('@playwright/test').Page) => {
  await page.getByTestId('run-analysis').click()
  await expect(page.getByTestId('result-row').first()).toBeVisible({ timeout: 60_000 })
}

const useTwoAxisFixture = async (page: import('@playwright/test').Page) => {
  await expect(page.getByTestId('result-row').first()).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('aoi-select').selectOption('central-phoenix')
  await page.getByTestId('capacity-50').click()
  await expect(page.getByTestId('result-row')).toHaveCount(50, { timeout: 60_000 })
}

test.describe('Heat Priority Engine — main journey', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await page.goto('/planner')
    const realDefaultJourneys = [
      'states its thesis',
      'keeps the panel usable',
      'methodology page',
      'is reachable by keyboard',
    ]
    if (!realDefaultJourneys.some((title) => testInfo.title.startsWith(title))) {
      await useTwoAxisFixture(page)
    }
  })

  test('states its thesis and its data mode, and runs the default analysis itself', async ({
    page,
  }) => {
    await expect(page.getByRole('heading', { name: 'Priority planner' })).toBeVisible()
    await expect(page.getByText(/Choose the Phoenix stops to inspect before the next heat wave/)).toBeVisible()

    const banner = page.getByTestId('mode-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText(/verified measurements/i)
    await expect(banner).toContainText('Stored FortyGuard measurements from completed Phoenix activities')

    // Nobody has clicked anything: the first paint is the product, and the
    // headline split leads the panel.
    await expect(page.getByTestId('result-row').first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('result-headline')).toBeVisible()
    await expect(page.getByText('Exposure-only ordering, no weights')).toBeVisible()
    await expect(page.getByText(/undefinedth/i)).toHaveCount(0)
  })

  test('carries the inspection identity, never the investment one', async ({ page }) => {
    // The claim registry blocks every cost, construction and causal-impact
    // claim; the public name must not promise one.
    expect(await page.title()).toContain('Priority Planner')
    expect(await page.title()).not.toContain('Investment Planner')

    // The third layer is two axes side by side, never a blend — the label must
    // say so. The testid stays `layer-combined`: internal contract, unchanged.
    await expect(page.getByTestId('layer-combined')).toHaveText('Exposure × Anomaly')

    // Brand assets are actually served.
    expect((await page.request.get('/icon.svg')).status()).toBe(200)
    expect((await page.request.get('/opengraph-image.png')).status()).toBe(200)
    expect((await page.request.get('/brand/logo-horizontal.svg')).status()).toBe(200)

    // The method cards summarise the moat and route to the full argument.
    await runAnalysis(page)
    const cards = page.getByTestId('method-cards')
    await cards.getByText('Why these rankings?').click()
    await expect(cards).toContainText('Two axes, never blended')
    await expect(cards).toContainText('combinations')
    await expect(cards).toContainText('Every claim is auditable')
    await cards.getByRole('link', { name: 'Audit the full methodology' }).click()
    await expect(page.getByRole('heading', { name: 'Methodology' })).toBeVisible()
  })

  test('draws the heat field on the map, not only in the list', async ({ page }) => {
    // The map once rendered nothing for the project's whole life — the worker
    // that parses GeoJSON never started, the basemap still drew, and no test
    // noticed because none asserted that data actually reached the screen.
    await runAnalysis(page)
    await expect(page.getByTestId('priority-map')).toHaveAttribute('data-cells-drawn', 'true', {
      timeout: 30_000,
    })
    const fitFootprint = page.getByTestId('fit-thermal-footprint')
    await expect(fitFootprint).toBeVisible()
    await expect(fitFootprint).toHaveText('Show full measured footprint')
    await fitFootprint.click()
    await expect(page.getByTestId('priority-map')).toHaveAttribute('data-cells-drawn', 'true')

    await expect
      .poll(async () => Number(await page.getByTestId('priority-map').getAttribute('data-thermal-coverage')))
      .toBeGreaterThan(0.8)
  })

  test('expands the desktop map without losing the plan', async ({ page }) => {
    await runAnalysis(page)
    const map = page.getByTestId('priority-map')
    const canvas = map.locator('.maplibregl-canvas')
    const toggle = page.getByTestId('toggle-analysis-panel')
    const before = await map.boundingBox()
    const canvasBefore = await canvas.boundingBox()

    await expect(toggle).toHaveAccessibleName('Expand map')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await toggle.click()
    await expect(toggle).toHaveAccessibleName('Open plan')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('aside[aria-label="Analysis panel"]')).toBeHidden()
    await expect.poll(async () => (await map.boundingBox())?.width ?? 0).toBeGreaterThan(
      (before?.width ?? 0) + 250,
    )
    await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(
      (canvasBefore?.width ?? 0) + 250,
    )

    await toggle.click()
    await expect(toggle).toHaveAccessibleName('Expand map')
    await expect(page.locator('aside[aria-label="Analysis panel"]')).toBeVisible()
  })

  test('offers no weight control anywhere on the main path', async ({ page }) => {
    // The previous product let a user tune their way to a preferred answer.
    // That control must not exist.
    //
    // The assertion is about CONTROLS, not about the word. It used to be
    // `getByText(/weight/i)` with a count of zero, which passed only because the
    // analysis had not finished rendering the copy that says weights are not
    // used — a race the run cache exposed by making the first run fast. Asserting
    // the absence of a sentence that exists to promise the absence of a feature
    // is testing the wrong thing.
    const weightControls = page.locator(
      'input[type="range"], [role="slider"], input[name*="weight" i], select[name*="weight" i]',
    )
    await expect(weightControls).toHaveCount(0)
    await runAnalysis(page)
    await expect(weightControls).toHaveCount(0)
    // And the product says so, in the panel, once there is a plan to say it about.
    await expect(page.getByText(/no weights/i).first()).toBeVisible()
  })

  test('reports two metrics separately and never a blended score', async ({ page }) => {
    await runAnalysis(page)
    await expect(page.getByTestId('result-row')).toHaveCount(50)

    const first = page.getByTestId('result-row').first()
    // The unit is resolved per run and carries the fixture's own label; a bare
    // "°C" here would be the hardcoding this asserts against.
    await expect(first).toContainText('°C (synthetic)·rider-min')
    await expect(first).toContainText('σ')
    // No combined "priority score" is offered.
    await expect(page.getByText(/priority score/i)).toHaveCount(0)
  })

  test('leads with the stable / variable split, not the plan size', async ({ page }) => {
    await runAnalysis(page)

    const headline = page.getByTestId('result-headline')
    await expect(headline).toBeVisible()
    await expect(headline).toContainText(
      /\d+ stable \+ \d+ change[s]? with assumptions/,
    )

    // Every selected row carries the two figures behind the split.
    const first = page.getByTestId('result-row').first()
    await expect(first).toContainText(/\d+\/324 tests/)
    await expect(first).toContainText(/rank \d+(–\d+)?/)
    await expect(first).toContainText(/stable|variable/)
  })

  test('switches the map between exposure, anomaly and combined', async ({ page }) => {
    await runAnalysis(page)
    await expect(page.getByTestId('priority-map')).toBeVisible()

    await expect(page.getByText('Temperature', { exact: false }).first()).toBeVisible()
    await page.getByTestId('layer-anomaly').click()
    await expect(page.getByText('Local heat anomaly')).toBeVisible()
    await expect(page.getByText('Robust z against the median')).toBeVisible()

    await page.getByTestId('layer-combined').click()
    await expect(page.getByTestId('layer-combined')).toHaveAttribute('aria-pressed', 'true')
  })

  test('shows a quantitative legend, not a colour key alone', async ({ page }) => {
    await runAnalysis(page)
    await page.getByTestId('layer-anomaly').click()
    await expect(page.getByText('−3σ')).toBeVisible()
    await expect(page.getByText('+3σ')).toBeVisible()
  })

  test('decomposes a stop into riders × wait × heat, with an uncertainty interval', async ({
    page,
  }) => {
    await runAnalysis(page)
    const stopId = await page.getByTestId('result-row').first().getAttribute('data-stop-id')
    await page.getByTestId('result-row').first().click()

    const detail = page.getByTestId('stop-detail')
    await expect(detail).toBeVisible()
    await expect(detail).toHaveAttribute('data-stop-id', stopId!)

    await expect(detail).toContainText('Estimated scenario exposure load')
    await expect(detail).toContainText('modelled, not measured')
    await expect(detail).toContainText('scenario envelope')
    await expect(detail).toContainText('not a confidence interval')
    await expect(detail).toContainText('Heat anomaly')
    await expect(detail).toContainText('σ vs the surrounding kilometre')
    // Rendered uppercase by CSS; the text node keeps its source casing.
    await expect(detail).toContainText(/exposure load by hour/i)
    await expect(detail).toContainText('riders ×')
    // Every rule that must be visible to a reader of one stop.
    await expect(detail).toContainText('(A1)') // demand allocation
    await expect(detail).toContainText('No rider here was counted') // riders are modelled
    await expect(detail).toContainText('clipped to hour h') // the boundary rule
    await expect(detail).toContainText('NOT min(E[W], c)') // the cap rule
    await expect(detail).toContainText('union_timetable') // route choice, stated
    await expect(detail).toContainText('cap_15') // wait cap, stated
    await expect(detail).toContainText('API analytic default, not')
    // The synthetic label survives verbatim wherever a unit is printed.
    await expect(detail).toContainText('°C (synthetic)')
    await expect(detail).toContainText('FY2024 Q4 — Apr–Jun 2024')
    await expect(detail).toContainText('Allocation check') // Σ riders(h) = published
    await expect(detail).toContainText('NOT evidence about Phoenix')
    await expect(detail).toContainText('Shelter: unknown')
    await expect(detail).toContainText('What this does not say')
  })

  test('offers a table view of the hourly decomposition', async ({ page }) => {
    await runAnalysis(page)
    await page.getByTestId('result-row').first().click()
    const detail = page.getByTestId('stop-detail')
    await detail.getByRole('button', { name: 'Table' }).click()
    await expect(detail.getByRole('columnheader', { name: 'Riders' })).toBeVisible()
    await expect(detail.getByRole('columnheader', { name: 'Wait' })).toBeVisible()
    await expect(detail.getByRole('columnheader', { name: 'Excess' })).toBeVisible()
  })

  test('scrolls the detail into view when a stop is selected from far down the list', async ({
    page,
  }) => {
    await runAnalysis(page)
    await page.getByTestId('filter-all').click()
    const rows = page.getByTestId('result-row')
    await rows.nth(40).click()

    const detail = page.getByTestId('stop-detail')
    await expect(detail).toBeInViewport({ timeout: 10_000 })
  })

  test('classifies stops in the exposure × anomaly matrix with a table view', async ({ page }) => {
    await runAnalysis(page)
    const matrix = page.locator('section[aria-labelledby="matrix-heading"]')
    await expect(matrix).toBeVisible()
    await expect(matrix.locator('circle').first()).toBeVisible()
    await expect(matrix).toContainText('High exposure + unusual heat')

    await matrix.getByRole('button', { name: 'Table view' }).click()
    await expect(matrix.getByRole('columnheader', { name: 'Quadrant' })).toBeVisible()
  })

  test('sorts by either metric and toggles direction', async ({ page }) => {
    await runAnalysis(page)
    const readFirst = () => page.getByTestId('result-row').first().getAttribute('data-stop-id')

    await page.getByTestId('sort-exposure').click()
    const descending = await readFirst()
    await page.getByTestId('sort-exposure').click()
    const ascending = await readFirst()
    expect(ascending).not.toBe(descending)

    await page.getByTestId('sort-anomaly').click()
    await expect(page.getByTestId('sort-anomaly')).toHaveAttribute('aria-sort', 'descending')
  })

  test('changes capacity and rebuilds the plan', async ({ page }) => {
    await runAnalysis(page)
    await expect(page.getByTestId('result-row')).toHaveCount(50)
    await page.getByTestId('capacity-20').click()
    await expect(page.getByTestId('result-row')).toHaveCount(20, { timeout: 60_000 })
    await page.getByTestId('capacity-80').click()
    await expect(page.getByTestId('result-row')).toHaveCount(80, { timeout: 60_000 })
  })

  test('switches day category and changes the exposure figures', async ({ page }) => {
    await runAnalysis(page)
    const weekday = await page.getByTestId('result-row').first().innerText()
    await page.getByTestId('day-type').selectOption('saturday')
    await expect(page.getByTestId('result-row').first()).not.toHaveText(weekday, {
      timeout: 60_000,
    })
  })

  test('keeps the panel usable when the map cannot load', async ({ page, context }) => {
    await context.route('**/basemaps.cartocdn.com/**', (route) => route.abort())
    await page.goto('/planner')
    await runAnalysis(page)
    await expect(page.getByTestId('result-row')).toHaveCount(10)
    await page.getByTestId('result-row').first().click()
    await expect(page.getByTestId('stop-detail')).toBeVisible()
  })

  test('refuses to export a run this server does not hold, rather than re-deriving it', async ({
    request,
  }) => {
    // This used to re-execute the engine and compare run ids. A second execution
    // produces a second audit trail, with new timestamps, for a run that already
    // happened — so the export is now a lookup, and a miss is a refusal.
    const response = await request.post('/api/plans/export', {
      data: {
        request: { aoiId: 'central-phoenix', capacity: 20, analysisDate: '2026-08-03' },
        format: 'json',
        attestedBy: 'E2E Reviewer',
        expectedRunId: 'run_0000000000000000',
      },
    })
    expect(response.status()).toBe(409)
    const body = await response.json()
    expect(body.error).toMatch(/is not held by this server/)
    expect(body.error).toMatch(/frozen representation/)
    expect(body.expectedRunId).toBe('run_0000000000000000')
  })

  test('exports the run it was given, with the audit prefix it already had', async ({
    request,
  }) => {
    const plan = await request.post('/api/plans', {
      data: { aoiId: 'central-phoenix', capacity: 10, analysisDate: '2026-08-03' },
    })
    expect(plan.ok()).toBeTruthy()
    const summary = await plan.json()

    // The summary carries the audit as a digest and a shape, not as the trail.
    expect(Array.isArray(summary.audit)).toBeFalsy()
    expect(summary.audit.sha256).toMatch(/^[a-f0-9]{64}$/)

    const audit = await request.get(
      `/api/plans/detail?runId=${encodeURIComponent(summary.runId)}&include=audit`,
    )
    expect(audit.ok()).toBeTruthy()
    const trail = await audit.json()
    expect(trail.sha256).toBe(summary.audit.sha256)
    expect(trail.audit).toHaveLength(summary.audit.eventCount)

    // The audit digest is required, not optional: the run id identifies the
    // inputs, the digest identifies the record that was reviewed.
    const withoutDigest = await request.post('/api/plans/export', {
      data: { format: 'json', attestedBy: 'E2E Reviewer', expectedRunId: summary.runId },
    })
    expect(withoutDigest.status()).toBe(400)
    expect((await withoutDigest.json()).error).toMatch(/expectedAuditSha256 is required/)

    const wrongDigest = await request.post('/api/plans/export', {
      data: {
        format: 'json',
        attestedBy: 'E2E Reviewer',
        expectedRunId: summary.runId,
        expectedAuditSha256: 'f'.repeat(64),
      },
    })
    expect(wrongDigest.status()).toBe(409)

    const exported = await request.post('/api/plans/export', {
      data: {
        format: 'json',
        attestedBy: 'E2E Reviewer',
        expectedRunId: summary.runId,
        expectedAuditSha256: summary.audit.sha256,
      },
    })
    expect(exported.ok()).toBeTruthy()
    const body = JSON.parse(await exported.text())

    // The exported trail begins with exactly the records the run already had.
    expect(body.audit.slice(0, trail.audit.length)).toEqual(trail.audit)
    expect(body.audit).toHaveLength(trail.audit.length + 2)
    expect(body.attestation.reviewedAuditSha256).toBe(trail.sha256)
  })

  test('refuses an export with no expectedRunId at all', async ({ request }) => {
    const response = await request.post('/api/plans/export', {
      data: {
        request: { aoiId: 'central-phoenix', capacity: 20 },
        format: 'json',
        attestedBy: 'E2E Reviewer',
      },
    })
    expect(response.status()).toBe(400)
    expect((await response.json()).error).toMatch(/expectedRunId is required/)
  })

  test('requires attestation before export, then exports CSV', async ({ page }) => {
    await runAnalysis(page)
    await expect(page.getByTestId('export-csv')).toBeDisabled()
    await expect(page.getByText(/no authentication/i)).toBeVisible()
    await page.getByTestId('approver-input').fill('E2E Reviewer')
    await page.getByTestId('approve-plan').click()
    await expect(page.getByTestId('export-csv')).toBeEnabled()

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-csv').click(),
    ])
    expect(download.suggestedFilename()).toMatch(
      /^heat-priority-plan_run_[a-f0-9]{16}_demo-synthetic\.csv$/,
    )
  })

  test('exports JSON carrying both metrics, the assumptions and the validation', async ({
    page,
  }) => {
    await runAnalysis(page)
    await page.getByTestId('approver-input').fill('E2E Reviewer')
    await page.getByTestId('approve-plan').click()

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-json').click(),
    ])
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'))

    expect(payload.state).toBe('exported')
    expect(payload.manifest.dataMode).toBe('DEMO_SYNTHETIC')
    expect(payload.methodology.selection.weightsUsed).toBe(false)
    expect(payload.methodology.exposure.name).toBe('Estimated scenario exposure load')
    expect(payload.methodology.exposure.unit).toMatch(/rider-minutes/)
    expect(payload.methodology.exposure.isMeasurement).toBe(false)
    expect(payload.methodology.exposure.quantityCaveat).toMatch(/not a measurement/)
    expect(payload.methodology.exposure.waitCapRule).toMatch(/NOT min\(E\[W\], c\)/)
    expect(payload.methodology.exposure.assumptions).toHaveLength(9)
    // The unit is resolved per run, and the fixture's is explicitly synthetic.
    expect(payload.methodology.exposure.thermalUnitLabel).toBe('°C (synthetic)')
    expect(payload.methodology.exposure.loadUnitShort).toBe('°C (synthetic)·rider-min')
    // Named self-attestation, bound to the run, never called an approval.
    expect(payload.attestation.kind).toBe('named_self_attestation')
    expect(payload.attestation.runId).toBe(payload.runId)
    expect(payload.attestation.caveat).toMatch(/no authentication/i)
    expect(payload.methodology.anomaly.leaveOneOut).toBe(true)
    expect(payload.methodology.anomaly.validation.verdict).toBeTruthy()
    // Rules 9, 10 and 11 must survive into the export.
    expect(payload.methodology.scenarioEnvelope.scenarioCount).toBe(324)
    expect(payload.methodology.exposure.referenceTemperatureSource).toMatch(/NOT a health/)
    expect(payload.methodology.anomaly.validation.scope).toBe('synthetic_fixture')
    expect(payload.methodology.anomaly.validation.statement).toMatch(/NOT evidence about Phoenix/)
    expect(payload.results.some((r: { assumptionSensitive: boolean }) => r.assumptionSensitive)).toBe(true)
    // The headline split, and the two per-candidate figures behind it.
    expect(payload.plan.headline).toMatch(
      /^\d+ robust (priority|priorities) \+ \d+ assumption-dependent (candidate|candidates)$/,
    )
    expect(payload.plan.robustIds.length + payload.plan.assumptionDependentIds.length).toBe(
      payload.plan.selectedIds.length,
    )
    for (const id of payload.plan.selectedIds) {
      const entry = payload.results.find((r: { stopId: number }) => String(r.stopId) === id)
      expect(entry.scenarioSelectionCount).toBeGreaterThan(0)
      expect(entry.scenarioRankBest).not.toBeNull()
      expect(entry.scenarioRankWorst).toBeGreaterThanOrEqual(entry.scenarioRankBest)
    }
    expect(payload.limitations.join(' ')).toMatch(/SYNTHETIC/)
    const steps = payload.audit.map((event: { step: string }) => event.step)
    expect(steps).toContain('approved')
    expect(steps).toContain('exported')

    // The blocked claims are *named* in the manifest — that is the point of the
    // registry — so the prose check runs over the payload with the registry
    // removed, and asserts the ids are present separately.
    expect(payload.manifest.claimsBlocked).toContain('stop_is_unsheltered')
    expect(payload.manifest.claimsBlocked).toContain('people_protected')
    expect(payload.manifest.claimsBlocked).toContain('temperature_reduced')

    const withoutRegistry = { ...payload, manifest: { ...payload.manifest, claimsBlocked: [], claimsAllowed: [] } }
    expect(JSON.stringify(withoutRegistry)).not.toMatch(
      /people protected|dollars saved|degrees reduced|is unsheltered/i,
    )
    // Every stop still reports shelter status as unknown.
    for (const entry of payload.results) expect(entry.shelterStatus).toBe('unknown')
  })

  test('methodology page documents both metrics and the claim register', async ({ page }) => {
    await page.getByText('Explore data').click()
    await page.getByRole('link', { name: 'Methods & limits', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Methodology' })).toBeVisible()
    await expect(page.getByText('Metric A — Estimated scenario exposure load')).toBeVisible()
    await expect(page.getByText('Metric B — Local thermal anomaly')).toBeVisible()
    await expect(page.getByText('Selection — weight-free')).toBeVisible()
    // The pre-pivot diagnostic figures were removed rather than caveated, so the
    // page must argue from the units instead of from a correlation it cannot
    // reproduce.
    await expect(page.getByText('nothing converts degrees into riders')).toBeVisible()
    await expect(page.getByText('That N people are protected by the plan.')).toBeVisible()
    // Provenance hashes are printed on the page.
    await expect(
      page.locator('#provenance td.font-mono').first(),
    ).toContainText(/^[a-f0-9]{64}$/)
  })

  test('is reachable by keyboard alone', async ({ page }) => {
    await page.keyboard.press('Tab')
    await expect(page.locator('.hpe-skip-link')).toBeFocused()
    await page.getByTestId('run-analysis').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('result-row').first()).toBeVisible({ timeout: 60_000 })
  })
})

test.describe('no-key honesty and API guards', () => {
  test('the status endpoint never leaks the key', async ({ request }) => {
    const response = await request.get('/api/fortyguard/status')
    const body = await response.json()
    expect(body.configured).toBe(false)
    expect(body.liveEnabled).toBe(false)
    expect(Object.keys(body)).not.toContain('apiKey')
  })

  test('rejects an oversized body and an unknown area', async ({ request }) => {
    const big = await request.post('/api/plans', {
      data: { aoiId: 'central-phoenix', junk: 'x'.repeat(70_000) },
    })
    expect(big.status()).toBe(413)

    const unknown = await request.post('/api/plans', { data: { aoiId: 'atlantis' } })
    expect(unknown.status()).toBe(400)
  })

  test('refuses to export without a named attestation', async ({ request }) => {
    const response = await request.post('/api/plans/export', {
      data: { request: { aoiId: 'central-phoenix' }, format: 'csv' },
    })
    expect(response.status()).toBe(400)
    const body = await response.json()
    expect(body.error).toMatch(/A name is required/)
    // And it is described as what it is.
    expect(body.error).toMatch(/not as an authenticated approval/)
  })

  test('is deterministic: the same request returns the same run id and plan', async ({
    request,
  }) => {
    const body = {
      aoiId: 'central-phoenix',
      capacity: 20,
      analysisDate: '2026-08-03',
      snapshotTimes: ['11:00', '14:00', '17:00'],
      dayType: 'weekday',
    }
    const first = await (await request.post('/api/plans', { data: body })).json()
    const second = await (await request.post('/api/plans', { data: body })).json()
    expect(second.runId).toBe(first.runId)
    expect(second.plan.selectedIds).toEqual(first.plan.selectedIds)
  })

  test('validates the anomaly out of sample and reports the verdict', async ({ request }) => {
    const response = await request.post('/api/plans', {
      data: {
        aoiId: 'central-phoenix',
        capacity: 20,
        analysisDate: '2026-08-03',
        snapshotTimes: ['11:00', '14:00', '17:00'],
        dayType: 'weekday',
      },
    })
    const run = await response.json()
    const validation = run.methodology.anomaly.validation
    expect(validation.holdoutSnapshots).toHaveLength(2)
    expect(validation.comparedCells).toBeGreaterThan(1000)
    expect(validation.verdict).toBe('PERSISTENT')
    expect(validation.rankCorrelation).toBeGreaterThan(0.6)
  })
})
