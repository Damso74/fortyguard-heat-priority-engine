import { expect, test } from '@playwright/test'

test.describe('municipal operations workflow', () => {
  test('connects the guided decision workflow from heat evidence to field review', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /Inspect the right bus stops/ })).toBeVisible()
    await expect(page.getByText(/27 stops analyzed · 450 heat measurements · Human review required/)).toBeVisible()
    await expect(page.getByText('Historical pilot · July 2024', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('10 inspection candidates · 3 robust', { exact: true })).toBeVisible()
    await expect(page.getByTestId('priority-map')).toHaveAttribute('data-cells-drawn', 'true', { timeout: 30_000 })

    await page.getByRole('link', { name: 'View priority map' }).click()
    await expect(page).toHaveURL(/\/planner$/)
    await page.getByRole('link', { name: 'Create inspection missions' }).click()
    await expect(page).toHaveURL(/\/missions$/)
    await expect(page.getByRole('heading', { name: 'Inspection missions' })).toBeVisible()

    const firstMission = page.getByRole('link', { name: 'Open mission' }).first()
    await firstMission.click()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByText('Session-only field record', { exact: true })).toBeVisible()
    const absentShade = page.getByRole('button', { name: 'Absent', exact: true }).first()
    await absentShade.click()
    await expect(absentShade).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Submit demo observation' }).click()
    await expect(page.getByRole('heading', { name: 'Observation submitted' })).toBeVisible()

    await page.getByRole('link', { name: 'Review evidence' }).click()
    await expect(page.getByRole('heading', { name: 'Evidence review' })).toBeVisible()
    await page.getByRole('button', { name: 'Accept evidence' }).click()
    await expect(page.getByText('Decision v2').first()).toBeVisible()
  })

  test('keeps historical context, temperature units and empty field review explicit', async ({ page }) => {
    await page.goto('/heat')
    await expect(page.getByText('Historical pilot · July 2024', { exact: true })).toBeVisible()
    const heatMap = page.getByTestId('priority-map')
    await expect(heatMap).toHaveAttribute('data-cells-drawn', 'true', { timeout: 30_000 })
    await expect(heatMap).toHaveAttribute('data-fit-mode', 'cover')
    await expect(heatMap).toHaveAttribute('data-thermal-opacity', '0.68')
    await expect
      .poll(async () => Number(await heatMap.getAttribute('data-thermal-viewport-fill')))
      .toBeGreaterThanOrEqual(1)
    const temperatureSummary = page.locator('aside').filter({ hasText: 'measured cells' })
    await expect(temperatureSummary.getByText(/°C/).first()).toBeVisible()
    await expect(temperatureSummary.getByText(/°F/).first()).toBeVisible()

    await page.goto('/reports')
    const fieldReview = page.getByText('Field review', { exact: true }).locator('..')
    await expect(fieldReview.getByText('Not started', { exact: true })).toBeVisible()
    await expect(page.getByText('No field evidence', { exact: true })).toBeVisible()

    await page.goto('/methodology')
    await expect(page.getByRole('heading', { name: 'Executive summary', exact: true })).toBeVisible()
  })

  test('exposes every submitted module without a dead navigation route', async ({ page }) => {
    for (const [path, heading] of [
      ['/heat', 'Heat monitor'],
      ['/ridership', 'Ridership explorer'],
      ['/planner', 'Priority planner'],
      ['/missions', 'Inspection missions'],
      ['/evidence', 'Evidence review'],
      ['/scenarios', 'Scenario lab'],
      ['/reports', 'Reports & audit'],
      ['/methodology', 'Data & methodology'],
    ] as const) {
      await page.goto(path)
      await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible()
    }
  })

  test('requires confirmation before resetting the demo workspace', async ({ page }) => {
    await page.goto('/missions')
    await page.getByText('Demo controls and workflow rules').click()
    await page.getByRole('button', { name: 'Reset demo workspace' }).click()
    await expect(page.getByText('Reset every demo mission and observation?')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText('Reset every demo mission and observation?')).toBeHidden()
  })

  test('reopens a mission after a reinspection request', async ({ page }) => {
    await page.goto('/missions')
    const missionLink = page.getByRole('link', { name: 'Open mission' }).first()
    const missionHref = await missionLink.getAttribute('href')
    expect(missionHref).toBeTruthy()
    await missionLink.click()
    await page.getByRole('button', { name: 'Absent', exact: true }).first().click()
    await page.getByRole('button', { name: 'Submit demo observation' }).click()
    await page.getByRole('link', { name: 'Review evidence' }).click()
    await page.getByRole('button', { name: 'Request reinspection' }).click()
    await expect(page.getByRole('heading', { name: 'No observations submitted' })).toBeVisible()
    await page.goto(missionHref!)
    await expect(page.getByRole('button', { name: 'Submit demo observation' })).toBeVisible()
  })

  test('does not relabel a previous scenario while capacity recomputes', async ({ page }) => {
    await page.route('**/api/plans', async (route, request) => {
      const body = request.postDataJSON() as { capacity?: number }
      if (body.capacity === 20) await new Promise((resolve) => setTimeout(resolve, 500))
      await route.continue()
    })
    await page.goto('/scenarios')
    await expect(page.getByText(/Capacity 10 · \d+ evaluable stops/)).toBeVisible()
    await page.getByRole('button', { name: '20', exact: true }).click()
    await expect(page.getByText('Recomputing capacity 20…')).toBeVisible()
    await expect(page.getByText('—').first()).toBeVisible()
    await expect(page.getByText(/Capacity 20 · \d+ evaluable stops/)).toBeVisible()
  })
})
