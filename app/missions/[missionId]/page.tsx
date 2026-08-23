import { FieldMission } from '@/components/operations/FieldMission'

export const metadata = { title: 'Field Mission — Heat Priority Engine' }

export default async function MissionPage({
  params,
}: {
  params: Promise<{ missionId: string }>
}) {
  const { missionId } = await params
  return <FieldMission missionId={missionId} />
}
