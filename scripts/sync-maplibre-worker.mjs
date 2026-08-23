#!/usr/bin/env node
/**
 * Copy MapLibre's worker script where the browser can actually fetch it.
 *
 * MapLibre resolves its worker as `new URL('./maplibre-gl-worker.mjs',
 * import.meta.url)`. Under the Next bundler, `import.meta.url` points at a
 * generated chunk, so that URL 404s — the worker pool never starts, and every
 * GeoJSON source (the heat cells, the stops) stays silently empty while raster
 * basemap tiles, which never touch a worker, render fine. The map looked alive
 * and carried no data.
 *
 * The fix is `maplibre.setWorkerUrl('/maplibre-gl-worker.mjs')` in the map
 * component, which needs the file to exist under public/. Copying at predev /
 * prebuild keeps it in lockstep with the installed maplibre-gl version instead
 * of trusting a committed copy to be updated by hand.
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'node_modules', 'maplibre-gl', 'dist')

// The worker imports `./maplibre-gl-shared.mjs`, so both files must sit next
// to each other under public/ or the worker dies on its own first import.
const FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']

mkdirSync(join(root, 'public'), { recursive: true })
for (const file of FILES) {
  copyFileSync(join(dist, file), join(root, 'public', file))
}
process.stdout.write(`maplibre worker synced to public/ (${FILES.join(', ')})\n`)
