import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
        businessId: engine.state.defaultBusinessId,
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
    await post('/__mock/tier', { tier: 'TIER_2K' })

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

// Mutants left alive on purpose in server.ts: the `x !== undefined ? { x } : {}`
// spreads forced true pass `x: undefined`, which every consumer treats as
// absent; the Host header is always present over HTTP/1.1; and the `details`
// strings of the multipart and limit errors are debug text, not contract.
describe('routing and the token check', () => {
  const expiredToken = (): string => {
    const token = engine.issueToken({ kind: 'short' }).access_token
    engine.clock.advance(3 * 60 * 60 * 1000)
    return token
  }

  it.each([
    ['POST', '/notaversion/PNID/messages'],
    ['GET', '/notaversion/oauth/access_token'],
    ['GET', '/notaversion/debug_token'],
    ['POST', '/notaversion/WABA/subscribed_apps'],
    ['DELETE', '/notaversion/WABA/subscribed_apps'],
    ['GET', '/notaversion/WABA/subscribed_apps'],
    ['GET', '/notaversion/WABA/phone_numbers'],
    ['POST', '/notaversion/PNID/smb_app_data'],
    ['POST', '/notaversion/PNID/media'],
    ['GET', '/notaversion/OBJECT'],
    ['DELETE', '/notaversion/OBJECT'],
    ['GET', '/notaversion/WABA/message_templates'],
    ['POST', '/notaversion/WABA/message_templates'],
    ['DELETE', '/notaversion/WABA/message_templates'],
  ] as const)('404s %s %s, whatever token it carries', async (method, path) => {
    const url = path.replace('PNID', engine.state.defaultPhoneNumberId).replace('WABA', engine.state.defaultWabaId)
    const bodyless = method === 'GET' || method === 'DELETE'
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${expiredToken()}`, ...(bodyless ? {} : { 'content-type': 'application/json' }) },
      ...(bodyless ? {} : { payload: '{}' }),
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuses a multipart body it cannot parse with a Meta-shaped 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v26.0/${engine.state.defaultPhoneNumberId}/media`,
      headers: { 'content-type': 'multipart/form-data; boundary=wamock' },
      payload: 'not multipart at all',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(100)
  })

  it('takes the control API’s bodies as JSON only, never as multipart', async () => {
    const form = new FormData()
    form.set('from', '5215555000001')
    form.set('text', 'hola')
    const request = new Request('http://localhost/', { method: 'POST', body: form })
    const res = await app.inject({
      method: 'POST',
      url: '/__mock/inbound',
      headers: { 'content-type': request.headers.get('content-type')! },
      payload: Buffer.from(await request.arrayBuffer()),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(100)
    expect(received).toHaveLength(0)
  })
})

describe('media scoped to a phone_number_id', () => {
  // Meta's media reference: with `phone_number_id`, the call is processed only
  // when the media belongs to that business number.
  const twoNumbers = () => {
    const other = engine.createSignup().phone_number_id
    const { id } = engine.uploadMedia(engine.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      type: 'image/jpeg',
      file: { bytes: Buffer.from('x') },
    })
    return { other, id }
  }

  it('reads the media only through the number it belongs to', async () => {
    const { other, id } = twoNumbers()
    const wrong = await get(`/v26.0/${id}?phone_number_id=${other}`)
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().error.message).toMatch(/^Unsupported get request\. Object with ID '/)
    expect((await get(`/v26.0/${id}?phone_number_id=${engine.state.defaultPhoneNumberId}`)).statusCode).toBe(200)
  })

  it('deletes the media only through the number it belongs to', async () => {
    const { other, id } = twoNumbers()
    const wrong = await app.inject({ method: 'DELETE', url: `/v26.0/${id}?phone_number_id=${other}` })
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().error.message).toMatch(/^Unsupported delete request\. Object with ID '/)
    const right = await app.inject({ method: 'DELETE', url: `/v26.0/${id}?phone_number_id=${engine.state.defaultPhoneNumberId}` })
    expect(right.json()).toEqual({ success: true })
  })
})

describe('the media download URL', () => {
  it('names the verb when a business token reaches for another tenant’s bytes', async () => {
    const a = engine.createSignup()
    const b = engine.createSignup()
    const { access_token: token } = engine.exchangeCode(engine.state.defaultAppId, SECRET, a.code)
    const { id } = engine.uploadMedia(b.phone_number_id, { messaging_product: 'whatsapp', type: 'image/jpeg', file: { bytes: Buffer.from('x') } })
    const url = new URL(engine.getMedia(id, { baseUrl: 'http://localhost' })['url'] as string)
    const res = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/^Unsupported get request\. Object with ID '/)
  })

  it('checks the token even when the URL names no media', async () => {
    const { id } = engine.uploadMedia(engine.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      type: 'image/jpeg',
      file: { bytes: Buffer.from('x') },
    })
    const url = new URL(engine.getMedia(id, { baseUrl: 'http://localhost' })['url'] as string)
    url.searchParams.delete('mid')
    const token = engine.issueToken({ kind: 'short' }).access_token
    engine.clock.advance(3 * 60 * 60 * 1000)
    const res = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe(190)
  })
})

describe('errors that are not Meta’s', () => {
  it('answers a fault inside wamock 500, named as wamock’s, never as a 100 the request earned', async () => {
    vi.spyOn(engine, 'listTemplates').mockImplementation(() => {
      throw new TypeError('boom')
    })
    const res = await app.inject({ method: 'GET', url: `/v26.0/${engine.state.defaultWabaId}/message_templates` })
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toMatchObject({ code: 1, error_data: { details: 'wamock internal error: boom' } })
  })

  it('refuses a query parameter given twice, a repeated access_token included', async () => {
    const pnid = engine.state.defaultPhoneNumberId
    for (const query of ['fields=id&fields=quality_rating', 'access_token=a&access_token=b']) {
      const res = await app.inject({ method: 'GET', url: `/v26.0/${pnid}?${query}` })
      expect([res.statusCode, res.json().error.code], query).toEqual([400, 100])
    }
  })

  it('refuses a template component that is not an object as the caller’s 100', async () => {
    engine.createTemplate(engine.state.defaultWabaId, { name: 'hello', language: 'es_MX', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hola {{1}}' }] })
    engine.transitionTemplate(engine.state.defaultWabaId, 'hello', 'es_MX', 'APPROVED')
    const res = await app.inject({
      method: 'POST',
      url: `/v26.0/${engine.state.defaultPhoneNumberId}/messages`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ messaging_product: 'whatsapp', to: '5215555000001', type: 'template', template: { name: 'hello', language: { code: 'es_MX' }, components: [null] } }),
    })
    expect([res.statusCode, res.json().error.code]).toEqual([400, 100])
  })

  it('refuses a Host header that is no host as the caller’s 100', async () => {
    const { id } = engine.uploadMedia(engine.state.defaultPhoneNumberId, { messaging_product: 'whatsapp', type: 'image/png', file: { bytes: Buffer.from('x') } })
    const res = await app.inject({ method: 'GET', url: `/v26.0/${id}`, headers: { host: '[' } })
    expect([res.statusCode, res.json().error.code]).toEqual([400, 100])
  })

  it('reads a type that is not text as no type, never running the body’s own toString', async () => {
    engine.createTemplate(engine.state.defaultWabaId, { name: 'hello', language: 'es_MX', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hola {{1}}' }] })
    engine.transitionTemplate(engine.state.defaultWabaId, 'hello', 'es_MX', 'APPROVED')
    const poisoned = { toString: null }
    for (const components of [[{ type: poisoned }], [{ type: 'body', parameters: [{ type: poisoned }] }], [{ type: 'header', parameters: [{ type: poisoned }] }]]) {
      const res = await app.inject({
        method: 'POST',
        url: `/v26.0/${engine.state.defaultPhoneNumberId}/messages`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ messaging_product: 'whatsapp', to: '5215555000001', type: 'template', template: { name: 'hello', language: { code: 'es_MX' }, components } }),
      })
      expect(res.statusCode, JSON.stringify(components)).toBe(400)
      expect(res.json().error.code).not.toBe(1)
    }
  })

  it('answers a drain that hit the clock’s iteration cap 500, with Graph’s body', async () => {
    const forever = () => {
      engine.clock.at(engine.clock.now(), forever)
    }
    engine.clock.at(engine.clock.now(), forever)
    const res = await app.inject({ method: 'POST', url: '/__mock/time/advance', payload: '{"ms":0}' })
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toMatchObject({ code: 1, fbtrace_id: expect.any(String) })
    expect(res.json().error.error_data.details).toMatch(/timer iterations/)
  })

  it('reads an empty JSON body as no parameters, as Meta’s query-only calls send it', async () => {
    const { phone_number_id: pnid } = engine.createSignup({ phone: 'unverified' })
    const res = await app.inject({
      method: 'POST',
      url: `/v26.0/${pnid}/request_code?code_method=SMS&language=en_US`,
      headers: { 'content-type': 'application/json' },
    })
    expect(res.json()).toEqual({ success: true })
  })

  it('keeps Fastify’s guard against a __proto__ key in a JSON body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v26.0/${engine.state.defaultPhoneNumberId}/messages`,
      headers: { 'content-type': 'application/json' },
      payload: '{"__proto__":{"polluted":true},"messaging_product":"whatsapp"}',
    })
    expect(res.statusCode).toBe(400)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('still answers a body it could not read with Graph’s 100', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v26.0/${engine.state.defaultPhoneNumberId}/messages`,
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(100)
  })
})
