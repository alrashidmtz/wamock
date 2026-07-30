import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildStateSnapshot } from '../src/control/routes.js'
import { WamockEngine } from '../src/core/engine.js'
import { verifySignature } from '../src/webhooks/signature.js'
import { createServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'
import type { LightMyRequestResponse } from 'fastify'

const EPOCH = 1_750_000_000_000
const SECRET = 'app-secret'

let engine: WamockEngine
let app: FastifyInstance
let received: Array<{ body: string; signature: string | undefined }>

beforeEach(async () => {
  received = []
  engine = new WamockEngine({
    appSecret: SECRET,
    mode: 'frozen',
    start: EPOCH,
    transport: async (d) => {
      received.push({ body: d.body, signature: d.signature })
    },
  })
  app = createServer(engine)
  await app.ready()
})

/**
 * Open the 24h window the way a real scenario does — the customer writes in —
 * then drain that webhook so each test starts from a clean delivery log.
 */
async function openWindow(): Promise<void> {
  engine.simulateInbound({
    from: '5215555000001',
    message: { type: 'text', text: { body: 'hola' } },
  })
  engine.clock.advance(0)
  await engine.settle()
  received.length = 0
}

afterEach(async () => {
  await app.close()
})

// Serialize explicitly so the request carries the same bytes a real client
// would send, and so the helper's return type stays a plain response.
const post = async (url: string, payload: unknown): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  })

const get = async (url: string): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'GET', url })

const textBody = {
  messaging_product: 'whatsapp',
  to: '5215555000001',
  type: 'text',
  text: { body: 'hola' },
}

describe('POST /{version}/{phone_number_id}/messages', () => {
  it('accepts a text send and returns Meta’s envelope', async () => {
    await openWindow()
    const res = await post(`/v19.0/${engine.state.defaultPhoneNumberId}/messages`, textBody)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      messaging_product: 'whatsapp',
      contacts: [{ wa_id: '5215555000001' }],
    })
  })

  it('accepts any vNN.N version segment — apps pin different versions', async () => {
    await openWindow()
    // Spec §5.1: real integrations are scattered across v17 through v23.
    for (const version of ['v17.0', 'v19.0', 'v21.0', 'v23.0']) {
      const res = await post(`/${version}/${engine.state.defaultPhoneNumberId}/messages`, textBody)
      expect(res.statusCode, version).toBe(200)
    }
  })

  it('404s on a path segment that is not a Graph version', async () => {
    const res = await post(`/notaversion/${engine.state.defaultPhoneNumberId}/messages`, textBody)
    expect(res.statusCode).toBe(404)
  })

  it('returns the Meta error body with the matching HTTP status', async () => {
    const res = await post(`/v19.0/${engine.state.defaultPhoneNumberId}/messages`, {
      ...textBody,
      to: '123',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      error: { code: 131026, type: 'OAuthException', error_data: { messaging_product: 'whatsapp' } },
    })
    expect(res.json().error.fbtrace_id).toEqual(expect.any(String))
  })

  it('rejects a body that is not JSON with a Meta-shaped 400, not a fastify error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v19.0/${engine.state.defaultPhoneNumberId}/messages`,
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(100)
  })
})

describe('POST /__mock/inbound', () => {
  it('delivers a signed webhook the app can verify', async () => {
    const res = await post('/__mock/inbound', { from: '5215555000001', text: 'hola' })
    expect(res.statusCode).toBe(200)

    engine.clock.advance(0)
    await engine.settle()

    const delivery = received[0]!
    expect(verifySignature({ appSecret: SECRET, body: delivery.body, header: delivery.signature })).toBe(true)
  })

  it('reports the sender without a + inside the webhook', async () => {
    await post('/__mock/inbound', { from: '+5215555000001', text: 'hola' })
    engine.clock.advance(0)
    await engine.settle()

    const value = JSON.parse(received[0]!.body).entry[0].changes[0].value
    expect(value.messages[0].from).toBe('5215555000001')
    expect(value.contacts[0].wa_id).toBe('5215555000001')
  })

  it('carries a contact name through when given', async () => {
    await post('/__mock/inbound', { from: '5215555000001', text: 'hola', name: 'Ana' })
    engine.clock.advance(0)
    await engine.settle()

    const value = JSON.parse(received[0]!.body).entry[0].changes[0].value
    expect(value.contacts[0].profile.name).toBe('Ana')
  })

  it('supports an interactive button reply', async () => {
    await post('/__mock/inbound', {
      from: '5215555000001',
      type: 'interactive',
      button_reply: { id: 'confirm_yes', title: 'Yes' },
    })
    engine.clock.advance(0)
    await engine.settle()

    const message = JSON.parse(received[0]!.body).entry[0].changes[0].value.messages[0]
    expect(message).toMatchObject({
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'confirm_yes' } },
    })
  })

  it('rejects an unusable sender with a Meta-shaped error', async () => {
    const res = await post('/__mock/inbound', { from: 'nope', text: 'hola' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(100)
  })

  it('requires either text or an explicit type', async () => {
    const res = await post('/__mock/inbound', { from: '5215555000001' })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /__mock/time/advance', () => {
  it('moves the clock and fires the statuses that came due', async () => {
    await openWindow()
    await post(`/v19.0/${engine.state.defaultPhoneNumberId}/messages`, textBody)

    const res = await post('/__mock/time/advance', { ms: 60_000 })
    await engine.settle()

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ now: EPOCH + 60_000 })
    expect(received).toHaveLength(2)
  })

  it('rejects a negative jump', async () => {
    const res = await post('/__mock/time/advance', { ms: -1 })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /__mock/messages and /__mock/state', () => {
  it('lists everything the app has sent', async () => {
    await openWindow()
    await post(`/v19.0/${engine.state.defaultPhoneNumberId}/messages`, textBody)

    const res = await get('/__mock/messages')

    expect(res.statusCode).toBe(200)
    expect(res.json().messages).toHaveLength(1)
    expect(res.json().messages[0]).toMatchObject({ to: '5215555000001', type: 'text' })
  })

  it('exposes the tenant graph and current virtual time', async () => {
    const res = await get('/__mock/state')

    expect(res.json()).toMatchObject({
      now: EPOCH,
      phoneNumbers: [{ phoneNumberId: engine.state.defaultPhoneNumberId }],
    })
  })

  it('never leaks app secrets through the state endpoint', async () => {
    // /__mock/state is meant to be curl-able and pasted into bug reports.
    const res = await get('/__mock/state')
    expect(JSON.stringify(res.json())).not.toContain(SECRET)
  })

  it('reports which apps a WABA is subscribed to, not an empty object', async () => {
    // `subscribedApps` is a Set internally, and a Set serializes to `{}`. The
    // seeded WABA arrives subscribed, so anything but its app id here means the
    // readout is lying in exactly the report this endpoint exists to serve.
    const res = await get('/__mock/state')

    expect(res.json().wabas).toEqual([
      {
        wabaId: engine.state.defaultWabaId,
        appId: engine.state.defaultAppId,
        subscribedApps: [engine.state.defaultAppId],
      },
    ])
  })

  it('survives a JSON round trip unchanged', async () => {
    // The guard for the whole class, not just for `subscribedApps`: a Set, a
    // Map, a Date or an undefined value added to this payload later would all
    // come back different, and the endpoint would quietly start lying again.
    // Exercised against a populated graph, so every optional field is present.
    await openWindow()
    await post(`/v19.0/${engine.state.defaultPhoneNumberId}/messages`, textBody)
    await post('/__mock/quality', { quality_rating: 'RED' })
    await post('/__mock/tier', { tier: 'TIER_1K' })

    const snapshot = buildStateSnapshot(engine)

    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
  })
})

describe('POST /__mock/reset', () => {
  it('clears sent messages and the webhook log', async () => {
    await openWindow()
    await post(`/v19.0/${engine.state.defaultPhoneNumberId}/messages`, textBody)

    const res = await post('/__mock/reset', {})

    expect(res.statusCode).toBe(200)
    expect((await get('/__mock/messages')).json().messages).toHaveLength(0)
  })

  it('cancels statuses that were still scheduled', async () => {
    await openWindow()
    await post(`/v19.0/${engine.state.defaultPhoneNumberId}/messages`, textBody)
    await post('/__mock/reset', {})

    engine.clock.advance(60_000)
    await engine.settle()

    expect(received).toHaveLength(0)
  })
})
