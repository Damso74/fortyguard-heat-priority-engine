/**
 * CSV writing with formula-injection protection.
 *
 * Exports from this product are opened in Excel, Numbers and Google Sheets by
 * the people who use them. A stop named `=cmd|...` in an upstream feed would
 * otherwise become an executable formula on someone else's machine, so any cell
 * beginning with a formula trigger is prefixed with an apostrophe before the
 * normal RFC 4180 quoting is applied.
 */

const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r']

export function sanitizeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'string' ? value : String(value)

  // Strip the control characters that would corrupt the row structure. Tab, CR
  // and LF are deliberately preserved: the RFC 4180 quoting below handles them,
  // and a genuine newline inside a stop description should survive as one.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')

  const first = text.charAt(0)
  if (first && FORMULA_TRIGGERS.includes(first)) {
    // A leading apostrophe is the conventional, portable neutraliser. Numbers
    // are exempted so `-3.5` stays numeric.
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      text = `'${text}`
    }
  }
  return text
}

export function escapeCsvCell(value: unknown): string {
  const text = sanitizeCsvValue(value)
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function toCsv(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns?: readonly string[],
): string {
  const headers = columns ?? (rows[0] ? Object.keys(rows[0]) : [])
  const lines: string[] = [headers.map(escapeCsvCell).join(',')]
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCsvCell(row[header])).join(','))
  }
  // CRLF per RFC 4180; a trailing newline keeps POSIX tools happy.
  return `${lines.join('\r\n')}\r\n`
}

/** Prepend `# key: value` comment lines carrying run provenance. */
export function withCsvPreamble(csv: string, preamble: Record<string, unknown>): string {
  const lines = Object.entries(preamble).map(
    ([key, value]) => `# ${key}: ${sanitizeCsvValue(value).replace(/[\r\n]+/g, ' ')}`,
  )
  return `${lines.join('\r\n')}\r\n${csv}`
}
