import { FieldMission } from '@/components/operations/FieldMission'

export const metadata = { title: 'Field Mission', description: 'Record a bounded field observation for human evidence review.' }

export default async function MissionPage({
  params,
}: {
  params: Promise<{ missionId: string }>
}) {
  const { missionId } = await params
  return <FieldMission missionId={missionId} />
}
