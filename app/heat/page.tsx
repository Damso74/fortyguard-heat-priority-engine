import { HeatMonitor } from '@/components/operations/HeatMonitor'

export const metadata = { title: 'Heat Monitor — Heat Priority Engine' }

export default function HeatPage() {
  return <HeatMonitor mapStyleUrl={process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? ''} />
}
