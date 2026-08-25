export function ModuleHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string
  title: string
  description: string
  actions?: React.ReactNode
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-brand-700">{eyebrow}</p>
        <h1 className="mt-1 text-[26px] font-bold leading-[32px] tracking-[-0.025em] text-ink-900">{title}</h1>
        <p className="mt-1.5 max-w-2xl text-[13px] leading-5 text-ink-600">{description}</p>
      </div>
      {actions && (
        <div className="hpe-no-print flex w-full shrink-0 flex-wrap items-center gap-2 [&>*]:inline-flex [&>*]:flex-1 [&>*]:justify-center sm:w-auto sm:[&>*]:flex-none">
          {actions}
        </div>
      )}
    </header>
  )
}

export function EvidencePill({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'real' | 'verified' | 'warn' | 'blocked' | 'demo'
}) {
  const className = {
    neutral: 'border-ink-200 bg-ink-50 text-ink-700',
    real: 'border-brand-500/25 bg-brand-50 text-brand-700',
    verified: 'border-ok-700/25 bg-ok-100 text-ok-700',
    warn: 'border-flag-700/25 bg-flag-100 text-flag-700',
    blocked: 'border-stop-700/25 bg-stop-100 text-stop-700',
    demo: 'border-ink-200 bg-ink-50 text-ink-700',
  }[tone]
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold leading-[14px] ${className}`}>
      {children}
    </span>
  )
}
