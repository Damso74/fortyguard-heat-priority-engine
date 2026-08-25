'use client'

import { useEffect, useRef, useState } from 'react'
import { BASEMAP_ATTRIBUTION, resolveMapStyle } from '@/lib/geo/map-style'
import type { RidershipStop } from '@/lib/ridership/source'

type MapStatus = 'loading' | 'ready' | 'unavailable'

const PHOENIX_BOUNDS: [[number, number], [number, number]] = [
  [-112.48, 33.23],
  [-111.66, 33.72],
]

export function RidershipMap({
  stops,
  activeId,
  onSelect,
  styleUrl,
}: {
  stops: readonly RidershipStop[]
  activeId: number | null
  onSelect: (stopId: number) => void
  styleUrl?: string
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<import('maplibre-gl').Map | null>(null)
  const onSelectRef = useRef(onSelect)
  const [status, setStatus] = useState<MapStatus>('loading')
  const [message, setMessage] = useState('')
  const [pointsDrawn, setPointsDrawn] = useState(false)
  onSelectRef.current = onSelect

  useEffect(() => {
    let cancelled = false
    let map: import('maplibre-gl').Map | null = null
    let observer: ResizeObserver | null = null

    const boot = async () => {
      try {
        const maplibre = await import('maplibre-gl')
        await import('maplibre-gl/dist/maplibre-gl.css')
        if (cancelled || !containerRef.current) return

        maplibre.setWorkerUrl('/maplibre-gl-worker.mjs')
        map = new maplibre.Map({
          container: containerRef.current,
          style: resolveMapStyle(styleUrl) as never,
          bounds: PHOENIX_BOUNDS,
          fitBoundsOptions: { padding: 34 },
          attributionControl: false,
        })
        map.addControl(
          new maplibre.AttributionControl({
            compact: true,
            customAttribution: `${BASEMAP_ATTRIBUTION} · Ridership: Valley Metro`,
          }),
        )
        map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right')
        map.addControl(new maplibre.ScaleControl({ unit: 'imperial' }), 'bottom-left')

        observer = new ResizeObserver(() => map?.resize())
        observer.observe(containerRef.current)

        map.on('error', (event) => {
          console.warn('Ridership map resource failed', event?.error?.message ?? event)
        })

        map.on('load', () => {
          if (cancelled || !map) return
          map.addSource('ridership-stops', {
            type: 'geojson',
            data: emptyCollection(),
            cluster: true,
            clusterMaxZoom: 12,
            clusterRadius: 46,
          })

          map.addLayer({
            id: 'ridership-clusters',
            type: 'circle',
            source: 'ridership-stops',
            filter: ['has', 'point_count'],
            paint: {
              'circle-color': ['step', ['get', 'point_count'], '#dceafd', 20, '#7fb1ef', 80, '#1769e0'],
              'circle-radius': ['step', ['get', 'point_count'], 15, 20, 20, 80, 27],
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
            },
          })
          map.addLayer({
            id: 'ridership-cluster-count',
            type: 'symbol',
            source: 'ridership-stops',
            filter: ['has', 'point_count'],
            layout: {
              'text-field': ['get', 'point_count_abbreviated'],
              'text-size': 11,
              'text-font': ['Open Sans Semibold'],
            },
            paint: { 'text-color': '#0b1828' },
          })
          map.addLayer({
            id: 'ridership-points',
            type: 'circle',
            source: 'ridership-stops',
            filter: ['!', ['has', 'point_count']],
            paint: {
              'circle-radius': [
                'interpolate',
                ['linear'],
                ['coalesce', ['get', 'publishedAverage'], 0],
                0,
                4,
                10,
                6,
                50,
                11,
                150,
                18,
              ],
              'circle-color': [
                'case',
                ['==', ['get', 'hasValue'], false],
                '#a8b3c2',
                [
                  'interpolate',
                  ['linear'],
                  ['get', 'publishedAverage'],
                  0,
                  '#dceafd',
                  25,
                  '#2e7ce6',
                  75,
                  '#e85d2a',
                  150,
                  '#9d3515',
                ],
              ],
              'circle-opacity': 0.86,
              'circle-stroke-width': 1.5,
              'circle-stroke-color': '#ffffff',
            },
          })
          map.addLayer({
            id: 'ridership-active',
            type: 'circle',
            source: 'ridership-stops',
            filter: ['==', ['get', 'stopId'], -1],
            paint: {
              'circle-radius': 22,
              'circle-color': 'rgba(0,0,0,0)',
              'circle-stroke-width': 3,
              'circle-stroke-color': '#0b1828',
            },
          })

          map.on('click', 'ridership-clusters', async (event) => {
            if (!map) return
            const feature = event.features?.[0]
            const clusterId = feature?.properties?.cluster_id
            if (typeof clusterId !== 'number' || feature?.geometry.type !== 'Point') return
            const source = map.getSource('ridership-stops') as import('maplibre-gl').GeoJSONSource
            const zoom = await source.getClusterExpansionZoom(clusterId)
            map.easeTo({ center: feature.geometry.coordinates as [number, number], zoom })
          })
          map.on('click', 'ridership-points', (event) => {
            const stopId = Number(event.features?.[0]?.properties?.stopId)
            if (Number.isSafeInteger(stopId)) onSelectRef.current(stopId)
          })
          for (const layer of ['ridership-clusters', 'ridership-points']) {
            map.on('mouseenter', layer, () => {
              if (map) map.getCanvas().style.cursor = 'pointer'
            })
            map.on('mouseleave', layer, () => {
              if (map) map.getCanvas().style.cursor = ''
            })
          }

          mapRef.current = map
          setStatus('ready')
        })
      } catch (error) {
        if (cancelled) return
        setStatus('unavailable')
        setMessage(error instanceof Error ? error.message : 'The map could not be loaded.')
      }
    }

    void boot()
    return () => {
      cancelled = true
      observer?.disconnect()
      try {
        map?.remove()
      } catch {
        // Map teardown must not throw into React.
      }
      mapRef.current = null
    }
  }, [styleUrl])

  useEffect(() => {
    const map = mapRef.current
    if (!map || status !== 'ready') return
    const source = map.getSource('ridership-stops') as import('maplibre-gl').GeoJSONSource | undefined
    if (!source) return
    source.setData({
      type: 'FeatureCollection',
      features: stops.map((stop) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [stop.lon, stop.lat] },
        properties: {
          stopId: stop.stopId,
          name: stop.name,
          hasValue: stop.publishedAverage !== null,
          publishedAverage: stop.publishedAverage ?? 0,
        },
      })),
    })
    map.once('idle', () => {
      setPointsDrawn(
        map.queryRenderedFeatures({ layers: ['ridership-clusters', 'ridership-points'] }).length > 0,
      )
    })
  }, [status, stops])

  useEffect(() => {
    const map = mapRef.current
    if (!map || status !== 'ready' || !map.getLayer('ridership-active')) return
    map.setFilter('ridership-active', ['==', ['get', 'stopId'], activeId ?? -1])
    if (activeId === null) return
    const stop = stops.find((entry) => entry.stopId === activeId)
    if (stop) map.easeTo({ center: [stop.lon, stop.lat], zoom: Math.max(map.getZoom(), 14), duration: 450 })
  }, [activeId, status, stops])

  return (
    <div
      className="relative h-full w-full"
      data-testid="ridership-map"
      data-points-drawn={pointsDrawn ? 'true' : 'false'}
    >
      <div ref={containerRef} className="h-full w-full" />
      {status !== 'ready' ? (
        <div className="absolute inset-0 grid place-items-center bg-ink-50/95 p-6 text-center text-[13px] text-ink-600">
          {status === 'loading' ? 'Loading ridership map…' : `Map unavailable. ${message}`}
        </div>
      ) : null}
      <div className="absolute bottom-6 right-3 z-20 w-52 rounded-lg border border-ink-200 bg-white/95 p-3 shadow-lg backdrop-blur-sm">
        <p className="hpe-label">Published stop average</p>
        <div className="mt-2 h-2.5 rounded-full bg-gradient-to-r from-[#dceafd] via-[#2e7ce6] to-[#9d3515]" />
        <div className="hpe-num mt-1 flex justify-between text-[10px] text-ink-500">
          <span>Lower</span>
          <span>Higher</span>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-ink-500">Point area and colour encode the selected field. Grey means missing, not zero.</p>
      </div>
    </div>
  )
}

function emptyCollection() {
  return { type: 'FeatureCollection' as const, features: [] }
}
