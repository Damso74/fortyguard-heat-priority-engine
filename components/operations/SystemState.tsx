export function SystemState({
  code,
  title,
  description,
  actions,
  alert = false,
}: {
  code: string
  title: string
  description: string
  actions: React.ReactNode
  alert?: boolean
}) {
  return (
    <section
      className="hpe-card mx-auto max-w-2xl overflow-hidden"
      role={alert ? 'alert' : undefined}
      aria-live={alert ? 'assertive' : undefined}
    >
      <div className="border-b border-ink-100 bg-ink-900 px-6 py-5 text-white sm:px-8">
        <p className="text-[12px] font-bold uppercase tracking-[0.14em] text-slate-300">{code}</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">{title}</h1>
      </div>
      <div className="p-6 sm:p-8">
        <p className="max-w-xl text-[14px] leading-6 text-ink-600">{description}</p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">{actions}</div>
      </div>
    </section>
  )
}
