import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3100)
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /responsive\.spec\.ts/ },
  ],
  webServer: {
    // Production build: the E2E suite must exercise what actually ships.
    command: `npx next build && npx next start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {
      // The suite asserts the honest no-key behaviour, so the live path stays off.
      RUN_LIVE_FORTYGUARD: '0',
      FORTYGUARD_API_KEY: '',
    },
  },
})
