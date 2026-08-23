import { AppShell } from '@/components/AppShell'
import { AREAS_OF_INTEREST, FORTYGUARD_PILOT_REQUEST } from '@/lib/geo/aoi'
import { serverEnv } from '@/lib/config/server-env'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Priority Planner — Heat Priority Engine' }

export default function PlannerPage() {
  serverEnv()
  return (
    <AppShell
      embedded
      areas={AREAS_OF_INTEREST}
      defaults={{
        aoiId: FORTYGUARD_PILOT_REQUEST.aoiId,
        capacity: 10,
        analysisDate: FORTYGUARD_PILOT_REQUEST.analysisDate,
        snapshotTimes: [...FORTYGUARD_PILOT_REQUEST.snapshotTimes],
        dayType: 'weekday',
      }}
      mapStyleUrl={process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? ''}
    />
  )
}
