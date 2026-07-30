import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { createWamock } from '../src/lib.js'
import type { Wamock } from '../src/lib.js'

/**
 * The control API delivers what it triggers, before it answers (#4).
 *
 * A webhook with no delay of its own is scheduled at the current instant, and a
 * frozen clock never reaches an instant by itself. The library helpers have
 * always closed that gap; the HTTP door did not — so `POST /__mock/quality`
 * changed the rating, returned 200, and announced nothing. Three signals said
 * it worked and the one that mattered stayed silent.
 *
 * These tests go through `mock.baseUrl` with plain `fetch`, exactly as the
 * field report did. Not one of them calls `advance()`, and that is the point.
 */

const EPOCH = 1_750_000_000_000
const CUSTOMER = '5215555000001'

interface Change {
  field: string
  value: { statuses?: { status: string }[] }
}

let mock: Wamock
let fields: string[]
/** The `status` of every delivery receipt that arrived, in order. */
let statuses: string[]

beforeEach(async () => {
  fields = []
  statuses = []
  mock = await createWamock({
    appSecret: 'app-secret',
    start: EPOCH,
    // Deliberately async. A real receiver writes to a queue or a database
    // before it returns, and "the timer fired" is not "the webhook landed" —
    // a synchronous receiver hides the whole gap these tests are about.
    onWebhook: async (delivery) => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const changes: Change[] = JSON.parse(delivery.body).entry.flatMap(
        (entry: { changes: Change[] }) => entry.changes,
      )
      for (const change of changes) {
        fields.push(change.field)
        for (const status of change.value.statuses ?? []) statuses.push(status.status)
      }
    },
  })
})

afterEach(async () => {
  await mock.close()
})

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${mock.baseUrl}${path}`, { method: 'POST', body: JSON.stringify(body) })

/** Everything that arrived, minus the `messages` traffic each test sets up. */
const changes = (): string[] => fields.filter((field) => field !== 'messages')

describe('the control API delivers before it answers', () => {
  it('announces a quality change', async () => {
    const res = await post('/__mock/quality', { quality_rating: 'RED' })

    expect(res.status).toBe(200)
    expect(changes()).toEqual(['phone_number_quality_update'])
  })

  it('announces a template transition', async () => {
    await mock.approveTemplate({ name: 'recordatorio', language: 'es_MX' })
    fields.length = 0

    const res = await post('/__mock/templates/recordatorio/es_MX/transition', { to: 'PAUSED' })

    expect(res.status).toBe(200)
    expect(changes()).toEqual(['message_template_status_update'])
  })

  it('delivers an inbound message', async () => {
    const res = await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })

    expect(res.status).toBe(200)
    expect(fields).toEqual(['messages'])
  })

  it('delivers a forced status', async () => {
    await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })
    const sent = await mock.send({ to: CUSTOMER, text: 'buenas' })
    statuses.length = 0

    const res = await post('/__mock/statuses', { id: sent.id, status: 'read' })

    expect(res.status).toBe(200)
    expect(statuses).toEqual(['read'])
  })

  it('has already delivered by the time /__mock/time/advance answers', async () => {
    await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })
    await mock.send({ to: CUSTOMER, text: 'buenas' })
    statuses.length = 0

    // `sent` and `delivered` are due at +50ms and +500ms, so this is the
    // endpoint that makes them fire. It used to move the clock and answer
    // without waiting for the deliveries it had just kicked off.
    const res = await post('/__mock/time/advance', { ms: 60_000 })

    expect(res.status).toBe(200)
    expect(statuses).toEqual(['sent', 'delivered'])
  })

  it('agrees with the library helper it mirrors', async () => {
    await mock.approveTemplate({ name: 'gemelo', language: 'es_MX' })
    fields.length = 0

    await mock.transitionTemplate({ name: 'gemelo', language: 'es_MX', to: 'PAUSED' })
    const viaHelper = [...changes()]
    fields.length = 0

    await post('/__mock/templates/gemelo/es_MX/transition', { to: 'APPROVED' })

    // The bug existed because only one of these two doors was ever exercised.
    expect(changes()).toEqual(viaHelper)
  })
})

describe('what the flush must NOT do', () => {
  it('leaves delivery statuses waiting for the clock, as designed', async () => {
    await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })
    fields.length = 0

    // Straight at the Graph route, so no control-API flush is involved. Meta
    // does not answer a send with its statuses either, and a mock that
    // delivered them here would hide every ordering bug it exists to expose.
    await fetch(`${mock.baseUrl}/v23.0/${mock.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: CUSTOMER,
        type: 'text',
        text: { body: 'buenas' },
      }),
    })

    expect(statuses).toEqual([])

    await mock.time.advance(60_000)
    expect(statuses).toEqual(['sent', 'delivered'])
  })

  it('does not deliver a webhook twice', async () => {
    await post('/__mock/quality', { quality_rating: 'RED' })
    // A second flush of the same already-drained queue must be a no-op — the
    // round loop stops as soon as a round delivers nothing.
    await mock.time.advance(0)

    expect(changes()).toEqual(['phone_number_quality_update'])
  })
})

/**
 * The round loop only makes sense on a frozen clock, where nothing else will
 * ever fire a due timer. A live clock has a background tick doing exactly that,
 * so repeating rounds there counts unrelated concurrent deliveries as progress
 * and never converges — which turned a valid control call into a 400 blaming
 * the receiver for a loop it was not in.
 */
describe('flush rounds', () => {
  /**
   * A receiver that answers every webhook with another one, asynchronously.
   *
   * The await is what makes this the flush's problem. Re-enqueueing
   * synchronously never escapes the drain that is running, so the clock's own
   * iteration guard catches it first; a real receiver awaits something before
   * it reacts, and lands the new work after `advance()` has already returned.
   */
  const pingPong = (engine: WamockEngine): void => {
    engine.deliverer.setTransport(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      engine.setQuality(engine.state.defaultPhoneNumberId, 'RED')
    })
  }

  it('gives up on a frozen clock, naming the runaway receiver', async () => {
    const engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    pingPong(engine)
    engine.setQuality(engine.state.defaultPhoneNumberId, 'RED')

    await expect(engine.flush()).rejects.toThrow(/exceeded 100 rounds/)
  })

  it('takes a single round on a live clock, whose tick fires the rest', async () => {
    const engine = new WamockEngine({ appSecret: 's', mode: 'live' })
    pingPong(engine)
    engine.setQuality(engine.state.defaultPhoneNumberId, 'RED')

    await expect(engine.flush()).resolves.toBeUndefined()
  })
})
