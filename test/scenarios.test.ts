import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { GraphError } from '../src/errors/graph-error.js'
import type { StatusBody } from '../src/webhooks/payloads.js'

const EPOCH = 1_750_000_000_000
const CUSTOMER = '5215555000001'

/**
 * An engine with the 24h window already open, and the webhook that opened it
 * already drained — so `received` contains only what the test itself causes.
 */
async function harness() {
  const received: string[] = []
  const e = new WamockEngine({
    appSecret: 's',
    mode: 'frozen',
    start: EPOCH,
    transport: async (d) => {
      received.push(d.body)
    },
  })
  e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
  e.clock.advance(0)
  await e.settle()
  received.length = 0
  return { e, received }
}

const text = { messaging_product: 'whatsapp', to: CUSTOMER, type: 'text', text: { body: 'hi' } }

const statusesFrom = (received: string[]): StatusBody[] =>
  received
    .map((body) => JSON.parse(body).entry[0].changes[0].value.statuses?.[0])
    .filter(Boolean) as StatusBody[]

const codeOf = (fn: () => unknown): number => {
  try {
    fn()
  } catch (err) {
    if (err instanceof GraphError) return err.code
    throw err
  }
  throw new Error('expected a GraphError, but nothing was thrown')
}

describe('at-least-once delivery', () => {
  it('duplicates every webhook when asked', async () => {
    // Meta is at-least-once. Receivers that assume exactly-once double-charge,
    // double-reply, or double-book — and only in production.
    const { e, received } = await harness()
    e.scenario.configure({ duplicateWebhooks: true })
    e.sendMessage(e.state.defaultPhoneNumberId, text)

    e.clock.advance(60_000)
    await e.settle()

    const ids = statusesFrom(received).map((s) => `${s.id}:${s.status}`)
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(2)
  })

  it('delivers statuses out of order when asked', async () => {
    // `delivered` before `sent` happens in the wild and breaks state machines
    // that assume monotonic progress.
    const { e, received } = await harness()
    e.scenario.configure({ outOfOrderStatuses: true })
    e.sendMessage(e.state.defaultPhoneNumberId, text)

    e.clock.advance(60_000)
    await e.settle()

    expect(statusesFrom(received).map((s) => s.status)).toEqual(['delivered', 'sent'])
  })

  it('keeps statuses in order by default', async () => {
    const { e, received } = await harness()
    e.sendMessage(e.state.defaultPhoneNumberId, text)

    e.clock.advance(60_000)
    await e.settle()

    expect(statusesFrom(received).map((s) => s.status)).toEqual(['sent', 'delivered'])
  })
})

describe('latency', () => {
  it('holds webhooks back by the configured delay', async () => {
    const { e, received } = await harness()
    e.scenario.configure({ latencyMs: 5000 })
    e.sendMessage(e.state.defaultPhoneNumberId, text)

    e.clock.advance(1000)
    await e.settle()
    expect(received).toHaveLength(0)

    e.clock.advance(60_000)
    await e.settle()
    expect(received.length).toBeGreaterThan(0)
  })
})

describe('the two failure axes', () => {
  it('sendFailureRate 1 fails the send with a retriable error', async () => {
    const { e } = await harness()
    e.scenario.configure({ sendFailureRate: 1 })

    expect(codeOf(() => e.sendMessage(e.state.defaultPhoneNumberId, text))).toBe(131000)
  })

  it('a failed send is not recorded', async () => {
    const { e } = await harness()
    e.scenario.configure({ sendFailureRate: 1 })
    try {
      e.sendMessage(e.state.defaultPhoneNumberId, text)
    } catch {
      /* expected */
    }
    expect(e.state.outbound()).toHaveLength(0)
  })

  it('webhookFailureRate 1 accepts the send but delivers nothing', async () => {
    // The silent one: the app is told everything worked and never hears back.
    const { e, received } = await harness()
    e.scenario.configure({ webhookFailureRate: 1 })

    expect(() => e.sendMessage(e.state.defaultPhoneNumberId, text)).not.toThrow()
    e.clock.advance(60_000)
    await e.settle()

    expect(received).toHaveLength(0)
  })
})

describe('forced errors', () => {
  it('fails the next send with the requested code, then recovers', async () => {
    const { e } = await harness()
    e.scenario.configure({ nextError: { code: 130429 } })

    expect(codeOf(() => e.sendMessage(e.state.defaultPhoneNumberId, text))).toBe(130429)
    expect(() => e.sendMessage(e.state.defaultPhoneNumberId, text)).not.toThrow()
  })

  it('can fail a fixed number of times, for backoff tests', async () => {
    const { e } = await harness()
    e.scenario.configure({ nextError: { code: 130429, times: 2 } })

    expect(codeOf(() => e.sendMessage(e.state.defaultPhoneNumberId, text))).toBe(130429)
    expect(codeOf(() => e.sendMessage(e.state.defaultPhoneNumberId, text))).toBe(130429)
    expect(() => e.sendMessage(e.state.defaultPhoneNumberId, text)).not.toThrow()
  })

  it('carries the real HTTP status of the forced code', async () => {
    const { e } = await harness()
    e.scenario.configure({ nextError: { code: 130429 } })
    try {
      e.sendMessage(e.state.defaultPhoneNumberId, text)
    } catch (err) {
      expect((err as GraphError).httpStatus).toBe(429)
    }
  })
})

describe('per-message pricing on statuses', () => {
  it('prices a reply to a customer as a free service message', async () => {
    const { e, received } = await harness()
    e.sendMessage(e.state.defaultPhoneNumberId, text)

    e.clock.advance(60_000)
    await e.settle()

    const priced = statusesFrom(received).filter((s) => s.pricing)
    expect(priced).toHaveLength(1)
    expect(priced[0]!.pricing).toEqual({
      billable: false,
      pricing_model: 'PMP',
      type: 'free_customer_service',
      category: 'service',
    })
  })

  it('puts pricing on exactly one status per message, the delivered one', async () => {
    // Meta sends it on `sent` or on one of `delivered`/`read`, never on both.
    // A receiver that reads it off `sent` only would find nothing here.
    const { e, received } = await harness()
    e.sendMessage(e.state.defaultPhoneNumberId, text)

    e.clock.advance(60_000)
    await e.settle()

    const statuses = statusesFrom(received)
    expect(statuses.find((s) => s.status === 'sent')?.pricing).toBeUndefined()
    expect(statuses.find((s) => s.status === 'delivered')?.pricing).toBeDefined()
  })

  it('keeps pricing on delivered when delivered arrives first', async () => {
    const { e, received } = await harness()
    e.scenario.configure({ outOfOrderStatuses: true })
    e.sendMessage(e.state.defaultPhoneNumberId, text)

    e.clock.advance(60_000)
    await e.settle()

    const statuses = statusesFrom(received)
    expect(statuses[0]!.status).toBe('delivered')
    expect(statuses[0]!.pricing).toBeDefined()
    expect(statuses[1]!.pricing).toBeUndefined()
  })

  it('sends no conversation object at all', async () => {
    // Omitted from v24.0 unless the message went out inside a free entry
    // point window. Code that keys billing on conversation.id gets undefined.
    const { e, received } = await harness()
    e.sendMessage(e.state.defaultPhoneNumberId, text)

    e.clock.advance(60_000)
    await e.settle()

    for (const status of statusesFrom(received)) {
      expect(status).not.toHaveProperty('conversation')
    }
  })

  it('bills a template under its category as a regular message', async () => {
    const received: string[] = []
    const e = new WamockEngine({
      appSecret: 's',
      mode: 'frozen',
      start: EPOCH,
      transport: async (d) => {
        received.push(d.body)
      },
    })
    e.createTemplate(e.state.defaultWabaId, {
      name: 'promo',
      language: 'es_MX',
      category: 'MARKETING',
      components: [],
    })
    e.transitionTemplate(e.state.defaultWabaId, 'promo', 'es_MX', 'APPROVED')

    e.sendMessage(e.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      to: CUSTOMER,
      type: 'template',
      template: { name: 'promo', language: { code: 'es_MX' }, components: [] },
    })
    e.clock.advance(60_000)
    await e.settle()

    expect(statusesFrom(received).find((s) => s.pricing)!.pricing).toEqual({
      billable: true,
      pricing_model: 'PMP',
      type: 'regular',
      category: 'marketing',
    })
  })

  it('prices every message on its own', async () => {
    // The opposite of the old conversation model: two replies are two priced
    // messages, each carrying its own pricing object.
    const { e, received } = await harness()
    e.sendMessage(e.state.defaultPhoneNumberId, text)
    e.sendMessage(e.state.defaultPhoneNumberId, text)

    e.clock.advance(60_000)
    await e.settle()

    expect(statusesFrom(received).filter((s) => s.pricing)).toHaveLength(2)
  })

  it('spends the free tier even when the webhooks are dropped', async () => {
    const { e } = await harness()
    e.scenario.configure({ webhookFailureRate: 1 })
    e.sendMessage(e.state.defaultPhoneNumberId, text)
    e.scenario.reset()

    for (let i = 0; i < 999; i++) e.pricing.price(e.state.defaultPhoneNumberId, 'service', e.clock.now())
    expect(e.pricing.price(e.state.defaultPhoneNumberId, 'service', e.clock.now())['type']).toBe('regular')
  })
})

describe('forcing a status by hand', () => {
  it('delivers the requested status for a known message', async () => {
    const { e, received } = await harness()
    const wamid = e.sendMessage(e.state.defaultPhoneNumberId, text).messages[0]!.id
    received.length = 0

    e.forceStatus(wamid, 'read')
    e.clock.advance(0)
    await e.settle()

    expect(statusesFrom(received).map((s) => s.status)).toContain('read')
  })

  it('attaches an error code to a forced failure', async () => {
    const { e, received } = await harness()
    const wamid = e.sendMessage(e.state.defaultPhoneNumberId, text).messages[0]!.id
    received.length = 0

    e.forceStatus(wamid, 'failed', 131026)
    e.clock.advance(0)
    await e.settle()

    const failed = statusesFrom(received).find((s) => s.status === 'failed')!
    expect(failed.errors?.[0]).toMatchObject({ code: 131026 })
  })

  it('takes an error code only with failed, the one status Meta gives errors', async () => {
    const { e, received } = await harness()
    const voice = { messaging_product: 'whatsapp', to: CUSTOMER, type: 'audio', audio: { link: 'https://example.com/n.ogg', voice: true } }
    const wamid = e.sendMessage(e.state.defaultPhoneNumberId, voice).messages[0]!.id
    received.length = 0
    for (const status of ['sent', 'delivered', 'read', 'played'] as const) {
      expect(codeOf(() => e.forceStatus(wamid, status, 131026))).toBe(100)
    }
    // And failed always takes one: a failed status without errors does not exist.
    expect(codeOf(() => e.forceStatus(wamid, 'failed'))).toBe(100)
    e.clock.advance(0)
    await e.settle()
    expect(statusesFrom(received)).toEqual([])
  })

  it('rejects a wamid the mock never issued', async () => {
    const { e } = await harness()
    expect(codeOf(() => e.forceStatus('wamid.NOPE', 'read'))).toBe(100)
  })

  it('plays a voice message, which Meta reports with its own played status', async () => {
    const { e, received } = await harness()
    const voice = { messaging_product: 'whatsapp', to: CUSTOMER, type: 'audio', audio: { link: 'https://example.com/note.ogg', voice: true } }
    const wamid = e.sendMessage(e.state.defaultPhoneNumberId, voice).messages[0]!.id
    received.length = 0

    e.forceStatus(wamid, 'played')
    e.clock.advance(0)
    await e.settle()

    const played = statusesFrom(received)
    expect(played.map((s) => [s.id, s.status])).toEqual([[wamid, 'played']])
    // Meta's BSUID reference: contacts only on sent, delivered and read.
    expect(JSON.parse(received[0]!).entry[0].changes[0].value).not.toHaveProperty('contacts')
    expect(played[0]).not.toHaveProperty('pricing')
    expect(played[0]).not.toHaveProperty('errors')
  })

  it('refuses played for anything but a voice message: Meta never sends it there', async () => {
    const { e, received } = await harness()
    const textId = e.sendMessage(e.state.defaultPhoneNumberId, text).messages[0]!.id
    const audio = { messaging_product: 'whatsapp', to: CUSTOMER, type: 'audio', audio: { link: 'https://example.com/song.mp3' } }
    const audioId = e.sendMessage(e.state.defaultPhoneNumberId, audio).messages[0]!.id
    const basic = { ...audio, audio: { link: 'https://example.com/song.mp3', voice: false } }
    const basicId = e.sendMessage(e.state.defaultPhoneNumberId, basic).messages[0]!.id
    // A text that happens to carry a stray `audio` key is still a text.
    const strayId = e.sendMessage(e.state.defaultPhoneNumberId, { ...text, audio: { voice: true } }).messages[0]!.id
    received.length = 0

    for (const id of [textId, audioId, basicId, strayId]) expect(codeOf(() => e.forceStatus(id, 'played'))).toBe(100)
    e.clock.advance(0)
    await e.settle()
    expect(statusesFrom(received).filter((s) => s.status === 'played')).toEqual([])
  })
})

describe('reset', () => {
  it('returns the scenario to its inert defaults', async () => {
    const { e } = await harness()
    e.scenario.configure({ sendFailureRate: 1, duplicateWebhooks: true })

    e.reset()

    expect(e.scenario.config.duplicateWebhooks).toBe(false)
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    expect(() => e.sendMessage(e.state.defaultPhoneNumberId, text)).not.toThrow()
  })
})
