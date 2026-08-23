'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import {
  expandPlanSummary,
  type ExpandedPlanSummary,
  type PlanSummary,
} from '@/lib/agent/summary'
import type { ControlsValue } from '@/components/panel/RunControls'

export type MissionStatus = 'draft' | 'assigned' | 'in_progress' | 'submitted' | 'reviewed'
export type ShadeStatus = 'present' | 'partial' | 'absent' | 'unknown'

export interface DemoObservation {
  id: string
  shade: ShadeStatus
  shelter: 'present' | 'absent' | 'unknown'
  accessibility: 'clear' | 'constrained' | 'unknown'
  confidence: 'low' | 'medium' | 'high'
  note: string
  createdAtUtc: string
  review: 'pending' | 'accepted' | 'reinspect' | 'rejected'
}

export interface InspectionMission {
  id: string
  stopId: number
  stopName: string
  rank: number
  robust: boolean
  status: MissionStatus
  observation: DemoObservation | null
}

interface OperationsContextValue {
  run: ExpandedPlanSummary | null
  loading: boolean
  error: string | null
  defaults: ControlsValue
  missions: InspectionMission[]
  planVersion: number
  refresh: () => void
  setMissionStatus: (id: string, status: MissionStatus) => void
  submitObservation: (
    missionId: string,
    input: Omit<DemoObservation, 'id' | 'createdAtUtc' | 'review'>,
  ) => void
  reviewObservation: (missionId: string, review: DemoObservation['review']) => void
  resetDemoWorkspace: () => void
}

const OperationsContext = createContext<OperationsContextValue | null>(null)
const STORAGE_KEY = 'hpe-demo-workspace-v1'

function missionSeed(run: ExpandedPlanSummary): InspectionMission[] {
  const resultById = new Map(run.results.map((result) => [String(result.stop.id), result]))
  return run.plan.entries
    .filter((entry) => entry.selected)
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
    .map((entry) => {
      const result = resultById.get(entry.candidateId)
      return {
        id: `mission-${entry.candidateId}`,
        stopId: Number(entry.candidateId),
        stopName: result?.stop.name ?? `Stop ${entry.candidateId}`,
        rank: entry.rank ?? 0,
        robust: run.plan.robustIds.includes(entry.candidateId),
        status: 'draft',
        observation: null,
      }
    })
}

export function OperationsProvider({
  defaults,
  children,
}: {
  defaults: ControlsValue
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const [run, setRun] = useState<ExpandedPlanSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missions, setMissions] = useState<InspectionMission[]>([])
  const [planVersion, setPlanVersion] = useState(1)
  const [refreshToken, setRefreshToken] = useState(0)
  const loadedRefreshToken = useRef<number | null>(null)
  const requestKey = useMemo(() => JSON.stringify(defaults), [defaults])

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), [])

  useEffect(() => {
    if (pathname === '/methodology') return
    if (run && loadedRefreshToken.current === refreshToken) return
    const controller = new AbortController()
    loadedRefreshToken.current = refreshToken
    setLoading(true)
    setError(null)

    void fetch('/api/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestKey,
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json()
        if (!response.ok) throw new Error(payload?.error ?? `Analysis failed (${response.status})`)
        return expandPlanSummary(payload as PlanSummary)
      })
      .then((nextRun) => {
        setRun(nextRun)
        setMissions((current) => {
          if (current.length) return current
          const seeded = missionSeed(nextRun)
          try {
            const saved = sessionStorage.getItem(STORAGE_KEY)
            if (!saved) return seeded
            const parsed = JSON.parse(saved) as {
              runId?: string
              missions?: InspectionMission[]
              planVersion?: number
            }
            if (parsed.runId !== nextRun.runId || !Array.isArray(parsed.missions)) return seeded
            setPlanVersion(parsed.planVersion ?? 1)
            return parsed.missions
          } catch {
            return seeded
          }
        })
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        loadedRefreshToken.current = null
        setError(cause instanceof Error ? cause.message : 'Unable to load the verified pilot.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [pathname, refreshToken, requestKey, run])

  useEffect(() => {
    if (!run || missions.length === 0) return
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ runId: run.runId, missions, planVersion }),
    )
  }, [missions, planVersion, run])

  const setMissionStatus = useCallback((id: string, status: MissionStatus) => {
    setMissions((current) =>
      current.map((mission) => (mission.id === id ? { ...mission, status } : mission)),
    )
  }, [])

  const submitObservation = useCallback(
    (
      missionId: string,
      input: Omit<DemoObservation, 'id' | 'createdAtUtc' | 'review'>,
    ) => {
      setMissions((current) =>
        current.map((mission) =>
          mission.id === missionId
            ? {
                ...mission,
                status: 'submitted',
                observation: {
                  ...input,
                  id: `observation-${mission.stopId}`,
                  createdAtUtc: new Date().toISOString(),
                  review: 'pending',
                },
              }
            : mission,
        ),
      )
    },
    [],
  )

  const reviewObservation = useCallback(
    (missionId: string, review: DemoObservation['review']) => {
      setMissions((current) =>
        current.map((mission) => {
          if (mission.id !== missionId || !mission.observation) return mission
          return {
            ...mission,
            status: review === 'accepted' ? 'reviewed' : review === 'reinspect' ? 'assigned' : mission.status,
            observation: { ...mission.observation, review },
          }
        }),
      )
      if (review === 'accepted') setPlanVersion(2)
    },
    [],
  )

  const resetDemoWorkspace = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY)
    setPlanVersion(1)
    setMissions(run ? missionSeed(run) : [])
  }, [run])

  const value = useMemo<OperationsContextValue>(
    () => ({
      run,
      loading,
      error,
      defaults,
      missions,
      planVersion,
      refresh,
      setMissionStatus,
      submitObservation,
      reviewObservation,
      resetDemoWorkspace,
    }),
    [
      defaults,
      error,
      loading,
      missions,
      planVersion,
      refresh,
      resetDemoWorkspace,
      reviewObservation,
      run,
      setMissionStatus,
      submitObservation,
    ],
  )

  return <OperationsContext.Provider value={value}>{children}</OperationsContext.Provider>
}

export function useOperations(): OperationsContextValue {
  const value = useContext(OperationsContext)
  if (!value) throw new Error('useOperations must be used inside OperationsProvider')
  return value
}
