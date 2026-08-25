'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { BoundingBox, Quadrant } from '@/lib/types'
import { BASEMAP_ATTRIBUTION, resolveMapStyle } from '@/lib/geo/map-style'
import {
  ANOMALY_RAMP,
  ANOMALY_STOPS,
  QUADRANT_COLOR,
  TEMPERATURE_RAMP,
  linearStops,
  rampExpression,
} from '@/lib/viz/palette'

/**
 * The primary surface.
 *
 * Three layer modes, because the product reports two metrics that must never be
 * blended: `exposure` and `anomaly` each show their own field, and `combined`
 * shows the quadrant classification without inventing a single number.
 *
 * Every failure path renders an explicit message rather than an empty box, and
 * the side panel carries the same information, so a map that cannot load never
 * takes the product with it.
 */

/**
 * `temperature` draws the thermal field, `anomaly` the local z, `combined` the
 * quadrant classification. None of them draws the scenario exposure load: that
 * is a per-stop quantity built from riders, wait and heat, and painting cells
 * with it would attribute a stop's load to the ground around it.
 */
export type LayerMode = 'temperature' | 'anomaly' | 'combined'

export interface MapStop {
  id: string
  lon: number
  lat: number
  name: string
  rank: number | null
  selected: boolean
  complete: boolean
  exposure: number | null
  exposurePercentile: number | null
  anomalyZ: number | null
  quadrant: Quadrant | null
}

export interface MapCell {
  lon: number
  lat: number
  ring: Array<[number, number]>
  value: number
  z: number | null
}

type Status = 'loading' | 'ready' | 'unavailable'

interface Hovered {
  x: number
  y: number
  title: string
  rows: Array<[string, string]>
}

export function PriorityMap({
  cells,
  stops,
  bbox,
  layerMode,
  activeId,
  temperatureUnit,
  valueFieldLabel,
  anomalyLabel,
  loadUnitShort,
  onSelect,
  styleUrl,
  compact = false,
}: {
  cells: readonly MapCell[]
  stops: readonly MapStop[]
  bbox: BoundingBox
  layerMode: LayerMode
  activeId: string | null
  temperatureUnit: string | null
  /**
   * What the cell values are, as this run is entitled to describe them.
   *
   * "Temperature" was hardcoded. On a real layer whose field is unconfirmed the
   * map therefore captioned an unidentified numeric property as a temperature —
   * a public claim the whole capability gate exists to withhold.
   */
  valueFieldLabel: string
  /** Likewise for the anomaly, which is only a HEAT anomaly if the field is heat. */
  anomalyLabel: string
  /** Resolved by the run; never a literal. */
  loadUnitShort: string
  onSelect: (id: string) => void
  styleUrl?: string
  compact?: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<import('maplibre-gl').Map | null>(null)
  const fitFootprintRef = useRef<() => void>(() => undefined)
  const [status, setStatus] = useState<Status>('loading')
  const [message, setMessage] = useState('')
  // True once the cell source has actually produced rendered features. The map
  // once shipped for weeks looking alive while every GeoJSON source was empty
  // (a worker that never started), so the fact of rendering is now observable
  // and asserted end to end, not assumed.
  const [cellsDrawn, setCellsDrawn] = useState(false)
  const [thermalCoverage, setThermalCoverage] = useState(0)
  const [hovered, setHovered] = useState<Hovered | null>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  const temperatureDomain = useMemo(() => {
    const values = cells.map((cell) => cell.value).sort((a, b) => a - b)
    if (values.length === 0) return { min: 30, max: 45 }
    const at = (f: number) => values[Math.floor((values.length - 1) * f)] ?? 0
    // Trim the tails so a single extreme cell cannot flatten the whole ramp.
    return { min: at(0.02), max: at(0.98) }
  }, [cells])

  const thermalBounds = useMemo<BoundingBox>(() => {
    let minLon = Number.POSITIVE_INFINITY
    let minLat = Number.POSITIVE_INFINITY
    let maxLon = Number.NEGATIVE_INFINITY
    let maxLat = Number.NEGATIVE_INFINITY
    for (const cell of cells) {
      for (const [lon, lat] of cell.ring) {
        minLon = Math.min(minLon, lon)
        minLat = Math.min(minLat, lat)
        maxLon = Math.max(maxLon, lon)
        maxLat = Math.max(maxLat, lat)
      }
    }
    if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return bbox
    return { minLon, minLat, maxLon, maxLat }
  }, [bbox, cells])

  /* ------------------------------ create map ----------------------------- */
  useEffect(() => {
    let cancelled = false
    let map: import('maplibre-gl').Map | null = null
    let resizeObserver: ResizeObserver | null = null
    let initialFitFrame: number | null = null
    let layoutSettleTimer: number | null = null

    const boot = async () => {
      try {
        const maplibre = await import('maplibre-gl')
        await import('maplibre-gl/dist/maplibre-gl.css')
        if (cancelled || !containerRef.current) return

        // MapLibre resolves its worker relative to `import.meta.url`, which the
        // bundler rewrites to a chunk path that serves nothing. Without this
        // override the worker pool silently never starts and every GeoJSON
        // source stays empty — basemap tiles render, data never does. The file
        // is copied into public/ by scripts/sync-maplibre-worker.mjs at
        // predev / prebuild.
        maplibre.setWorkerUrl('/maplibre-gl-worker.mjs')

        map = new maplibre.Map({
          container: containerRef.current,
          style: resolveMapStyle(styleUrl) as never,
          bounds: [
            [thermalBounds.minLon, thermalBounds.minLat],
            [thermalBounds.maxLon, thermalBounds.maxLat],
          ],
          fitBoundsOptions: { padding: 12 },
          attributionControl: false,
        })

        const fitFootprint = () => {
          if (!map) return
          map.resize()
          map.fitBounds(
            [
              [thermalBounds.minLon, thermalBounds.minLat],
              [thermalBounds.maxLon, thermalBounds.maxLat],
            ],
            { padding: 12, duration: 0 },
          )
          window.requestAnimationFrame(() => {
            if (cancelled || !map) return
            const northWest = map.project([thermalBounds.minLon, thermalBounds.maxLat])
            const southEast = map.project([thermalBounds.maxLon, thermalBounds.minLat])
            const canvas = map.getCanvas()
            const widthRatio = Math.abs(southEast.x - northWest.x) / canvas.clientWidth
            const heightRatio = Math.abs(southEast.y - northWest.y) / canvas.clientHeight
            setThermalCoverage(Math.max(widthRatio, heightRatio))
          })
        }
        fitFootprintRef.current = fitFootprint

        // The map can boot while its responsive grid column is still settling.
        // MapLibre preserves the zoom chosen for that temporary width when the
        // canvas later grows, leaving the verified surface as a small rectangle
        // in the middle of the basemap. Refit during initial layout changes;
        // user-driven zoom and pan remain untouched afterwards.
        let initialLayoutSettled = false
        resizeObserver = new ResizeObserver(() => {
          map?.resize()
          if (!initialLayoutSettled) fitFootprint()
        })
        resizeObserver.observe(containerRef.current)
        layoutSettleTimer = window.setTimeout(() => {
          initialLayoutSettled = true
        }, 750)
        map.addControl(
          new maplibre.AttributionControl({ compact: true, customAttribution: BASEMAP_ATTRIBUTION }),
        )
        // Keep zoom away from the planner toolbar and panel-expansion action.
        // MapLibre stacks this cleanly above the scale control.
        map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'bottom-left')
        map.addControl(new maplibre.ScaleControl({ unit: 'metric' }), 'bottom-left')

        map.on('error', (event) => {
          console.warn('Map resource failed', event?.error?.message ?? event)
        })

        map.on('load', () => {
          if (cancelled || !map) return

          map.addSource('cells', { type: 'geojson', data: emptyCollection() })
          map.addSource('stops', { type: 'geojson', data: emptyCollection() })

          map.addLayer({
            id: 'cells-temperature',
            type: 'fill',
            source: 'cells',
            paint: {
              'fill-color': '#ffffff',
              'fill-opacity': 0.96,
              'fill-outline-color': 'rgba(118, 48, 13, 0.18)',
            },
          })
          map.addLayer({
            id: 'cells-anomaly',
            type: 'fill',
            source: 'cells',
            paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.8 },
            layout: { visibility: 'none' },
          })

          map.addLayer({
            id: 'stops-other',
            type: 'circle',
            source: 'stops',
            filter: ['!', ['get', 'selected']],
            paint: {
              // Unselected stops recede when zoomed out — thousands of white
              // dots at city scale drowned the fifty the plan is about — and
              // return to full presence as the reader zooms in to a corridor.
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.6, 12, 2.4, 14, 4],
              'circle-color': '#ffffff',
              'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.35, 12, 0.6, 13, 0.9],
              'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 13, 1],
              'circle-stroke-color': '#55606f',
            },
          })
          map.addLayer({
            id: 'stops-selected',
            type: 'circle',
            source: 'stops',
            filter: ['get', 'selected'],
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5.5, 14, 9],
              'circle-color': '#10151c',
              // A 2px surface ring keeps overlapping marks separable.
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
            },
          })
          map.addLayer({
            id: 'stops-active',
            type: 'circle',
            source: 'stops',
            filter: ['==', ['get', 'id'], '__none__'],
            paint: {
              'circle-radius': 14,
              'circle-color': 'rgba(0,0,0,0)',
              'circle-stroke-width': 3,
              'circle-stroke-color': '#12506b',
            },
          })
          // Visible stops can be only a few pixels wide when zoomed out. This
          // transparent interaction layer gives every stop a 32 px target for
          // mouse and touch without changing the analytical symbology.
          map.addLayer({
            id: 'stops-hit',
            type: 'circle',
            source: 'stops',
            paint: {
              'circle-radius': 16,
              'circle-color': 'rgba(0,0,0,0)',
            },
          })
          map.addLayer({
            id: 'stops-rank',
            type: 'symbol',
            source: 'stops',
            filter: ['all', ['get', 'selected'], ['<=', ['get', 'rank'], 30]],
            layout: {
              'text-field': ['to-string', ['get', 'rank']],
              'text-size': 10,
              'text-allow-overlap': true,
            },
            paint: { 'text-color': '#ffffff' },
          })

          map.on('click', 'stops-hit', (event) => {
            const id = event.features?.[0]?.properties?.id
            if (typeof id === 'string') onSelectRef.current(id)
          })
          map.on('mousemove', 'stops-hit', (event) => {
            const feature = event.features?.[0]
            if (!feature || !map) return
            map.getCanvas().style.cursor = 'pointer'
            const p = feature.properties ?? {}
            setHovered({
              x: event.point.x,
              y: event.point.y,
              title: String(p.name ?? 'Stop'),
              rows: [
                ['Exposure', p.exposureText ? String(p.exposureText) : 'not available'],
                ['Heat anomaly', p.anomalyText ? String(p.anomalyText) : 'not available'],
                ['Plan rank', p.rank && Number(p.rank) > 0 ? `#${p.rank}` : 'not selected'],
              ],
            })
          })
          map.on('mouseleave', 'stops-hit', () => {
            if (map) map.getCanvas().style.cursor = ''
            setHovered(null)
          })

          map.on('mousemove', 'cells-temperature', (event) => {
            if (map?.queryRenderedFeatures(event.point, { layers: ['stops-hit'] })
              .length) {
              return
            }
            const p = event.features?.[0]?.properties ?? {}
            setHovered({
              x: event.point.x,
              y: event.point.y,
              title: 'Heat cell',
              rows: [
                [valueFieldLabel, p.valueText ? String(p.valueText) : '—'],
                ['Local anomaly', p.zText ? String(p.zText) : 'not measurable'],
              ],
            })
          })
          map.on('mouseleave', 'cells-temperature', () => setHovered(null))

          mapRef.current = map
          if (process.env.NODE_ENV !== 'production') {
            ;(window as unknown as Record<string, unknown>).__hpeMap = map
          }
          setStatus('ready')

          // A double animation frame waits for both React's commit and the
          // responsive grid calculation before choosing the camera zoom.
          initialFitFrame = window.requestAnimationFrame(() => {
            initialFitFrame = window.requestAnimationFrame(fitFootprint)
          })
        })
      } catch (error) {
        if (cancelled) return
        setStatus('unavailable')
        setMessage(error instanceof Error ? error.message : 'The map library could not be loaded.')
      }
    }

    void boot()
    return () => {
      cancelled = true
      try {
        map?.remove()
      } catch {
        /* teardown must never throw into React */
      }
      resizeObserver?.disconnect()
      if (initialFitFrame !== null) window.cancelAnimationFrame(initialFitFrame)
      if (layoutSettleTimer !== null) window.clearTimeout(layoutSettleTimer)
      fitFootprintRef.current = () => undefined
      mapRef.current = null
    }
  }, [styleUrl, thermalBounds.maxLat, thermalBounds.maxLon, thermalBounds.minLat, thermalBounds.minLon])

  /* ------------------------------- cell data ----------------------------- */
  useEffect(() => {
    const map = mapRef.current
    if (!map || status !== 'ready') return
    const source = map.getSource('cells') as import('maplibre-gl').GeoJSONSource | undefined
    if (!source) return
    source.setData({
      type: 'FeatureCollection',
      features: cells
        .filter((cell) => cell.ring.length >= 4)
        .map((cell) => ({
          type: 'Feature' as const,
          geometry: { type: 'Polygon' as const, coordinates: [cell.ring] },
          properties: {
            value: cell.value,
            z: cell.z ?? 0,
            hasZ: cell.z !== null,
            valueText: `${cell.value.toFixed(1)} ${temperatureUnit ?? ''}`.trim(),
            zText: cell.z === null ? '' : `${cell.z > 0 ? '+' : ''}${cell.z.toFixed(2)} σ`,
          },
        })),
    })

    map.setPaintProperty(
      'cells-temperature',
      'fill-color',
      rampExpression(
        'value',
        linearStops(temperatureDomain.min, temperatureDomain.max, TEMPERATURE_RAMP.length),
        TEMPERATURE_RAMP,
      ) as never,
    )
    map.setPaintProperty(
      'cells-anomaly',
      'fill-color',
      rampExpression('z', [...ANOMALY_STOPS], ANOMALY_RAMP) as never,
    )

    map.once('idle', () => {
      setCellsDrawn(map.querySourceFeatures('cells').length > 0)
    })
  }, [cells, status, temperatureDomain, temperatureUnit])

  /* ------------------------------- stop data ----------------------------- */
  useEffect(() => {
    const map = mapRef.current
    if (!map || status !== 'ready') return
    const source = map.getSource('stops') as import('maplibre-gl').GeoJSONSource | undefined
    if (!source) return
    source.setData({
      type: 'FeatureCollection',
      features: stops.map((stop) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [stop.lon, stop.lat] },
        properties: {
          id: stop.id,
          name: stop.name,
          rank: stop.rank ?? 0,
          selected: stop.selected,
          quadrantColor: stop.quadrant ? QUADRANT_COLOR[stop.quadrant] : '#aab3bd',
          exposureText:
            stop.exposure === null
              ? ''
              : `${Math.round(stop.exposure).toLocaleString('en-US')} ${loadUnitShort}`,
          anomalyText:
            stop.anomalyZ === null
              ? ''
              : `${stop.anomalyZ > 0 ? '+' : ''}${stop.anomalyZ.toFixed(2)} σ vs surroundings`,
        },
      })),
    })
  }, [stops, status])

  /* ------------------------------ layer mode ----------------------------- */
  useEffect(() => {
    const map = mapRef.current
    if (!map || status !== 'ready') return
    if (!map.getLayer('cells-temperature') || !map.getLayer('cells-anomaly')) return

    map.setLayoutProperty(
      'cells-temperature',
      'visibility',
      layerMode === 'anomaly' ? 'none' : 'visible',
    )
    map.setLayoutProperty(
      'cells-anomaly',
      'visibility',
      layerMode === 'anomaly' ? 'visible' : 'none',
    )
    // In combined mode the field recedes so the quadrant marks lead.
    map.setPaintProperty('cells-temperature', 'fill-opacity', layerMode === 'combined' ? 0.52 : 0.96)

    map.setPaintProperty(
      'stops-selected',
      'circle-color',
      layerMode === 'combined' ? (['get', 'quadrantColor'] as never) : '#10151c',
    )
  }, [layerMode, status])

  /* ------------------------------- selection ----------------------------- */
  const lastActive = useRef<string | null>(null)
  useEffect(() => {
    const map = mapRef.current
    if (!map || status !== 'ready' || !map.getLayer('stops-active')) return
    map.setFilter('stops-active', ['==', ['get', 'id'], activeId ?? '__none__'])

    // Move the camera only when the selection actually changes — not whenever
    // the stop array is rebuilt.
    if (activeId && activeId !== lastActive.current) {
      const stop = stops.find((entry) => entry.id === activeId)
      if (stop) map.easeTo({ center: [stop.lon, stop.lat], duration: 500 })
    }
    lastActive.current = activeId
  }, [activeId, stops, status])

  return (
    <div
      className="relative h-full w-full"
      data-testid="priority-map"
      data-cells-drawn={cellsDrawn ? 'true' : 'false'}
      data-thermal-coverage={thermalCoverage.toFixed(3)}
    >
      <div ref={containerRef} className="h-full w-full" />

      {status === 'ready' && !compact && (
        <button
          type="button"
          data-testid="fit-thermal-footprint"
          onClick={() => fitFootprintRef.current()}
          className="absolute left-3 top-14 z-20 rounded-md border border-ink-200 bg-white/95 px-3 py-2 text-[11px] font-semibold text-ink-800 shadow-sm backdrop-blur-sm hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          Show full measured footprint
        </button>
      )}

      {status !== 'ready' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-ink-50/95 p-6 text-center">
          <p className="max-w-sm text-sm text-ink-700">
            {status === 'loading' ? (
              'Loading map…'
            ) : (
              <>
                <span className="font-semibold">The map is unavailable.</span> The list on the left
                carries the full plan and every number behind it.
                {message ? <span className="mt-1 block text-xs text-ink-500">{message}</span> : null}
              </>
            )}
          </p>
        </div>
      )}

      {hovered && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20 max-w-[15rem] rounded border border-ink-200 bg-white/95 px-2 py-1.5 text-[12px] shadow-lg"
          style={{
            left: Math.min(hovered.x + 14, (containerRef.current?.clientWidth ?? 400) - 250),
            top: Math.max(8, hovered.y - 10),
          }}
        >
          <p className="font-semibold text-ink-900">{hovered.title}</p>
          <dl className="mt-0.5 space-y-0.5">
            {hovered.rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-ink-500">{label}</dt>
                <dd className="hpe-num text-ink-900">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {!compact ? (
        <MapLegend
          layerMode={layerMode}
          temperatureDomain={temperatureDomain}
          temperatureUnit={temperatureUnit}
          valueFieldLabel={valueFieldLabel}
          anomalyLabel={anomalyLabel}
        />
      ) : null}
    </div>
  )
}

function emptyCollection() {
  return { type: 'FeatureCollection' as const, features: [] }
}

/* -------------------------------------------------------------------------- */
/* Legend                                                                     */
/* -------------------------------------------------------------------------- */

function MapLegend({
  layerMode,
  temperatureDomain,
  temperatureUnit,
  valueFieldLabel,
  anomalyLabel,
}: {
  layerMode: LayerMode
  temperatureDomain: { min: number; max: number }
  temperatureUnit: string | null
  valueFieldLabel: string
  anomalyLabel: string
}) {
  return (
    <div
      data-testid="map-legend"
      className="absolute bottom-3 left-24 right-3 z-20 w-auto rounded-lg border border-ink-200 bg-white/95 p-3 shadow-lg backdrop-blur-sm sm:bottom-6 sm:left-auto sm:w-60"
    >
      {layerMode === 'anomaly' ? (
        <>
          <p className="hpe-label">{anomalyLabel}</p>
          <div className="mt-1 flex h-3 overflow-hidden rounded-sm">
            {ANOMALY_RAMP.map((color) => (
              <span key={color} className="flex-1" style={{ background: color }} />
            ))}
          </div>
          <div className="hpe-num mt-0.5 flex justify-between text-[10px] text-ink-500">
            <span>−3σ</span>
            <span>0</span>
            <span>+3σ</span>
          </div>
          <p className="mt-1 text-[11px] leading-tight text-ink-500">
            Robust z against the median of cells within 1 km. Grey means typical for its
            surroundings.
          </p>
        </>
      ) : (
        <>
          <p className="hpe-label">
            {valueFieldLabel} {temperatureUnit ? `(${temperatureUnit})` : '(unit unconfirmed)'}
          </p>
          <div className="mt-1 flex h-3 overflow-hidden rounded-sm">
            {TEMPERATURE_RAMP.map((color) => (
              <span key={color} className="flex-1" style={{ background: color }} />
            ))}
          </div>
          <div className="hpe-num mt-0.5 flex justify-between text-[10px] text-ink-500">
            <span>{temperatureDomain.min.toFixed(1)}</span>
            <span>{((temperatureDomain.min + temperatureDomain.max) / 2).toFixed(1)}</span>
            <span>{temperatureDomain.max.toFixed(1)}</span>
          </div>
        </>
      )}

      <div className="mt-2 border-t border-ink-200 pt-1.5">
        <p className="hpe-label">Stops</p>
        <ul className="mt-1 space-y-1 text-[12px] text-ink-700">
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-full border-2 border-white bg-ink-900 ring-1 ring-ink-300" />
            Selected (numbered by rank)
          </li>
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full border border-ink-500 bg-white" />
            Not selected
          </li>
        </ul>
      </div>
    </div>
  )
}
