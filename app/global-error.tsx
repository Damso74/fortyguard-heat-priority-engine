'use client'

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <head>
        <title>Application unavailable · Heat Priority Engine</title>
      </head>
      <body style={{ margin: 0, background: '#f7f9fc', color: '#0b1828', fontFamily: 'system-ui, sans-serif' }}>
        <main style={{ display: 'grid', minHeight: '100dvh', placeItems: 'center', padding: 24 }}>
          <section style={{ maxWidth: 560, border: '1px solid #d7dee8', borderRadius: 16, background: '#fff', padding: 32 }} role="alert">
            <p style={{ margin: 0, color: '#0f4f9f', fontSize: 12, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' }}>Application unavailable</p>
            <h1 style={{ margin: '10px 0 0', fontSize: 26 }}>Heat Priority Engine could not start</h1>
            <p style={{ margin: '12px 0 0', color: '#435267', lineHeight: 1.6 }}>No operational data was changed. Try loading the application again.</p>
            <button type="button" onClick={reset} style={{ marginTop: 24, minHeight: 44, border: 0, borderRadius: 8, background: '#1769e0', color: '#fff', cursor: 'pointer', padding: '10px 18px', fontWeight: 700 }}>Try again</button>
          </section>
        </main>
      </body>
    </html>
  )
}
