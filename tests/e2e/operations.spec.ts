import { expect, test } from '@playwright/test'

test.describe('municipal operations workflow', () => {
  test('connects the guided decision workflow from heat evidence to field review', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /Turn heat evidence/ })).toBeVisible()
    await expect(page.getByText('Real FortyGuard pilot').first()).toBeVisible()

    await page.getByRole('link', { name: 'Explore heat evidence' }).click()
    await expect(page).toHaveURL(/\/heat$/)
    await page.getByRole('link', { name: 'Open priority plan' }).click()
    await expect(page).toHaveURL(/\/planner$/)
    await page.getByRole('link', { name: 'Create inspection missions' }).click()
    await expect(page).toHaveURL(/\/missions$/)
    await expect(page.getByRole('heading', { name: 'Inspection missions' })).toBeVisible()

    const firstMission = page.getByRole('link', { name: 'Open mission' }).first()
    await firstMission.click()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.getByRole('button', { name: 'Absent', exact: true }).first().click()
    await page.getByRole('button', { name: 'Submit demo observation' }).click()
    await expect(page.getByRole('heading', { name: 'Observation submitted' })).toBeVisible()

    await page.getByRole('link', { name: 'Review evidence' }).click()
    await expect(page.getByRole('heading', { name: 'Evidence review' })).toBeVisible()
    await page.getByRole('button', { name: 'Accept evidence' }).click()
    await expect(page.getByText('Plan v2').first()).toBeVisible()
  })

  test('exposes every submitted module without a dead navigation route', async ({ page }) => {
    for (const [path, heading] of [
      ['/heat', 'Heat monitor'],
      ['/planner', 'Priority planner'],
      ['/missions', 'Inspection missions'],
      ['/evidence', 'Evidence review'],
      ['/scenarios', 'Scenario lab'],
      ['/reports', 'Reports & audit'],
      ['/methodology', 'Methodology'],
    ] as const) {
      await page.goto(path)
      await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible()
    }
  })
})
