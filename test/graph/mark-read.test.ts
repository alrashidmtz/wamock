import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WamockEngine } from '../../src/core/engine.js'
import { createServer } from '../../src/server.js'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

/**
 * Marking an inbound message as read, with or without a typing indicator.
 *
 * Both go to the same `POST /{phone_number_id}/messages` as a send, with a
 * body that has no `to` and no `type`. A mock that only knows sends answers
 * these with `(#100)`, and the integration learns to skip read receipts.
 */

const EPOCH = 1_750_000_000_000
const CUSTOMER = '5215555000001'

let engine: WamockEngine
let app: FastifyInstance

beforeEach(async () => {
  engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
  app = createServer(engine)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const messages = (body: unknown, phoneNumberId = engine.state.defaultPhoneNumberId): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST',
    url: `/v26.0/${phoneNumberId}/messages`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  })

const inbound = (): string =>
  engine.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } }).messageId

describe('mark as read', () => {
  it('answers {success: true} for a message the customer sent', async () => {
    const id = inbound()
    const res = await messages({ messaging_product: 'whatsapp', status: 'read', message_id: id })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true })
  })

  it('records the receipt so a test can assert on it', async () => {
    const id = inbound()
    await messages({ messaging_product: 'whatsapp', status: 'read', message_id: id })

    expect(engine.state.readReceipts()).toEqual([
      {
        messageId: id,
        phoneNumberId: engine.state.defaultPhoneNumberId,
        typingIndicator: false,
        at: EPOCH,
      },
    ])
  })

  it('is not a send: nothing is recorded as outbound and no status follows', async () => {
    const id = inbound()
    await messages({ messaging_product: 'whatsapp', status: 'read', message_id: id })
    engine.clock.advance(60_000)

    expect(engine.state.outbound()).toHaveLength(0)
    expect(engine.deliverer.log().filter((d) => JSON.stringify(d.payload).includes('statuses'))).toHaveLength(0)
  })

  it('shows a typing indicator when asked', async () => {
    const id = inbound()
    const res = await messages({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: id,
      typing_indicator: { type: 'text' },
    })

    expect(res.json()).toEqual({ success: true })
    expect(engine.state.readReceipts()[0]!.typingIndicator).toBe(true)
  })

  it('rejects an unknown message id with 131009, as Meta documents', async () => {
    const res = await messages({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.NOPE' })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatchObject({
      code: 131009,
      message: '(#131009) Parameter value is not valid',
    })
  })

  it('rejects a message id that arrived on a different number', async () => {
    const other = engine.createSignup().phone_number_id
    const id = inbound()

    const res = await messages({ messaging_product: 'whatsapp', status: 'read', message_id: id }, other)
    expect(res.json().error.code).toBe(131009)
  })

  it('rejects an outbound wamid: only received messages can be marked read', async () => {
    inbound()
    const sent = engine.sendMessage(engine.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      to: CUSTOMER,
      type: 'text',
      text: { body: 'hi' },
    }).messages[0]!.id

    const res = await messages({ messaging_product: 'whatsapp', status: 'read', message_id: sent })
    expect(res.json().error.code).toBe(131009)
  })

  it('requires a message_id', async () => {
    const res = await messages({ messaging_product: 'whatsapp', status: 'read' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(100)
    expect(res.json().error.error_data.details).toMatch(/message_id/)
  })

  it('rejects a typing indicator type other than text', async () => {
    const id = inbound()
    const res = await messages({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: id,
      typing_indicator: { type: 'audio' },
    })
    expect(res.json().error.code).toBe(100)
    expect(res.json().error.error_data.details).toMatch(/typing_indicator/)
  })

  it('still checks the token like any other call', async () => {
    const token = engine.issueToken({ kind: 'short' }).access_token
    const id = inbound()
    engine.clock.advance(3 * 60 * 60 * 1000)

    const res = await app.inject({
      method: 'POST',
      url: `/v26.0/${engine.state.defaultPhoneNumberId}/messages`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: id }),
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe(190)
  })

  it('works after the 24h window closed: reading is not messaging', async () => {
    const id = inbound()
    engine.clock.advance(25 * 60 * 60 * 1000)
    const res = await messages({ messaging_product: 'whatsapp', status: 'read', message_id: id })
    expect(res.json()).toEqual({ success: true })
  })

  it('forgets receipts and received ids on reset', async () => {
    const id = inbound()
    await messages({ messaging_product: 'whatsapp', status: 'read', message_id: id })
    engine.reset()

    expect(engine.state.readReceipts()).toEqual([])
    expect((await messages({ messaging_product: 'whatsapp', status: 'read', message_id: id })).json().error.code).toBe(131009)
  })
})
