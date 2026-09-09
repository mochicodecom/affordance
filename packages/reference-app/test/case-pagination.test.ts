import { afterEach, expect, it, vi } from 'vitest'
import { fetchCases } from '../ui/src/lib/api.js'

afterEach(() => {
  vi.unstubAllGlobals()
})
it('follows the engine cursor until every console case is loaded', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ cases: [{ id: 'first' }], nextCursor: 'opaque/+=' }),
    )
    .mockResolvedValueOnce(
      Response.json({ cases: [{ id: 'second' }], nextCursor: null }),
    )
  vi.stubGlobal('fetch', fetch)
  expect(await fetchCases()).toEqual([{ id: 'first' }, { id: 'second' }])
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    '/dev/cases',
    '/dev/cases?cursor=opaque%2F%2B%3D',
  ])
})
it('surfaces a failed continuation instead of returning an incomplete list', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ cases: [{ id: 'first' }], nextCursor: 'next' }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: 'unavailable' }, { status: 503 }),
      ),
  )
  await expect(fetchCases()).rejects.toThrow('503')
})
