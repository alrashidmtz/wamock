import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { createServer } from '../src/server.js'

/**
 * Free entry point windows: a user writes from a Click-to-WhatsApp ad, the
 * business answers inside the service window, and for up to 7 days every
 * message is free. It is the one case where v24.0 still sends a
 * `conversation` object, so an integration that stopped reading it entirely
 * cannot tell these messages from billed ones.
 */

const EPOCH = 1_750_000_000_000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const CUSTOMER = '5215555000001'
const REFERRAL = { source_url: 'https://fb.me/3cr4Wqqkv', source_id: '120226305854810726', source_type: 'ad' }

function harness() {
  const payloads: string[] = []
  const e = new WamockEngine({
    appSecret: 's',
    mode: 'frozen',
    start: EPOCH,
    transport: async (d) => {
      payloads.push(d.body)
    },
  })
  e.createTemplate(e.state.defaultWabaId, { name: 'promo', language: 'es_MX', category: 'MARKETING', components: [] })
  e.transitionTemplate(e.state.defaultWabaId, 'promo', 'es_MX', 'APPROVED')
  const statusesOf = (id: string) =>
    payloads
      .map((b) => JSON.parse(b).entry[0].changes[0])
      .filter((c) => c.field === 'messages' && c.value.statuses?.[0]?.id === id)
      .map((c) => c.value.statuses[0])
  const text = () =>
    e.sendMessage(e.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      to: CUSTOMER,
      type: 'text',
      text: { body: 'hola' },
    }).messages[0]!.id
  const template = () =>
    e.sendMessage(e.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      to: CUSTOMER,
      type: 'template',
      template: { name: 'promo', language: { code: 'es_MX' } },
    }).messages[0]!.id
  const fromAd = () =>
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'info?' }, referral: REFERRAL } })
  const flush = async () => {
    e.clock.advance(60_000)
    await e.settle()
  }
  // The template's own approval webhook is setup, not what a test looks at.
  e.clock.advance(0)
  payloads.length = 0
  return { e, payloads, statusesOf, text, template, fromAd, flush }
}

const FREE = { billable: false, pricing_model: 'PMP', type: 'free_entry_point', category: 'referral_conversion' }

describe('free entry point windows', () => {
  it('passes the ad referral through on the inbound message', async () => {
    const { payloads, fromAd, flush } = harness()
    fromAd()
    await flush()
    expect(JSON.parse(payloads[0]!).entry[0].changes[0].value.messages[0].referral).toEqual(REFERRAL)
  })

  it('makes the reply to an ad free, and opens the window with it', async () => {
    const { statusesOf, text, fromAd, flush, e } = harness()
    fromAd()
    e.clock.advance(HOUR)
    const repliedAt = e.clock.now()
    const id = text()
    await flush()

    const [sent, delivered] = statusesOf(id)
    expect(delivered.pricing).toEqual(FREE)
    expect(sent.conversation).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      expiration_timestamp: String(Math.floor((repliedAt + 7 * DAY) / 1000)),
      origin: { type: 'referral_conversion' },
    })
    // expiration_timestamp rides on `sent` only.
    expect(delivered.conversation).toEqual({ id: sent.conversation.id, origin: { type: 'referral_conversion' } })
  })

  it('keeps every category free inside the window, marketing included, under one conversation id', async () => {
    const { statusesOf, text, template, fromAd, flush, e } = harness()
    fromAd()
    const first = text()
    e.clock.advance(5 * DAY)
    const second = template()
    await flush()

    expect(statusesOf(second)[1].pricing).toEqual(FREE)
    expect(statusesOf(second)[0].conversation.id).toBe(statusesOf(first)[0].conversation.id)
  })

  it('bills again once the 7 days are over, and drops the conversation object', async () => {
    const { statusesOf, text, template, fromAd, flush, e } = harness()
    fromAd()
    text()
    e.clock.advance(7 * DAY)
    const id = template()
    await flush()

    expect(statusesOf(id)[1].pricing).toMatchObject({ type: 'regular', category: 'marketing' })
    expect(statusesOf(id)[0]).not.toHaveProperty('conversation')
  })

  it('opens nothing for a reply after the service window closed', async () => {
    const { statusesOf, template, fromAd, flush, e } = harness()
    fromAd()
    e.clock.advance(25 * HOUR)
    const id = template()
    await flush()
    expect(statusesOf(id)[1].pricing).toMatchObject({ type: 'regular' })
  })

  it('opens nothing for a user who did not come from an ad', async () => {
    const { statusesOf, text, flush, e } = harness()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hi' } } })
    const id = text()
    await flush()
    expect(statusesOf(id)[1].pricing).toMatchObject({ type: 'free_customer_service' })
  })

  it('does not spend the monthly service tier', () => {
    const { e, text, fromAd } = harness()
    // Leave exactly one free service message in the tier.
    for (let i = 0; i < 999; i++) e.pricing.price(e.state.defaultPhoneNumberId, 'service', e.clock.now())
    fromAd()
    for (let i = 0; i < 3; i++) text()
    const last = e.pricing.price(e.state.defaultPhoneNumberId, 'service', e.clock.now())
    expect(last['type']).toBe('free_customer_service')
  })

  it('is forgotten on reset', async () => {
    const { statusesOf, text, fromAd, flush, e } = harness()
    fromAd()
    text()
    e.reset()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hi' } } })
    const id = text()
    await flush()
    expect(statusesOf(id)[1].pricing).toMatchObject({ type: 'free_customer_service' })
  })

  it('takes a referral on POST /__mock/inbound', async () => {
    const { e, payloads } = harness()
    const app = createServer(e)
    await app.ready()
    try {
      await app.inject({
        method: 'POST',
        url: '/__mock/inbound',
        payload: JSON.stringify({ from: CUSTOMER, text: 'info?', referral: REFERRAL }),
      })
      expect(JSON.parse(payloads.at(-1)!).entry[0].changes[0].value.messages[0].referral).toEqual(REFERRAL)

      const res = await app.inject({
        method: 'POST',
        url: '/__mock/inbound',
        payload: JSON.stringify({ from: CUSTOMER, text: 'x', referral: { source: 'ad' } }),
      })
      expect(res.json().error.error_data.details).toBe("referral: Unrecognized key(s) in object: 'source'")
    } finally {
      await app.close()
    }
  })
})
