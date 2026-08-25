import { RidershipExplorer } from '@/components/operations/RidershipExplorer'

export const metadata = { title: 'Ridership Explorer', description: 'Explore Valley Metro stop-level quarterly averages from the public ArcGIS layer.' }

export default function RidershipPage() {
  return <RidershipExplorer mapStyleUrl={process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? ''} />
}
