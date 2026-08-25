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

    // A min-height on the parent once left MapLibre's h-full child at 0 px.
    // Assert the surface a reader can actually see and touch, not only that the
    // GeoJSON source reports features.
    const mapBox = await page.getByTestId('priority-map').boundingBox()
    const panelBox = await page.locator('aside[aria-label="Analysis panel"]').boundingBox()
    expect(mapBox?.height ?? 0).toBeGreaterThanOrEqual(420)
    expect(mapBox?.width ?? 0).toBeGreaterThan(320)

    if (page.viewportSize()?.width && page.viewportSize()!.width < 640) {
      const legendBox = await page.getByTestId('map-legend').boundingBox()
      const controlsBox = await page.locator('.maplibregl-ctrl-bottom-left').boundingBox()
      expect(legendBox).not.toBeNull()
      expect(controlsBox).not.toBeNull()
      const overlap =
        legendBox!.x < controlsBox!.x + controlsBox!.width &&
        legendBox!.x + legendBox!.width > controlsBox!.x &&
        legendBox!.y < controlsBox!.y + controlsBox!.height &&
        legendBox!.y + legendBox!.height > controlsBox!.y
      expect(overlap).toBe(false)
    }

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
    if (viewport && viewport.width < 1280) {
      // On phone and tablet the map is the primary surface and the long plan
      // follows it. It must never sit below two thousand pixels of controls,
      // results and methodology cards again.
      expect(mapBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(panelBox?.y ?? 0)
    }
    if (viewport && viewport.width < 768) {
      await expect(page.getByRole('link', { name: 'Priority map', exact: true })).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('link', { name: 'Audit', exact: true })).toBeVisible()

      const more = page.getByRole('button', { name: 'More', exact: true })
      await more.click()
      await expect(page.getByRole('link', { name: /Methods & limits/ })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(more).toBeFocused()

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

  test('gives the map the full tablet width before stacking the plan', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 })
    await page.goto('/planner')
    await expect(page.getByTestId('priority-map')).toHaveAttribute('data-cells-drawn', 'true', {
      timeout: 60_000,
    })

    const mapBox = await page.getByTestId('priority-map').boundingBox()
    const panelBox = await page.locator('aside[aria-label="Analysis panel"]').boundingBox()
    expect(mapBox?.width ?? 0).toBeGreaterThan(750)
    expect(mapBox?.height ?? 0).toBeGreaterThanOrEqual(500)
    expect(mapBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(panelBox?.y ?? 0)
  })
})
