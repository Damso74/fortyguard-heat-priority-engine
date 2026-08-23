import { expect, test } from '@playwright/test'

/**
 * The plan has to be readable on a phone at a bus stop, not only at a desk.
 * The bar is deliberately concrete: nothing overflows sideways, the honesty
 * banner survives, and both metrics stay on screen.
 */
test.describe('small screens', () => {
  test('renders the journey without horizontal overflow', async ({ page }) => {
    await page.goto('/planner')
    await expect(page.getByRole('heading', { name: 'Priority planner' })).toBeVisible()
    await expect(page.getByTestId('mode-banner')).toBeVisible()

    await page.getByTestId('run-analysis').click()
    await expect(page.getByTestId('result-row').first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('result-row')).toHaveCount(10)

    // The page body must never scroll sideways; wide content scrolls inside its
    // own container instead.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)

    // Below the md breakpoint the page itself must scroll vertically.
    // Playwright's clicks auto-scroll clipped containers, which once masked an
    // overflow-hidden shell that left the map unreachable by touch — so this
    // asserts what a finger can do, not what the test runner can. From md up
    // the shell is locked on purpose and the panel scrolls instead.
    const viewport = page.viewportSize()
    if (viewport && viewport.width < 768) {
      await expect(page.getByRole('link', { name: 'Heat monitor' })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Priority planner' })).toHaveAttribute('aria-current', 'page')
      await page.getByRole('button', { name: 'More modules' }).click()
      await expect(page.getByRole('link', { name: 'Reports & audit' })).toBeVisible()

      const verticalScroll = await page.evaluate(() => {
        const scroller = document.scrollingElement!
        scroller.scrollTop = 999999
        const reached = scroller.scrollTop
        scroller.scrollTop = 0
        return reached
      })
      expect(verticalScroll).toBeGreaterThan(100)
    }

    await page.getByTestId('result-row').first().click()
    const detail = page.getByTestId('stop-detail')
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('°C·rider-minutes')
    await expect(detail).toContainText('Not validated: anomalies did not persist')
  })
})
