import { describe, expect, it } from 'vitest'
import { GET } from '@/app/api/thermal-snapshot/route'

describe('thermal snapshot route', () => {
  it('returns one cacheable stored hour without executing a plan', async () => {
    const response = await GET(new Request('http://localhost/api/thermal-snapshot?time=14%3A00'))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('s-maxage=86400')
    expect(response.headers.get('x-thermal-source')).toBe('committed-real-snapshot')
    expect(payload.time).toBe('14:00')
    expect(payload.cellCount).toBe(150)
    expect(payload.heatCells.cells).toHaveLength(150)
    expect(payload.attestationSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects an hour outside the committed pilot', async () => {
    const response = await GET(new Request('http://localhost/api/thermal-snapshot?time=12%3A00'))
    expect(response.status).toBe(400)
  })
})
