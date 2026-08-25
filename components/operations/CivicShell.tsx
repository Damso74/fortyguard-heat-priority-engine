'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { BrandMark } from '@/components/Brand'

interface NavigationLink {
  href: string
  label: string
  description: string
}

const PRIMARY_LINKS: NavigationLink[] = [
  { href: '/', label: 'Overview', description: 'Result and next action' },
  { href: '/planner', label: 'Priority map', description: 'Ranked stops on the heat map' },
  { href: '/missions', label: 'Missions', description: 'Field inspection queue' },
  { href: '/reports', label: 'Audit', description: 'Decision brief and trace' },
]

const SECONDARY_LINKS: NavigationLink[] = [
  { href: '/heat', label: 'Heat measurements', description: 'Stored temperature snapshots' },
  { href: '/ridership', label: 'Transit use', description: 'Published Valley Metro ridership' },
  { href: '/evidence', label: 'Field reviews', description: 'Accept or return observations' },
  { href: '/scenarios', label: 'Stress test', description: 'See what changes with assumptions' },
  { href: '/methodology', label: 'Methods & limits', description: 'Sources, rules and claim boundary' },
]

function isRouteActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)
}

function MobileNavigation() {
  const pathname = usePathname()
  const [moreOpen, setMoreOpen] = useState(false)
  const navRef = useRef<HTMLElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const secondaryActive = SECONDARY_LINKS.some((link) => isRouteActive(pathname, link.href))

  useEffect(() => setMoreOpen(false), [pathname])

  useEffect(() => {
    if (!moreOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMoreOpen(false)
        window.requestAnimationFrame(() => moreButtonRef.current?.focus())
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [moreOpen])

  return (
    <nav ref={navRef} aria-label="Primary navigation" className="relative grid grid-cols-5 gap-1 border-t border-ink-100 bg-white px-2 py-2 xl:hidden">
      {PRIMARY_LINKS.map((link) => {
        const active = isRouteActive(pathname, link.href)
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={`grid min-h-11 place-items-center rounded-lg px-1 text-center text-[11px] font-semibold ${active ? 'bg-brand-600 text-white' : 'text-ink-600 hover:bg-ink-50'}`}
          >
            {link.label}
          </Link>
        )
      })}
      <button
        ref={moreButtonRef}
        type="button"
        aria-expanded={moreOpen}
        aria-controls="mobile-secondary-navigation"
        onClick={() => setMoreOpen((current) => !current)}
        className={`min-h-11 rounded-lg px-1 text-[11px] font-semibold ${secondaryActive || moreOpen ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'}`}
      >
        More
      </button>
      {moreOpen ? (
        <div id="mobile-secondary-navigation" className="absolute inset-x-2 top-[calc(100%-0.25rem)] z-50 grid gap-1 rounded-xl border border-ink-200 bg-white p-2 shadow-xl">
          {SECONDARY_LINKS.map((link) => {
            const active = isRouteActive(pathname, link.href)
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-12 items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px] font-semibold ${active ? 'bg-brand-50 text-brand-700' : 'text-ink-700 hover:bg-ink-50'}`}
              >
                <span><span className="block">{link.label}</span><span className="mt-0.5 block text-[11px] font-normal text-ink-500">{link.description}</span></span>
                <span aria-hidden="true">→</span>
              </Link>
            )
          })}
        </div>
      ) : null}
    </nav>
  )
}

function DesktopNavigation() {
  const pathname = usePathname()
  const secondaryActive = SECONDARY_LINKS.some((link) => isRouteActive(pathname, link.href))

  return (
    <nav aria-label="Product navigation" className="mt-7 min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-1">
        {PRIMARY_LINKS.map((link) => {
          const active = isRouteActive(pathname, link.href)
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? 'page' : undefined}
              className={`block rounded-lg px-3 py-3 transition-colors ${active ? 'bg-white/12 text-white ring-1 ring-inset ring-white/10' : 'text-slate-300 hover:bg-white/7 hover:text-white'}`}
            >
              <span className="block text-[13px] font-semibold">{link.label}</span>
              {active ? <span className="mt-1 block text-[11px] leading-snug text-slate-300">{link.description}</span> : null}
            </Link>
          )
        })}
      </div>

      <details className="mt-6 border-t border-white/10 pt-4" open={secondaryActive || undefined}>
        <summary className="min-h-11 cursor-pointer rounded-lg px-3 py-3 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-300 hover:bg-white/7 hover:text-white">
          Explore data
        </summary>
        <div className="mt-1 space-y-1">
          {SECONDARY_LINKS.map((link) => {
            const active = isRouteActive(pathname, link.href)
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`block rounded-lg px-3 py-2.5 text-[12px] font-semibold ${active ? 'bg-white/12 text-white' : 'text-slate-300 hover:bg-white/7 hover:text-white'}`}
              >
                {link.label}
              </Link>
            )
          })}
        </div>
      </details>
    </nav>
  )
}

export function CivicShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const immersive = pathname === '/planner' || pathname === '/heat'

  return (
    <div className="min-h-dvh bg-ink-50 xl:grid xl:grid-cols-[232px_minmax(0,1fr)]">
      <aside className="hpe-no-print relative hidden h-dvh flex-col border-r border-white/5 bg-ink-900 px-3 py-4 text-white xl:sticky xl:top-0 xl:flex">
        <Link href="/" className="flex items-center gap-3 px-2" aria-label="Heat Priority Engine overview">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-white shadow-sm">
            <BrandMark className="h-8 w-8" title="Independent Phoenix heat-operations pilot" />
          </span>
          <span>
            <span className="block text-[14px] font-bold tracking-tight">Heat Priority Engine</span>
            <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">Phoenix pilot</span>
          </span>
        </Link>

        <DesktopNavigation />

        <Link href="/methodology" className="mt-auto flex items-center gap-2 rounded-lg px-3 py-2 text-[11px] text-slate-300 hover:bg-white/7 hover:text-white">
          <span className="h-2 w-2 rounded-full bg-ok-700" aria-hidden="true" />
          Verified pilot data
        </Link>
      </aside>

      <div className="min-w-0">
        <header className="hpe-no-print border-b border-ink-200 bg-white xl:hidden">
          <div className="flex min-h-14 items-center gap-3 px-4 sm:px-6">
            <Link href="/" className="flex items-center gap-2" aria-label="Heat Priority Engine overview">
              <BrandMark className="h-8 w-8" title="Independent Phoenix heat-operations pilot" />
              <span><span className="block text-[13px] font-bold leading-tight text-ink-900">Heat Priority Engine</span><span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-500">Phoenix pilot</span></span>
            </Link>
            <Link href="/methodology" className="ml-auto flex min-h-11 items-center gap-2 text-[10px] font-semibold text-ink-600">
              <span className="h-2 w-2 rounded-full bg-ok-700" aria-hidden="true" />
              Verified data
            </Link>
          </div>
          <MobileNavigation />
        </header>

        <main id="main" className={immersive ? 'min-h-dvh' : 'mx-auto w-full max-w-[1480px] px-4 py-5 sm:px-6 sm:py-7'}>
          {children}
        </main>
      </div>
    </div>
  )
}
