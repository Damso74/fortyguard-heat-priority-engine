import Link from 'next/link'

export default function NotFound() {
  return (
    <section className="hpe-card mx-auto max-w-xl p-8 text-center">
      <p className="hpe-label">404</p>
      <h1 className="mt-2 text-xl font-bold text-ink-900">Module not found</h1>
      <p className="mt-2 text-[13px] text-ink-600">This route is not part of the verified operational workflow.</p>
      <Link href="/" className="mt-5 inline-flex rounded-md bg-brand-600 px-4 py-2 text-[12px] font-semibold text-white">Return to Overview</Link>
    </section>
  )
}
