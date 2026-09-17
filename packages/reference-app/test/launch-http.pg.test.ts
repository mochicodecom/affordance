import { afterAll, expect, it, vi } from 'vitest'
import { createMockServices } from '../src/services.js'
import { organizer } from '../src/state.js'
import { createClient, createPool } from './harness.js'

const pool = createPool()
afterAll(() => pool.end())
const headers = {
  'content-type': 'application/json',
  'x-actor-id': organizer.id,
  'x-actor-roles': 'organizer',
}
it('exposes launched completion separately from diff history and authorizes status reads', async () => {
  const client = await createClient(pool)
  try {
    const id = await client.create(organizer)
    const response = await client.app.http.request(
      `/dev/cases/${id}/steps/accept-offer/launch`,
      { method: 'POST', headers, body: '{}' },
    )
    expect(response.status).toBe(201)
    const { executionId } = (await response.json()) as { executionId: string }
    expect(
      (await client.app.http.request(`/dev/executions/${executionId}`)).status,
    ).toBe(403)
    await vi.waitFor(async () =>
      expect(await client.app.engine.getExecution(executionId)).toMatchObject({
        status: 'completed',
      }),
    )
    const read = await client.app.http.request(
      `/dev/executions/${executionId}`,
      { headers },
    )
    expect(await read.json()).toMatchObject({
      executionId,
      status: 'completed',
      journal: { status: 'recorded' },
    })
    expect(
      (await client.app.http.request('/dev/executions/missing', { headers }))
        .status,
    ).toBe(404)
    expect(
      (
        await client.app.http.request(
          `/dev/executions/${executionId}/resolve`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ reason: 'already completed' }),
          },
        )
      ).status,
    ).toBe(409)
  } finally {
    await client.app.stop()
  }
})
it('reports provider errors as unresolved and records an authorized reconciliation', async () => {
  const services = createMockServices()
  vi.spyOn(services, 'applyForEscrowAccount').mockImplementation(() => {
    throw new Error('provider credential must not appear')
  })
  const client = await createClient(pool, { services })
  try {
    const id = await client.create(organizer)
    await client.take(id, organizer, 'accept-offer')
    await client.take(id, organizer, 'obtain-inspection-report')
    const response = await client.app.http.request(
      `/dev/cases/${id}/steps/open-escrow/launch`,
      { method: 'POST', headers, body: '{}' },
    )
    const { executionId } = (await response.json()) as { executionId: string }
    await vi.waitFor(async () =>
      expect(await client.app.engine.getExecution(executionId)).toMatchObject({
        status: 'unresolved',
        reason: 'handler-error',
      }),
    )
    expect(
      (
        await client.app.http.request(
          `/dev/executions/${executionId}/resolve`,
          { method: 'POST', body: '{}' },
        )
      ).status,
    ).toBe(403)
    const resolved = await client.app.http.request(
      `/dev/executions/${executionId}/resolve`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          reason: 'Checked provider and persisted request',
        }),
      },
    )
    const body = await resolved.json()
    expect(body).toMatchObject({
      status: 'resolved',
      resolution: {
        actor: organizer.id,
        reason: 'Checked provider and persisted request',
      },
    })
    expect(JSON.stringify(body)).not.toContain('provider credential')
    expect(await client.app.engine.journal(id, { executionId })).toEqual([])
  } finally {
    await client.app.stop()
  }
})
