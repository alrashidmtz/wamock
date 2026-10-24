import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { createServer } from '../src/server.js'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

const EPOCH = 1_750_000_000_000
const CUSTOMER = '5215555000001'

let engine: WamockEngine
let app: FastifyInstance
let received: string[]

beforeEach(async () => {
  received = []
  engine = new WamockEngine({
    appSecret: 's',
    mode: 'frozen',
    start: EPOCH,
    transport: async (d) => {
      received.push(d.body)
    },
  })
  app = createServer(engine)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const post = async (url: string, payload: unknown): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  })

/** Open the window and drop the webhook that opened it. */
async function openWindow(): Promise<void> {
  await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })
  received.length = 0
}

const sendText = () =>
  post(`/v19.0/${engine.state.defaultPhoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to: CUSTOMER,
    type: 'text',
    text: { body: 'hi' },
  })

const statuses = () =>
  received
    .map((b) => JSON.parse(b).entry[0].changes[0].value.statuses?.[0])
    .filter(Boolean) as Array<{ status: string; errors?: Array<{ code: number }> }>

describe('POST /__mock/scenario', () => {
  it('configures duplication and reports the resulting config', async () => {
    const res = await post('/__mock/scenario', { duplicateWebhooks: true })

    expect(res.statusCode).toBe(200)
    expect(res.json().scenario).toMatchObject({ duplicateWebhooks: true })
  })

  it('takes effect on subsequent sends', async () => {
    await openWindow()
    await post('/__mock/scenario', { duplicateWebhooks: true })
    await sendText()

    engine.clock.advance(60_000)
    await engine.settle()

    expect(statuses()).toHaveLength(4)
  })

  it('forces the next send to fail with a chosen code', async () => {
    await openWindow()
    await post('/__mock/scenario', { nextError: { code: 130429 } })

    const res = await sendText()

    expect(res.statusCode).toBe(429)
    expect(res.json().error.code).toBe(130429)
  })

  it('rejects a failure rate outside 0..1 with a Meta-shaped error', async () => {
    const res = await post('/__mock/scenario', { sendFailureRate: 5 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(100)
  })

  it('rejects an unknown knob rather than silently ignoring it', async () => {
    // Silently accepting a typo'd knob is worse than failing: the scenario
    // looks configured and does nothing.
    const res = await post('/__mock/scenario', { duplicateWebhook: true })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /__mock/statuses', () => {
  it('drives a message to read', async () => {
    await openWindow()
    const wamid = (await sendText()).json().messages[0].id
    received.length = 0

    const res = await post('/__mock/statuses', { id: wamid, status: 'read' })

    expect(res.statusCode).toBe(200)
    expect(statuses().map((s) => s.status)).toContain('read')
  })

  it('drives a message to failed with an error code', async () => {
    await openWindow()
    const wamid = (await sendText()).json().messages[0].id
    received.length = 0

    await post('/__mock/statuses', { id: wamid, status: 'failed', error: 131026 })

    expect(statuses().find((s) => s.status === 'failed')?.errors?.[0]?.code).toBe(131026)
  })

  it('drives a voice message to played, and refuses it for a text', async () => {
    await openWindow()
    const voice = await post(`/v19.0/${engine.state.defaultPhoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: CUSTOMER,
      type: 'audio',
      audio: { link: 'https://example.com/note.ogg', voice: true },
    })
    const textId = (await sendText()).json().messages[0].id
    received.length = 0

    expect((await post('/__mock/statuses', { id: voice.json().messages[0].id, status: 'played' })).statusCode).toBe(200)
    expect(statuses().map((s) => s.status)).toEqual(['played'])

    const refused = await post('/__mock/statuses', { id: textId, status: 'played' })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error.code).toBe(100)
  })

  it('rejects an unknown status value', async () => {
    const res = await post('/__mock/statuses', { id: 'wamid.X', status: 'pondering' })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a wamid the mock never issued', async () => {
    const res = await post('/__mock/statuses', { id: 'wamid.NOPE', status: 'read' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(100)
  })
})


describe('POST /__mock/inbound — each message type', () => {
  it('takes a Coexistence customer’s edit and revoke, and refuses them elsewhere', async () => {
    const tenant = (await post('/__mock/embedded-signup', { coexistence: true, subscribed: true })).json()
    const original = (await post('/__mock/inbound', { from: CUSTOMER, phone_number_id: tenant.phone_number_id, text: 'hola' })).json()
    const edit = await post('/__mock/inbound', {
      from: CUSTOMER,
      phone_number_id: tenant.phone_number_id,
      edit: { message_id: original.message_id, text: 'hola!' },
    })
    expect(edit.statusCode).toBe(200)
    expect(JSON.parse(received.at(-1)!).entry[0].changes[0].value.messages[0].edit.original_message_id).toBe(original.message_id)

    const plain = (await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })).json()
    expect((await post('/__mock/inbound', { from: CUSTOMER, revoke: { message_id: plain.message_id } })).statusCode).toBe(400)
  })

  const lastMessage = () => JSON.parse(received.at(-1)!).entry[0].changes[0].value.messages[0]

  it('stores the bytes given as base64 `data`, so the media downloads as sent', async () => {
    const bytes = Buffer.from('%PDF-1.4 the real file')
    const res = await post('/__mock/inbound', {
      from: CUSTOMER,
      document: { filename: 'r.pdf', mime_type: 'application/pdf', data: bytes.toString('base64') },
    })
    expect(res.statusCode).toBe(200)
    const message = lastMessage()
    expect(message).toMatchObject({ type: 'document', document: { filename: 'r.pdf', mime_type: 'application/pdf' } })
    const url = new URL(engine.getMedia(message.document.id)['url'] as string)
    expect(engine.downloadMedia(Object.fromEntries(url.searchParams))?.bytes.equals(bytes)).toBe(true)
  })

  it('delivers a location, contacts and an unsupported message under their own type', async () => {
    await post('/__mock/inbound', { from: CUSTOMER, location: { latitude: 1, longitude: 2 } })
    expect(lastMessage()).toMatchObject({ type: 'location', location: { latitude: 1, longitude: 2 } })

    const contacts = [{ name: { formatted_name: 'Ana' } }]
    await post('/__mock/inbound', { from: CUSTOMER, contacts })
    expect(lastMessage()).toMatchObject({ type: 'contacts', contacts })

    expect((await post('/__mock/inbound', { from: CUSTOMER, unsupported: { type: 'edit' } })).statusCode).toBe(200)
    expect(lastMessage()).toMatchObject({ type: 'unsupported', unsupported: { type: 'edit' } })
  })
})

describe('POST /__mock/quality', () => {
  it.each(['RED', 'YELLOW', 'GREEN', 'UNKNOWN'] as const)('takes %s, one of Meta’s quality ratings', async (rating) => {
    expect((await post('/__mock/quality', { quality_rating: rating })).statusCode).toBe(200)
    expect(engine.state.phoneNumber(engine.state.defaultPhoneNumberId)?.qualityRating).toBe(rating)
  })
})

describe('the control API and Graph tokens', () => {
  it('ignores an Authorization header, even one carrying an expired wamock token', async () => {
    // A test harness often sets one header on every request it makes.
    const token = engine.issueToken({ kind: 'short' }).access_token
    engine.clock.advance(3 * 60 * 60 * 1000)
    const res = await app.inject({
      method: 'POST',
      url: '/__mock/inbound',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: JSON.stringify({ from: CUSTOMER, text: 'hola' }),
    })
    expect(res.statusCode).toBe(200)
    expect(received).toHaveLength(1)
  })
})
