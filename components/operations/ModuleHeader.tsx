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
      <div>
        <p className="hpe-label text-brand-700">{eyebrow}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">{title}</h1>
        <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-ink-600">{description}</p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
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
    demo: 'border-violet-400/30 bg-violet-50 text-violet-800',
  }[tone]
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.1em] ${className}`}>
      {children}
    </span>
  )
}
