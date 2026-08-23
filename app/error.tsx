'use client'

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="hpe-card mx-auto max-w-xl p-6 text-center" role="alert">
      <p className="text-lg font-bold text-ink-900">This module could not be displayed.</p>
      <p className="mt-2 text-[13px] text-ink-600">The verified pilot remains unchanged. Retry the view or return to Overview.</p>
      <button type="button" onClick={reset} className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-[12px] font-semibold text-white">Retry module</button>
    </section>
  )
}
