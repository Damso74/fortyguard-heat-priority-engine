import { mkdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const BASE_URL = process.env.DEMO_URL ?? 'https://heat-priority-engine.vercel.app'
const OUTPUT_DIR = resolve(process.cwd(), 'outputs', 'submission-video')
const RAW_VIDEO = join(OUTPUT_DIR, process.env.WALKTHROUGH_FILE ?? 'walkthrough-jury-v3.webm')
const DURATION_MS = Number(process.env.DEMO_DURATION_MS ?? '163000')

if (!Number.isFinite(DURATION_MS) || DURATION_MS < 150_000 || DURATION_MS > 179_000) {
  throw new Error('DEMO_DURATION_MS must be between 150000 and 179000.')
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
    })
    window.addEventListener('mouseup', () => {
      halo.style.transform = 'translate(-50%, -50%) scale(1.35)'
      halo.style.opacity = '0.25'
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
  const remaining = startedAt + elapsedMs - Date.now()
  if (remaining > 0) await sleep(remaining)
}
const gotoModule = async (path, heading) => {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.getByRole('heading', { name: heading, exact: true }).first().waitFor({ timeout: 60_000 })
}
const pointTo = async (locator, { click = false, pause = 240 } = {}) => {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error('Cannot point to an element without a visible bounding box.')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 })
  await sleep(pause)
  if (click) await locator.click({ delay: 100 })
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
    const label = [...document.querySelectorAll('p')]
      .find((node) => node.textContent?.trim() === 'Robust priorities')
    const value = label?.parentElement?.querySelector('.hpe-num')?.textContent?.trim()
    return value !== undefined && value !== '0'
  }, undefined, { timeout: 60_000 })
}

try {
  await gotoModule('/', 'Turn heat evidence into the next defensible field action.')
  await page.getByText('Real FortyGuard pilot').first().waitFor()
  await waitForVerifiedPlan()
  await until(2_000)
  await pointTo(page.getByRole('heading', { name: 'Turn heat evidence into the next defensible field action.' }))
  await until(12_000)
  await pointTo(page.getByText('Real FortyGuard pilot', { exact: true }).first())
  await until(24_000)
  await pointTo(page.getByText('Robust priorities', { exact: true }).first())
  await until(37_000)
  await pointTo(page.getByRole('heading', { name: 'Turn heat evidence into the next defensible field action.' }))

  await until(45_000)
  await openModule('Heat monitor', '/heat', 'Heat monitor')
  await until(50_000)
  await pointTo(page.getByRole('tab', { name: '08:00', exact: true }))
  await until(56_000)
  await pointTo(page.getByRole('tab', { name: '14:00', exact: true }), { click: true })
  await until(62_000)
  await pointTo(page.getByRole('tab', { name: '20:00', exact: true }), { click: true })
  await until(68_000)
  await pointTo(page.getByText('What can be claimed', { exact: true }))

  await until(78_000)
  await openModule('Priority planner', '/planner', 'Priority planner')
  const firstResult = page.getByTestId('result-row').first()
  await firstResult.waitFor({ timeout: 60_000 })
  await until(82_000)
  await pointTo(page.getByTestId('result-headline'))
  await until(87_000)
  await pointTo(page.getByTestId('capacity-20'), { click: true })
  await page.waitForFunction(() => {
    const headline = document.querySelector('[data-testid="result-headline"]')?.textContent ?? ''
    const counts = [...headline.matchAll(/\d+/g)].map((match) => Number(match[0]))
    return counts.length >= 2 && counts[0] + counts[1] === 20
  }, undefined, { timeout: 60_000 })
  await until(92_000)
  await pointTo(page.getByTestId('result-headline'))

  await until(97_000)
  await openModule('Inspection missions', '/missions', 'Inspection missions')
  await until(99_000)
  await pointTo(page.getByRole('link', { name: 'Open mission' }).first(), { click: true })
  await until(103_000)
  await pointTo(page.getByRole('button', { name: 'Absent', exact: true }).first(), { click: true })
  await until(107_000)
  await pointTo(page.getByRole('button', { name: 'Submit demo observation' }), { click: true })
  await page.getByRole('heading', { name: 'Observation submitted' }).waitFor()
  await until(111_000)
  await pointTo(page.getByRole('link', { name: 'Review evidence' }), { click: true })
  await page.getByRole('heading', { name: 'Evidence review' }).waitFor()
  await until(115_000)
  await pointTo(page.getByRole('button', { name: 'Accept evidence' }), { click: true })
  await page.getByText('Plan v2').first().waitFor()

  await until(118_000)
  await openModule('Scenario lab', '/scenarios', 'Scenario lab')
  await until(121_000)
  await pointTo(page.getByText('Difference vs best baseline', { exact: true }))
  await until(126_000)
  await pointTo(page.getByText('Heat contribution', { exact: true }))

  await until(130_000)
  await openModule('Reports & audit', '/reports', 'Reports & audit')
  await until(134_000)
  await pointTo(page.getByText('Package readiness', { exact: true }))
  await until(140_000)
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
