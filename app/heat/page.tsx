import { HeatMonitor } from '@/components/operations/HeatMonitor'

export const metadata = { title: 'Heat Monitor', description: 'Inspect stored FortyGuard thermal evidence by hour for the Phoenix pilot area.' }

export default function HeatPage() {
  return <HeatMonitor mapStyleUrl={process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? ''} />
}
