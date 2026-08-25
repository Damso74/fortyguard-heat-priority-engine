import { OverviewPage } from '@/components/operations/OverviewPage'

export const dynamic = 'force-dynamic'

export default function Page() {
  return <OverviewPage mapStyleUrl={process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? ''} />
}
