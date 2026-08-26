import { mkdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const BASE_URL = process.env.DEMO_URL ?? 'https://heat-priority-engine.vercel.app'
const OUTPUT_DIR = resolve(process.cwd(), 'outputs', 'submission-video')
const RAW_VIDEO = join(OUTPUT_DIR, process.env.WALKTHROUGH_FILE ?? 'walkthrough-jury-v5.webm')
const DURATION_MS = Number(process.env.DEMO_DURATION_MS ?? '86000')

if (!Number.isFinite(DURATION_MS) || DURATION_MS < 75_000 || DURATION_MS > 105_000) {
  throw new Error('DEMO_DURATION_MS must be between 75000 and 105000.')
}

await mkdir(OUTPUT_DIR, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 810 },
  recordVideo: { dir: OUTPUT_DIR, size: { width: 1440, height: 810 } },
  locale: 'en-US',
})

await context.addInitScript(() => {
  window.addEventListener('DOMContentLoaded', () => {
    const cursor = document.createElement('div')
    cursor.dataset.demoCursor = 'pointer'
    cursor.setAttribute('aria-hidden', 'true')
    Object.assign(cursor.style, {
      position: 'fixed',
      left: '50%',
      top: '50%',
      width: '22px',
      height: '28px',
      background: '#ffffff',
      border: '1px solid #0b1828',
      clipPath: 'polygon(0 0, 0 100%, 6px 19px, 11px 28px, 16px 25px, 11px 16px, 22px 16px)',
      filter: 'drop-shadow(0 2px 3px rgb(0 0 0 / 45%))',
      pointerEvents: 'none',
      transform: 'translate(-2px, -2px)',
      zIndex: '2147483647',
    })

    const halo = document.createElement('div')
    halo.dataset.demoCursor = 'halo'
    halo.setAttribute('aria-hidden', 'true')
    Object.assign(halo.style, {
      position: 'fixed',
      left: '50%',
      top: '50%',
      width: '34px',
      height: '34px',
      border: '2px solid rgb(221 107 44 / 75%)',
      borderRadius: '9999px',
      boxShadow: '0 0 0 4px rgb(255 255 255 / 55%)',
      pointerEvents: 'none',
      transform: 'translate(-50%, -50%)',
      transition: 'transform 100ms ease, opacity 100ms ease',
      zIndex: '2147483646',
    })

    document.body.append(halo, cursor)
    window.addEventListener('mousemove', (event) => {
      cursor.style.left = `${event.clientX}px`
      cursor.style.top = `${event.clientY}px`
      halo.style.left = `${event.clientX}px`
      halo.style.top = `${event.clientY}px`
    })
    window.addEventListener('mousedown', () => {
      halo.style.transform = 'translate(-50%, -50%) scale(0.65)'
    })
    window.addEventListener('mouseup', () => {
      halo.style.transform = 'translate(-50%, -50%) scale(1.35)'
      halo.style.opacity = '0.25'
      window.setTimeout(() => {
        halo.style.transform = 'translate(-50%, -50%) scale(1)'
        halo.style.opacity = '1'
      }, 160)
    })
  })
})

const page = await context.newPage()
const video = page.video()
const startedAt = Date.now()

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
const until = async (elapsedMs) => {
  const remaining = startedAt + elapsedMs - Date.now()
  if (remaining > 0) await sleep(remaining)
}
const gotoModule = async (path, heading) => {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.getByRole('heading', { name: heading, exact: true }).first().waitFor({ timeout: 60_000 })
}
const pointTo = async (locator, { click = false, pause = 120 } = {}) => {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error('Cannot point to an element without a visible bounding box.')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 })
  await sleep(pause)
  if (click) await locator.click({ delay: 70 })
}
const openModule = async (label, path, heading) => {
  const link = page.locator('aside').getByRole('link', {
    name: new RegExp(label, 'i'),
  })
  await pointTo(link, { click: true })
  await page.waitForURL((url) => url.pathname === path, { timeout: 60_000 })
  await page.getByRole('heading', { name: heading, exact: true }).first().waitFor({ timeout: 60_000 })
}
const waitForVerifiedPlan = async () => {
  await page.getByText('Robust picks', { exact: true }).waitFor()
  await page.waitForFunction(() => {
    const label = [...document.querySelectorAll('dt')]
      .find((node) => node.textContent?.trim() === 'Robust picks')
    const value = label?.parentElement?.querySelector('.hpe-num')?.textContent?.trim()
    return value !== undefined && value !== '0' && value !== '—'
  }, undefined, { timeout: 60_000 })
}
const waitForMapSurface = async () => {
  const map = page.getByTestId('priority-map')
  await map.waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForFunction(() => {
    const surface = document.querySelector('[data-testid="priority-map"]')
    return surface?.getAttribute('data-cells-drawn') === 'true'
      && surface.querySelector('.maplibregl-canvas') !== null
  }, undefined, { timeout: 60_000 })
  // Give vector labels one frame budget beyond the analytical layer. This
  // prevents the recorder from cutting to a route while its map is still a
  // loading placeholder on a cold tile cache.
  await sleep(1_000)
}

try {
  await gotoModule('/', 'Inspect the right bus stops before the next heat wave.')
  await waitForVerifiedPlan()
  await until(1_000)
  await pointTo(page.getByRole('heading', { name: 'Inspect the right bus stops before the next heat wave.' }))
  await until(5_000)
  await pointTo(page.getByRole('heading', { name: 'Heat decisions begin where people wait.' }))

  await until(10_000)
  await pointTo(page.locator('aside details').getByText('Explore data', { exact: true }), { click: true })
  await openModule('Heat measurements', '/heat', 'Heat monitor')
  await waitForMapSurface()
  await until(14_000)
  await pointTo(page.getByRole('button', { name: '14:00', exact: true }), { click: true })
  await until(21_000)
  await pointTo(page.getByText('What this surface can support', { exact: true }))

  await until(28_000)
  await openModule('Priority map', '/planner', 'Priority planner')
  await page.getByTestId('result-row').first().waitFor({ timeout: 60_000 })
  await waitForMapSurface()
  await until(33_000)
  await pointTo(page.getByTestId('result-headline'))
  await until(40_000)
  await pointTo(page.getByTestId('result-headline'))
  await until(46_000)
  await pointTo(page.getByTestId('result-row').first())

  await until(49_000)
  await openModule('Missions', '/missions', 'Inspection missions')
  await pointTo(page.getByRole('link', { name: 'Open mission' }).first(), { click: true })
  await until(55_000)
  await pointTo(page.getByRole('button', { name: 'Absent', exact: true }).first(), { click: true })
  await until(59_000)
  await pointTo(page.getByRole('button', { name: 'Submit demo observation' }), { click: true })
  await page.getByRole('heading', { name: 'Observation submitted' }).waitFor()
  await until(63_000)
  await pointTo(page.getByRole('link', { name: 'Review evidence' }), { click: true })
  await page.getByRole('heading', { name: 'Evidence review' }).waitFor()
  await until(67_000)
  await pointTo(page.getByRole('button', { name: 'Accept evidence' }), { click: true })
  await page.getByText('Decision v2').first().waitFor()

  await until(72_000)
  await openModule('Audit', '/reports', 'Reports & audit')
  await until(76_000)
  await pointTo(page.getByText('Package status', { exact: true }))
  await until(81_000)
  await pointTo(page.getByText(/Decision brief/i).first())
  await until(DURATION_MS)
} finally {
  await page.close()
  await context.close()
  await browser.close()
}

const recordedPath = await video.path()
await rename(recordedPath, RAW_VIDEO)
process.stdout.write(`${RAW_VIDEO}\n`)
