import { mkdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const BASE_URL = process.env.DEMO_URL ?? 'https://heat-priority-engine.vercel.app'
const OUTPUT_DIR = resolve(process.cwd(), 'outputs', 'submission-video')
const RAW_VIDEO = join(OUTPUT_DIR, process.env.WALKTHROUGH_FILE ?? 'walkthrough-jury-final.webm')
const TIME_SCALE = Number(process.env.DEMO_TIME_SCALE ?? '1')
const DURATION_MS = 153_000

if (!Number.isFinite(TIME_SCALE) || TIME_SCALE <= 0 || TIME_SCALE > 2) {
  throw new Error('DEMO_TIME_SCALE must be greater than 0 and at most 2.')
}

await mkdir(OUTPUT_DIR, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 810 },
  recordVideo: { dir: OUTPUT_DIR, size: { width: 1440, height: 810 } },
  locale: 'en-US',
})

// Chromium's recorded video does not include the system pointer. This overlay
// follows real Playwright mouse events and makes the judge's attention path
// explicit without modifying the deployed application.
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
      transition: 'filter 120ms ease',
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
      transition: 'transform 120ms ease, opacity 120ms ease',
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
      halo.style.opacity = '1'
      cursor.style.filter = 'drop-shadow(0 1px 2px rgb(0 0 0 / 50%)) brightness(0.92)'
    })
    window.addEventListener('mouseup', () => {
      halo.style.transform = 'translate(-50%, -50%) scale(1.35)'
      halo.style.opacity = '0.25'
      cursor.style.filter = 'drop-shadow(0 2px 3px rgb(0 0 0 / 45%))'
      window.setTimeout(() => {
        halo.style.transform = 'translate(-50%, -50%) scale(1)'
        halo.style.opacity = '1'
      }, 180)
    })
  })
})

const page = await context.newPage()
const video = page.video()
const startedAt = Date.now()

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
const until = async (elapsedMs) => {
  const remaining = startedAt + elapsedMs * TIME_SCALE - Date.now()
  if (remaining > 0) await sleep(remaining)
}
const gotoModule = async (path, heading) => {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.getByRole('heading', { name: heading, exact: true }).first().waitFor({ timeout: 60_000 })
}
const pointTo = async (locator, { click = false, pause = 260 } = {}) => {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error('Cannot point to an element without a visible bounding box.')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y, { steps: 24 })
  await sleep(pause)
  if (click) {
    // Let Playwright re-check actionability while keeping the visible pointer
    // movement above. This is more robust than dispatching raw mouse buttons
    // when a route transition or a lazy detail fetch is about to begin.
    await locator.click({ delay: 110 })
  }
}
const openModule = async (label, path, heading) => {
  const link = page.locator('aside nav[aria-label="Product modules"]').getByRole('link', {
    name: new RegExp(label, 'i'),
  })
  await pointTo(link, { click: true })
  await page.waitForURL((url) => url.pathname === path, { timeout: 60_000 })
  await page.getByRole('heading', { name: heading, exact: true }).first().waitFor({ timeout: 60_000 })
}
const waitForVerifiedPlan = async () => {
  await page.getByText('Robust priorities', { exact: true }).waitFor()
  await page.waitForFunction(() => {
    const labels = [...document.querySelectorAll('p')]
    const label = labels.find((node) => node.textContent?.trim() === 'Robust priorities')
    const value = label?.parentElement?.querySelector('.hpe-num')?.textContent?.trim()
    return value !== undefined && value !== '0'
  }, undefined, { timeout: 60_000 })
}

try {
  await gotoModule('/', 'Turn heat evidence into the next defensible field action.')
  await page.getByText('Real FortyGuard pilot').first().waitFor()
  await waitForVerifiedPlan()
  await page.mouse.move(720, 430, { steps: 12 })
  await until(5_000)
  await pointTo(page.getByText('Real FortyGuard pilot', { exact: true }).first())
  await until(12_000)
  await pointTo(page.getByText('Robust priorities', { exact: true }).first())
  await until(19_000)
  await pointTo(page.getByText('Conditional candidates', { exact: true }).first())
  await until(25_000)

  await openModule('Heat monitor', '/heat', 'Heat monitor')
  for (const [time, mark] of [['14:00', 31_000], ['20:00', 38_000], ['08:00', 45_000]]) {
    await until(mark)
    await pointTo(page.getByRole('tab', { name: time, exact: true }), { click: true })
  }
  await until(53_000)
  await pointTo(page.getByText('What can be claimed', { exact: true }))
  await until(58_000)

  await openModule('Priority planner', '/planner', 'Priority planner')
  const firstResult = page.getByTestId('result-row').first()
  await firstResult.waitFor({ timeout: 60_000 })
  await until(66_000)
  await pointTo(firstResult)
  await until(78_000)
  await pointTo(page.getByTestId('filter-selected'))
  await until(98_000)

  await openModule('Inspection missions', '/missions', 'Inspection missions')
  await until(101_000)
  await pointTo(page.getByRole('link', { name: 'Open mission' }).first(), { click: true })
  await until(105_000)
  await pointTo(page.getByRole('button', { name: 'Absent', exact: true }).first(), { click: true })
  await until(109_000)
  await pointTo(page.getByRole('button', { name: 'Submit demo observation' }), { click: true })
  await page.getByRole('heading', { name: 'Observation submitted' }).waitFor()
  await until(113_000)
  await pointTo(page.getByRole('link', { name: 'Review evidence' }), { click: true })
  await page.getByRole('heading', { name: 'Evidence review' }).waitFor()
  await until(117_000)
  await pointTo(page.getByRole('button', { name: 'Accept evidence' }), { click: true })
  await page.getByText('Plan v2').first().waitFor()
  await until(121_000)

  await openModule('Scenario lab', '/scenarios', 'Scenario lab')
  await until(124_000)
  await pointTo(page.getByText('Difference vs best baseline', { exact: true }))
  await until(128_000)
  await pointTo(page.getByText('Heat contribution', { exact: true }))
  await until(132_000)

  await openModule('Data & methodology', '/methodology', 'Methodology')
  await until(137_000)
  await page.mouse.wheel(0, 520)
  await until(141_000)

  await openModule('Reports & audit', '/reports', 'Reports & audit')
  await until(145_000)
  await pointTo(page.getByText('Package readiness', { exact: true }))
  await until(148_000)

  await openModule('Overview', '/', 'Turn heat evidence into the next defensible field action.')
  await waitForVerifiedPlan()
  await until(DURATION_MS)
} finally {
  await page.close()
  await context.close()
  await browser.close()
}

const recordedPath = await video.path()
await rename(recordedPath, RAW_VIDEO)
process.stdout.write(`${RAW_VIDEO}\n`)
