'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { BrandMark } from '@/components/Brand'
import { useOperations } from '@/components/operations/OperationsProvider'

interface NavigationLink {
  href: string
  label: string
  shortLabel: string
  mark: string
  description: string
}

interface NavigationSection {
  label: string
  links: NavigationLink[]
}

const NAVIGATION: NavigationSection[] = [
  {
    label: 'Plan & prioritize',
    links: [
      { href: '/', label: 'Overview', shortLabel: 'Overview', mark: '01', description: 'Readiness and next action' },
      { href: '/heat', label: 'Heat monitor', shortLabel: 'Heat', mark: '02', description: 'Evidence by stored hour' },
      { href: '/planner', label: 'Priority planner', shortLabel: 'Plan', mark: '03', description: 'Ranked stops and uncertainty' },
    ],
  },
  {
    label: 'Inspect & validate',
    links: [
      { href: '/missions', label: 'Inspection missions', shortLabel: 'Inspect', mark: '04', description: 'Assign and complete checks' },
      { href: '/evidence', label: 'Evidence review', shortLabel: 'Review', mark: '05', description: 'Accept or reject observations' },
    ],
  },
  {
    label: 'Govern & document',
    links: [
      { href: '/scenarios', label: 'Scenario lab', shortLabel: 'Scenarios', mark: '06', description: 'Compare capacity and baselines' },
      { href: '/reports', label: 'Reports & audit', shortLabel: 'Reports', mark: '07', description: 'Export an auditable decision' },
      { href: '/methodology', label: 'Data & methodology', shortLabel: 'Methods', mark: '08', description: 'Sources, assumptions and claims' },
    ],
  },
]

const MOBILE_PRIMARY_HREFS = new Set(['/heat', '/planner', '/missions', '/evidence'])
const ALL_LINKS = NAVIGATION.flatMap((section) => section.links)
const MOBILE_PRIMARY_LINKS = ALL_LINKS.filter((link) => MOBILE_PRIMARY_HREFS.has(link.href))
const MOBILE_MORE_LINKS = ALL_LINKS.filter((link) => !MOBILE_PRIMARY_HREFS.has(link.href))

function NavLinks({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname()
  const [moreOpen, setMoreOpen] = useState(false)

  if (compact) {
    const moreActive = MOBILE_MORE_LINKS.some((link) => pathname === link.href)

    return (
      <nav aria-label="Product modules" className="relative grid grid-cols-5 gap-1 border-b border-ink-200 bg-white px-2 py-2 lg:hidden">
        {MOBILE_PRIMARY_LINKS.map((link) => {
          const active = pathname === link.href
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-label={link.label}
              aria-current={active ? 'page' : undefined}
              className={`rounded-md px-1 py-2 text-center text-[11px] font-semibold ${
                active ? 'bg-brand-600 text-white' : 'bg-ink-50 text-ink-700'
              }`}
            >
              <span aria-hidden="true" className="block text-[9px] opacity-65">{link.mark}</span>
              <span aria-hidden="true">{link.shortLabel}</span>
            </Link>
          )
        })}
        <div className="static">
          <button
            type="button"
            aria-label="More modules"
            aria-expanded={moreOpen}
            aria-controls="mobile-more-modules"
            onClick={() => setMoreOpen((open) => !open)}
            className={`flex h-full w-full flex-col items-center justify-center rounded-md px-1 py-2 text-[11px] font-semibold ${
              moreActive ? 'bg-brand-600 text-white' : 'bg-ink-50 text-ink-700'
            }`}
          >
            <span aria-hidden="true" className="text-[9px] opacity-65">•••</span>
            More
          </button>
          {moreOpen ? (
            <div id="mobile-more-modules" className="absolute inset-x-2 top-[calc(100%-0.25rem)] z-40 grid gap-1 rounded-lg border border-ink-200 bg-white p-2 shadow-xl">
              {MOBILE_MORE_LINKS.map((link) => {
                const active = pathname === link.href
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setMoreOpen(false)}
                    className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-[12px] font-semibold ${
                      active ? 'bg-brand-50 text-brand-700' : 'text-ink-700 hover:bg-ink-50'
                    }`}
                  >
                    <span aria-hidden="true" className="text-[10px] text-ink-400">{link.mark}</span>
                    {link.label}
                  </Link>
                )
              })}
            </div>
          ) : null}
        </div>
      </nav>
    )
  }

  return (
    <nav aria-label="Product modules" className="mt-6 space-y-5">
      {NAVIGATION.map((section) => (
        <section key={section.label}>
          <h2 className="px-3 text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400">
            {section.label}
          </h2>
          <div className="mt-2 space-y-1">
            {section.links.map((link) => {
              const active = pathname === link.href
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-start gap-3 rounded-lg px-3 py-2.5 text-[13px] font-semibold transition-colors ${
                    active
                      ? 'bg-white/12 text-white ring-1 ring-inset ring-white/10'
                      : 'text-slate-300 hover:bg-white/7 hover:text-white'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`grid h-7 w-7 place-items-center rounded-md border text-[9px] font-bold tracking-tight ${
                      active
                        ? 'border-orange-300/50 bg-orange-400/15 text-orange-200'
                        : 'border-white/10 bg-white/5 text-slate-400'
                    }`}
                  >
                    {link.mark}
                  </span>
                  <span className="min-w-0 pt-0.5">
                    <span className="block leading-tight">{link.label}</span>
                    {active ? (
                      <span className="mt-1 block text-[11px] font-normal leading-snug text-slate-300">
                        {link.description}
                      </span>
                    ) : null}
                  </span>
                </Link>
              )
            })}
          </div>
        </section>
      ))}
    </nav>
  )
}

export function CivicShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { run, loading, defaults, planVersion } = useOperations()
  const planner = pathname === '/planner'
  const snapshotTimes = run?.request.snapshotTimes ?? defaults.snapshotTimes
  const dataLabel = run?.manifest.dataMode === 'CACHED_REAL_DATA' ? 'Stored real FortyGuard response' : run?.manifest.dataMode === 'LIVE_FORTYGUARD' ? 'Live FortyGuard response' : 'Verified pilot loading'

  return (
    <div className="min-h-dvh bg-[#f5f7fa] lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="relative hidden h-dvh flex-col border-r border-white/5 bg-[#0b1828] px-3 py-4 text-white lg:sticky lg:top-0 lg:flex">
        <Link href="/" className="flex items-center gap-3 px-2" aria-label="Heat Priority Engine overview">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-white shadow-sm">
            <BrandMark className="h-8 w-8" title="Independent Phoenix heat-operations pilot" />
          </span>
          <span>
            <span className="block text-[14px] font-bold tracking-tight">Heat Priority Engine</span>
            <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
              Independent pilot · Phoenix, Arizona
            </span>
          </span>
        </Link>

        <div className="mt-5 rounded-lg border border-white/10 bg-white/5 px-3 py-2.5">
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-400">Workspace</p>
          <p className="mt-1 text-[12px] font-semibold text-slate-100">Transit heat operations</p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">Independent decision-support pilot</p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          <NavLinks />
        </div>

        <div className="mt-auto rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="flex items-center gap-2 text-[11px] font-semibold text-emerald-200">
            <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden="true" />
            Verified pilot available
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
            No City of Phoenix or Valley Metro endorsement is claimed.
          </p>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="border-b border-ink-200 bg-white">
          <div className="flex min-h-14 items-center gap-3 px-4 sm:px-6">
            <div className="flex items-center gap-2 lg:hidden">
              <BrandMark className="h-8 w-8" title="Independent Phoenix heat-operations pilot" />
              <span>
                <span className="block text-[13px] font-bold leading-tight text-ink-900">Heat Priority Engine</span>
                <span className="block text-[8px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                  Independent pilot · Phoenix, Arizona
                </span>
              </span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <span className="rounded-full border border-ink-200 bg-ink-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-ink-700">
                Plan v{planVersion}
              </span>
              <span className="hidden rounded-full border border-brand-500/25 bg-brand-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-brand-700 sm:inline-flex">
                {loading ? 'Loading verified run' : dataLabel}
              </span>
            </div>
          </div>
          <NavLinks compact />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-ink-100 bg-[#fbfcfd] px-4 py-2 text-[11px] text-ink-600 sm:px-6">
            <strong className="text-ink-900">Downtown Phoenix</strong>
            <span>{run?.request.analysisDate ?? defaults.analysisDate}</span>
            <span>{snapshotTimes.join(' · ')}</span>
            <span>America/Phoenix</span>
            <span>°F display · °C source</span>
            {run?.manifest.mode === 'EXPOSURE_ONLY' && (
              <span className="rounded-full border border-flag-700/20 bg-flag-100 px-2 py-0.5 font-bold text-flag-700">Exposure-only · no persistent hotspot claim</span>
            )}
          </div>
        </header>

        <main id="main" className={planner ? 'min-h-[calc(100dvh-96px)]' : 'mx-auto w-full max-w-[1480px] px-4 py-5 sm:px-6 sm:py-7'}>
          {children}
        </main>
      </div>
    </div>
  )
}
