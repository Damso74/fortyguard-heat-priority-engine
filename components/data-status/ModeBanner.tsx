import type { DataMode } from '@/lib/types'

/**
 * Permanent, non-dismissible banner for any run whose numbers are not live
 * measurements. Deliberately not a tooltip and not a toast: someone reading a
 * screenshot of this screen must be able to see what the numbers are. One
 * line — the honesty must be unmissable, not dominant.
 */
export function ModeBanner({ dataMode }: { dataMode: DataMode | null }) {
  // `null` means no run yet, which is not the same as a live one. This used to
  // receive `LIVE_FORTYGUARD` inferred from the environment before any analysis
  // had run — the single value that renders nothing — so a key and a flag were
  // enough to remove the honesty banner from a page showing no data at all.
  if (dataMode === null) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="mode-banner"
        className="border-b border-ink-300 bg-ink-50 px-4 py-1.5 text-ink-700 sm:px-6"
      >
        <div className="mx-auto flex max-w-[1600px] flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
          <span className="shrink-0 text-xs font-bold uppercase tracking-wider">No data yet</span>
          <p className="text-[12px] leading-snug">
            Nothing has been analysed. Whether the thermal layer is a measurement or a labelled
            synthetic fixture is a property of a run, and this page has not made one.
          </p>
        </div>
      </div>
    )
  }

  if (dataMode === 'LIVE_FORTYGUARD') return null

  const synthetic = dataMode === 'DEMO_SYNTHETIC'
  const cached = dataMode === 'CACHED_REAL_DATA'

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="mode-banner"
      className={`border-b px-4 py-1.5 sm:px-6 ${
        synthetic
          ? 'border-flag-700/25 bg-flag-100 text-flag-700'
          : cached
            ? 'border-brand-500/25 bg-brand-100 text-brand-700'
            : 'border-stop-700/25 bg-stop-100 text-stop-700'
      }`}
    >
      <div className="mx-auto flex max-w-[1600px] flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
        <span className="shrink-0 text-xs font-bold uppercase tracking-wider">
          {synthetic
            ? 'Demo — synthetic data'
            : cached
              ? 'Verified measurements'
              : 'Live path blocked'}
        </span>
        <p className="text-[12px] leading-snug">
          {synthetic
            ? 'No FortyGuard measurement produced any heat value on this screen — the thermal layer is a labelled synthetic fixture, and rankings demonstrate the method, not a finding about Phoenix.'
            : cached
              ? 'Stored FortyGuard measurements from completed Phoenix activities.'
              : 'The live FortyGuard path has not been executed on this run.'}
        </p>
      </div>
    </div>
  )
}
