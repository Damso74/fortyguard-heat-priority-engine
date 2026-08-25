'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { SystemState } from '@/components/operations/SystemState'

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    if (error.digest) console.error('Route rendering error', { digest: error.digest })
  }, [error.digest])

  return (
    <SystemState
      code="Module unavailable"
      title="This view could not be displayed"
      description="The verified pilot and your session workspace remain unchanged. Retry this module or return to the operational overview."
      alert
      actions={
        <>
          <button type="button" onClick={reset} className="hpe-button-primary">Try again</button>
          <Link href="/" className="hpe-button-secondary">Return to Overview</Link>
        </>
      }
    />
  )
}
