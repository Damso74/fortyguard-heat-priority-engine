import { expect, test } from '@playwright/test'

const ROUTES = [
  ['/', /Inspect the right bus stops/],
  ['/heat', 'Heat monitor'],
  ['/ridership', 'Ridership explorer'],
  ['/planner', 'Priority planner'],
  ['/missions', 'Inspection missions'],
  ['/evidence', 'Evidence review'],
  ['/scenarios', 'Scenario lab'],
  ['/reports', 'Reports & audit'],
  ['/methodology', 'Methodology'],
] as const

test.describe('shared product shell', () => {
  for (const viewport of [
    { name: 'phone', width: 393, height: 852 },
    { name: 'tablet', width: 1024, height: 900 },
  ]) {
    test(`keeps every module reachable and readable on ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport)

      for (const [path, heading] of ROUTES) {
        await page.goto(path)
        await expect(page.getByRole('heading', { level: 1, name: heading }).first()).toBeVisible()
        await expect(page.locator('main')).toHaveCount(1)
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
        expect(overflow, `${path} overflows at ${viewport.width}px`).toBeLessThanOrEqual(1)
      }
    })
  }

  test('keeps Missions active on a field mission route', async ({ page }) => {
    await page.goto('/missions')
    await page.getByRole('link', { name: 'Open mission' }).first().click()
    await expect(page.getByRole('link', { name: /^Missions/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.locator('main')).toHaveCount(1)
  })

  test('keeps the global chrome concise and leaves source detail to each page', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText(/^Plan v\d+$/)).toHaveCount(0)
    await expect(page.getByText('Stored real FortyGuard response')).toHaveCount(0)

    await page.goto('/planner')
    await expect(page.getByText(/^Plan v\d+$/)).toHaveCount(0)

    await page.goto('/ridership')
    await expect(page.getByText('Live Valley Metro layer')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Ridership explorer' })).toBeVisible()
    await expect(page.getByText(/^Plan v\d+$/)).toHaveCount(0)

    await page.goto('/methodology')
    await expect(page.getByRole('heading', { name: 'Data & methodology' })).toBeVisible()
    await expect(page.getByText(/^Plan v\d+$/)).toHaveCount(0)
  })
})
