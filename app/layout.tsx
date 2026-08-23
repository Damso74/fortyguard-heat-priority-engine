import type { Metadata, Viewport } from 'next'
import './globals.css'
import { FORTYGUARD_PILOT_REQUEST } from '@/lib/geo/aoi'
import { OperationsProvider } from '@/components/operations/OperationsProvider'
import { CivicShell } from '@/components/operations/CivicShell'

export const metadata: Metadata = {
  metadataBase: new URL('https://heat-priority-engine.vercel.app'),
  // "Inspection prioritization", deliberately not "investment planner": the
  // claim registry blocks every cost, construction and causal-impact claim, so
  // the name must not promise one.
  title: {
    default: 'Heat Priority Engine — Phoenix Transit Heat Operations',
    template: '%s · Heat Priority Engine',
  },
  description:
    'From heat evidence to field-ready decisions: prioritize, inspect, review and audit Phoenix transit heat operations using verified FortyGuard data.',
  openGraph: {
    title: 'Heat Priority Engine',
    description:
      'From heat evidence to field-ready decisions. An independent Phoenix transit heat-operations pilot.',
    siteName: 'Heat Priority Engine',
    type: 'website',
    images: [{ url: '/og.png', width: 1732, height: 910, alt: 'Heat Priority Engine — Phoenix Transit Heat Operations' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Heat Priority Engine',
    description: 'From heat evidence to field-ready decisions.',
    images: ['/og.png'],
  },
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="hpe-skip-link" href="#main">
          Skip to main content
        </a>
        <OperationsProvider
          defaults={{
            aoiId: FORTYGUARD_PILOT_REQUEST.aoiId,
            capacity: 10,
            analysisDate: FORTYGUARD_PILOT_REQUEST.analysisDate,
            snapshotTimes: [...FORTYGUARD_PILOT_REQUEST.snapshotTimes],
            dayType: 'weekday',
          }}
        >
          <CivicShell>{children}</CivicShell>
        </OperationsProvider>
      </body>
    </html>
  )
}
