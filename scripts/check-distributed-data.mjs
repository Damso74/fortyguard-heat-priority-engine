#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const tracked = new Set(
  execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf-8' })
    .split(/\r?\n/)
    .filter(Boolean),
)

const provenance = json('data/manifests/source-provenance.json')
const generated = json('data/manifests/generated-dataset.json')
const retainedKeys = ['valley_metro_phoenix_stops', 'valley_metro_phoenix_stops_2023']
const excludedKeys = ['phoenix_bus_stops', 'valley_metro_quarterly_ridership']

for (const key of retainedKeys) {
  const source = provenance.sources.find((entry) => entry.key === key)
  if (!source) throw new Error(`Missing provenance entry: ${key}`)
  if (!tracked.has(source.artifact.path)) {
    throw new Error(`Licensed source is not tracked: ${source.artifact.path}`)
  }
  assertHash(source.artifact.path, source.artifact.sha256)
}

for (const key of excludedKeys) {
  const source = provenance.sources.find((entry) => entry.key === key)
  if (!source) throw new Error(`Missing provenance entry: ${key}`)
  if (tracked.has(source.artifact.path)) {
    throw new Error(`Unlicensed raw extract is still tracked: ${source.artifact.path}`)
  }
  const derivation = generated.derivedFrom.find((entry) => entry.path === source.artifact.path)
  if (derivation?.sha256 !== source.artifact.sha256) {
    throw new Error(`Historical input hash is inconsistent: ${source.artifact.path}`)
  }
}

assertHash(generated.artifact.path, generated.artifact.sha256)
process.stdout.write(
  'Distributed data is internally consistent: 2 licensed ArcGIS extracts retained, ' +
    '2 unresolved raw extracts excluded, generated artefact hash verified.\n',
)

function json(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf-8'))
}

function assertHash(relativePath, expected) {
  const digest = createHash('sha256')
    .update(readFileSync(resolve(root, relativePath)))
    .digest('hex')
  if (digest !== expected) {
    throw new Error(`Hash mismatch for ${relativePath}: expected ${expected}, got ${digest}`)
  }
}
