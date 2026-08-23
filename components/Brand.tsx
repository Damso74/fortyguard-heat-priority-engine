/**
 * An original Phoenix pilot mark, kept as inline SVG so it stays sharp and
 * loads with the DOM. The rising sun, abstract skyline and transit line locate
 * the work without copying the City of Phoenix bird, seal or corporate mark.
 * Colours are existing product tokens.
 */
export function BrandMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title ? <title>{title}</title> : null}
      {/* desert sun and restrained rays */}
      <circle cx="11" cy="11" r="5.5" fill="#dd6b2c" />
      <path
        d="M11 2.5v2M3.9 5.1l1.5 1.4M2 12h2M18.1 5.1l-1.5 1.4"
        fill="none"
        stroke="#dd6b2c"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      {/* abstract skyline: deliberately not a municipal symbol */}
      <path
        d="M4 26V18h5v3h4v-6h5v4h4v-9h5v6h5v10H4Z"
        fill="#10151c"
      />
      <path d="M7 21h2M15 18h2M24 14h2M28 20h2" stroke="#ffffff" strokeWidth="1.2" />
      {/* transit line and inspection stops */}
      <path d="M3 32h34" stroke="#17627f" strokeWidth="2" strokeLinecap="round" />
      <circle cx="9" cy="32" r="2" fill="#ffffff" stroke="#17627f" strokeWidth="1.4" />
      <circle cx="20" cy="32" r="2" fill="#ffffff" stroke="#17627f" strokeWidth="1.4" />
      <circle cx="32" cy="32" r="3.4" fill="#ffffff" stroke="#dd6b2c" strokeWidth="1.8" />
      <circle cx="32" cy="32" r="1.5" fill="#10151c" />
    </svg>
  )
}
