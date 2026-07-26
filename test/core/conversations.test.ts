import { describe, expect, it } from 'vitest'

import { Conversations } from '../../src/core/conversations.js'

const EPOCH = 1_750_000_000_000
const HOUR = 60 * 60 * 1000
const PNID = 'PNID_1'
const CUSTOMER = '5215555000001'

describe('Conversations — opening', () => {
  it('opens a service conversation when the customer started it', () => {
    // Category drives billing. A customer-initiated exchange is a "service"
    // conversation; getting this wrong is how integrations over-report cost.
    const c = new Conversations()
    const conv = c.open(PNID, CUSTOMER, { category: 'service' }, EPOCH)

    expect(conv.category).toBe('service')
    expect(conv.origin.type).toBe('service')
  })

  it('opens a utility conversation when a template started it', () => {
    const c = new Conversations()
    const conv = c.open(PNID, CUSTOMER, { category: 'utility' }, EPOCH)

    expect(conv.category).toBe('utility')
    expect(conv.origin.type).toBe('utility')
  })

  it('gives the conversation a deterministic id', () => {
    const idFor = () => new Conversations().open(PNID, CUSTOMER, { category: 'service' }, EPOCH).id
    expect(idFor()).toBe(idFor())
  })

  it('expires 24 hours after it opened', () => {
    const c = new Conversations()
    const conv = c.open(PNID, CUSTOMER, { category: 'service' }, EPOCH)

    expect(conv.expiresAt).toBe(EPOCH + 24 * HOUR)
  })
})

describe('Conversations — reuse', () => {
  it('reuses the open conversation instead of billing a new one', () => {
    // The expensive bug this guards: counting each message as a conversation.
    // Ten messages inside one 24h window are ONE billable conversation.
    const c = new Conversations()
    const first = c.open(PNID, CUSTOMER, { category: 'service' }, EPOCH)
    const second = c.open(PNID, CUSTOMER, { category: 'service' }, EPOCH + 3 * HOUR)

    expect(second.id).toBe(first.id)
  })

  it('keeps the original category when reusing', () => {
    // A utility conversation stays utility even if later messages are
    // free-form; Meta bills the conversation, not each message.
    const c = new Conversations()
    c.open(PNID, CUSTOMER, { category: 'utility' }, EPOCH)
    const reused = c.open(PNID, CUSTOMER, { category: 'service' }, EPOCH + HOUR)

    expect(reused.category).toBe('utility')
  })

  it('opens a new conversation once the old one expired', () => {
    const c = new Conversations()
    const first = c.open(PNID, CUSTOMER, { category: 'service' }, EPOCH)
    const later = c.open(PNID, CUSTOMER, { category: 'service' }, EPOCH + 25 * HOUR)

    expect(later.id).not.toBe(first.id)
  })

  it('tracks conversations per participant pair', () => {
    const c = new Conversations()
    const a = c.open(PNID, CUSTOMER, { category: 'service' }, EPOCH)
    const b = c.open(PNID, '5215555000009', { category: 'service' }, EPOCH)

    expect(b.id).not.toBe(a.id)
  })
})

describe('Conversations — webhook fields', () => {
  it('renders the conversation object Meta attaches to a status', () => {
    const c = new Conversations()
    const conv = c.open(PNID, CUSTOMER, { category: 'service' }, EPOCH)

    expect(c.toWebhookConversation(conv)).toEqual({
      id: conv.id,
      expiration_timestamp: String(Math.floor((EPOCH + 24 * HOUR) / 1000)),
      origin: { type: 'service' },
    })
  })

  it('renders the pricing object Meta attaches to a status', () => {
    const c = new Conversations()
    const conv = c.open(PNID, CUSTOMER, { category: 'marketing' }, EPOCH)

    expect(c.toWebhookPricing(conv)).toEqual({
      billable: true,
      pricing_model: 'CBP',
      category: 'marketing',
    })
  })
})

describe('Conversations — reset', () => {
  it('clear() forgets every conversation', () => {
    const c = new Conversations()
    const first = c.open(PNID, CUSTOMER, { category: 'service' }, EPOCH)
    c.clear()
    const afterReset = c.open(PNID, CUSTOMER, { category: 'service' }, EPOCH)

    expect(afterReset.id).toBe(first.id)
    expect(c.count()).toBe(1)
  })
})
