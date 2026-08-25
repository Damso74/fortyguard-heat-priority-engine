import { expect, test } from '@playwright/test'

test.describe('ridership explorer', () => {
  test('keeps quarter, day category and missing values explicit', async ({ page }) => {
    const requests: Array<{ quarter: string; day: string }> = []
    await page.route('**/api/ridership?*', async (route) => {
      const url = new URL(route.request().url())
      const quarter = url.searchParams.get('quarter') ?? '2024_4'
      const day = url.searchParams.get('day') ?? 'Weekday'
      requests.push({ quarter, day })
      const weekend = day === 'Weekend'
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          source: {
            publisher: 'Valley Metro',
            layerUrl: 'https://example.test/FeatureServer/6',
            itemUrl: 'https://example.test/item',
            mapViewerUrl: 'https://example.test/map',
            lastEditUtc: '2025-04-25T19:15:22.881Z',
            licenceStatus: 'not-published-on-item',
          },
          quarter,
          dayCategory: day,
          jurisdiction: 'Phoenix',
          recordCount: 3,
          stopsWithValue: 2,
          stops: [
            {
              objectId: 1,
              stopId: 101,
              stopCode: 101,
              nexTripCode: 101,
              name: 'Central Station',
              jurisdiction: 'Phoenix',
              status: 'Active',
              dayCategory: day,
              lon: -112.073,
              lat: 33.451,
              publishedAverage: weekend ? 7 : 12,
              publishedQuarterTotal: weekend ? 420 : 720,
            },
            {
              objectId: 2,
              stopId: 102,
              stopCode: 102,
              nexTripCode: 102,
              name: 'Van Buren Street',
              jurisdiction: 'Phoenix',
              status: 'Active',
              dayCategory: day,
              lon: -112.068,
              lat: 33.448,
              publishedAverage: weekend ? 3 : 5,
              publishedQuarterTotal: weekend ? 180 : 300,
            },
            {
              objectId: 3,
              stopId: 103,
              stopCode: 103,
              nexTripCode: 103,
              name: 'Missing source value',
              jurisdiction: 'Phoenix',
              status: 'Active',
              dayCategory: day,
              lon: -112.06,
              lat: 33.46,
              publishedAverage: null,
              publishedQuarterTotal: null,
            },
          ],
        }),
      })
    })

    await page.goto('/ridership')
    await expect(page.getByRole('heading', { name: 'Ridership explorer' })).toBeVisible()
    await expect(page.getByText('2 / 3')).toBeVisible()
    await expect(page.getByText('Central Station').first()).toBeVisible()

    await page.getByLabel('Published quarter').selectOption('2025_3')
    await expect(page.getByText('Completeness warning.')).toBeVisible()

    await page.getByRole('button', { name: 'Weekend' }).click()
    await expect(page.getByText('10', { exact: true }).first()).toBeVisible()
    expect(requests).toContainEqual({ quarter: '2025_3', day: 'Weekend' })
  })
})
