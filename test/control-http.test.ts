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

/** Open the window and drain the webhook that opened it. */
async function openWindow(): Promise<void> {
  await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })
  engine.clock.advance(0)
  await engine.settle()
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
    engine.clock.advance(0)
    await engine.settle()

    expect(res.statusCode).toBe(200)
    expect(statuses().map((s) => s.status)).toContain('read')
  })

  it('drives a message to failed with an error code', async () => {
    await openWindow()
    const wamid = (await sendText()).json().messages[0].id
    received.length = 0

    await post('/__mock/statuses', { id: wamid, status: 'failed', error: 131026 })
    engine.clock.advance(0)
    await engine.settle()

    expect(statuses().find((s) => s.status === 'failed')?.errors?.[0]?.code).toBe(131026)
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

describe('media endpoints', () => {
  it('uploads and then resolves media metadata', async () => {
    const upload = await post(`/v19.0/${engine.state.defaultPhoneNumberId}/media`, {
      messaging_product: 'whatsapp',
      type: 'image/jpeg',
    })
    expect(upload.statusCode).toBe(200)

    const res = await app.inject({ method: 'GET', url: `/v19.0/${upload.json().id}` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ messaging_product: 'whatsapp', mime_type: 'image/jpeg' })
  })

  it('reports an expired media id as gone', async () => {
    const upload = await post(`/v19.0/${engine.state.defaultPhoneNumberId}/media`, {
      messaging_product: 'whatsapp',
      type: 'image/jpeg',
    })
    engine.clock.advance(10 * 60 * 1000)

    const res = await app.inject({ method: 'GET', url: `/v19.0/${upload.json().id}` })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.error_data.details).toMatch(/expired/i)
  })
})
