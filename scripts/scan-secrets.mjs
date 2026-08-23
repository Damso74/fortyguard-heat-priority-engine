#!/usr/bin/env node
/**
 * Repository secret scan.
 *
 * Runs as part of `npm run verify`, so a key cannot be committed without the
 * verification step going red. It looks for two things:
 *
 * 1. high-signal credential patterns in tracked source files;
 * 2. any `.env` file other than `.env.example` sitting in the working tree.
 *
 * Deliberately narrow: a scanner that cries wolf gets disabled, and a disabled
 * scanner is worse than none.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  'out',
  'coverage',
  'playwright-report',
  'test-results',
  '__pycache__',
  '.venv',
  'venv',
  'pids',
  '.vercel',
])

const SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.py', '.yml', '.yaml', '.env', '.txt', '.css',
])

/** Files whose whole purpose is to talk about secrets. */
const ALLOWLIST = new Set([
  'scripts/scan-secrets.mjs',
  'lib/fortyguard/redact.ts',
  'tests/unit/security-and-audit.test.ts',
  'tests/integration/fortyguard-client.test.ts',
  'docs/fortyguard-integration.md',
  '.env.example',
])

const PATTERNS = [
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { name: 'Stripe secret key', re: /\bsk_live_[0-9A-Za-z]{16,}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'Mapbox token', re: /\bpk\.eyJ[0-9A-Za-z._-]{20,}/ },
  {
    name: 'assigned FortyGuard key',
    // FORTYGUARD_API_KEY=<something non-empty and not a placeholder>
    re: /FORTYGUARD_API_KEY\s*[=:]\s*["']?(?!\s*$|["']\s*$|\$\{|your_|<|\.\.\.)[A-Za-z0-9_-]{12,}/,
  },
  {
    name: 'hard-coded bearer credential',
    re: /["']Bearer\s+[A-Za-z0-9._~+/-]{20,}["']/,
  },
]

function walk(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(directory, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      walk(full, files)
    } else if (stats.isFile()) {
      const dot = entry.lastIndexOf('.')
      const extension = dot >= 0 ? entry.slice(dot) : ''
      // Always scan dotfiles named like env files even without an extension.
      if (SCAN_EXTENSIONS.has(extension) || entry.startsWith('.env')) {
        if (stats.size <= 4 * 1024 * 1024) files.push(full)
      }
    }
  }
  return files
}

const findings = []

/* --- 1. committed env files ------------------------------------------------ */
for (const entry of readdirSync(ROOT)) {
  if (entry.startsWith('.env') && entry !== '.env.example') {
    findings.push({
      file: entry,
      line: 0,
      rule: 'env file present',
      detail: `${entry} exists in the working tree. It is gitignored, but confirm it was never committed.`,
      fatal: false,
    })
  }
}

/* --- 2. credential patterns ----------------------------------------------- */
for (const file of walk(ROOT)) {
  const relativePath = relative(ROOT, file).split(sep).join('/')
  if (ALLOWLIST.has(relativePath)) continue
  if (relativePath.startsWith('.env') && relativePath !== '.env.example') continue

  let content
  try {
    content = readFileSync(file, 'utf-8')
  } catch {
    continue
  }
  const lines = content.split(/\r?\n/)
  for (const pattern of PATTERNS) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (pattern.re.test(line)) {
        findings.push({
          file: relativePath,
          line: index + 1,
          rule: pattern.name,
          detail: line.trim().slice(0, 120),
          fatal: true,
        })
      }
    }
  }
}

/* --- 3. client-bundle guard ------------------------------------------------ */
const nextDir = join(ROOT, '.next')
if (existsSync(nextDir)) {
  const staticDir = join(nextDir, 'static')
  if (existsSync(staticDir)) {
    for (const file of walk(staticDir)) {
      const content = readFileSync(file, 'utf-8')
      if (/FORTYGUARD_API_KEY/.test(content)) {
        findings.push({
          file: relative(ROOT, file).split(sep).join('/'),
          line: 0,
          rule: 'server secret name in client bundle',
          detail: 'FORTYGUARD_API_KEY appears in a browser-served asset.',
          fatal: true,
        })
      }
    }
  }
}

const fatal = findings.filter((finding) => finding.fatal)

if (findings.length === 0) {
  console.log('secret scan: clean')
  process.exit(0)
}

for (const finding of findings) {
  const marker = finding.fatal ? 'FAIL' : 'warn'
  console.log(`${marker}  ${finding.file}:${finding.line}  [${finding.rule}]  ${finding.detail}`)
}

if (fatal.length > 0) {
  console.error(`\nsecret scan: ${fatal.length} blocking finding(s)`)
  process.exit(1)
}
console.log('\nsecret scan: no blocking findings')
process.exit(0)
