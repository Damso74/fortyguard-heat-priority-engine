import Link from 'next/link'
import { SystemState } from '@/components/operations/SystemState'

export const metadata = { title: 'Module not found' }

export default function NotFound() {
  return (
      <SystemState
        code="404 · Unknown route"
        title="Module not found"
        description="This address is not part of the verified operational workflow. Continue from the overview or reopen a core workspace."
        actions={
          <>
            <Link href="/" className="hpe-button-primary">Return to Overview</Link>
            <Link href="/planner" className="hpe-button-secondary">Open priority planner</Link>
            <Link href="/missions" className="hpe-button-secondary">Open missions</Link>
          </>
        }
      />
  )
}
