import { describe, expect, it } from 'vitest'

import { FREE_SERVICE_MESSAGES_PER_MONTH, isAuthInternational, Pricing } from '../../src/core/pricing.js'

const OCT_2026 = Date.UTC(2026, 9, 15)
const NOV_2026 = Date.UTC(2026, 10, 1)
const PNID = 'PNID_1'

describe('Pricing — per message, not per conversation', () => {
  it('reports per-message pricing for every category', () => {
    // CBP only ever appears on webhooks sent before 2025-07-01.
    const p = new Pricing()
    for (const category of ['service', 'utility', 'marketing', 'authentication'] as const) {
      expect(p.price(PNID, category, OCT_2026)['pricing_model']).toBe('PMP')
    }
  })

  it('bills a template as regular, including utility', () => {
    // As of 2026-10-01 a utility template is charged even inside an open
    // customer service window; it used to be free_customer_service.
    const p = new Pricing()
    for (const category of ['utility', 'marketing', 'authentication'] as const) {
      expect(p.price(PNID, category, OCT_2026)).toEqual({
        billable: true,
        pricing_model: 'PMP',
        type: 'regular',
        category,
      })
    }
  })

  it('gives each number 1,000 free service messages a month', () => {
    expect(FREE_SERVICE_MESSAGES_PER_MONTH).toBe(1_000)
  })

  it('prices service messages inside the free tier as free_customer_service', () => {
    const p = new Pricing()
    expect(p.price(PNID, 'service', OCT_2026)).toEqual({
      billable: false,
      pricing_model: 'PMP',
      type: 'free_customer_service',
      category: 'service',
    })
  })

  it('charges the 1,001st service message of the month', () => {
    const p = new Pricing()
    for (let i = 0; i < FREE_SERVICE_MESSAGES_PER_MONTH; i++) {
      expect(p.price(PNID, 'service', OCT_2026)['type']).toBe('free_customer_service')
    }
    expect(p.price(PNID, 'service', OCT_2026)).toEqual({
      billable: true,
      pricing_model: 'PMP',
      type: 'regular',
      category: 'service',
    })
  })

  it('does not spend the free tier on templates', () => {
    const p = new Pricing()
    for (let i = 0; i < FREE_SERVICE_MESSAGES_PER_MONTH; i++) p.price(PNID, 'utility', OCT_2026)
    expect(p.price(PNID, 'service', OCT_2026)['type']).toBe('free_customer_service')
  })

  it('keeps one free tier per business phone number', () => {
    const p = new Pricing()
    for (let i = 0; i < FREE_SERVICE_MESSAGES_PER_MONTH; i++) p.price(PNID, 'service', OCT_2026)
    expect(p.price('PNID_2', 'service', OCT_2026)['type']).toBe('free_customer_service')
  })

  it('resets the free tier at the start of the next month, with no roll-over', () => {
    const p = new Pricing()
    for (let i = 0; i <= FREE_SERVICE_MESSAGES_PER_MONTH; i++) p.price(PNID, 'service', OCT_2026)
    expect(p.price(PNID, 'service', NOV_2026 - 1)['type']).toBe('regular')
    expect(p.price(PNID, 'service', NOV_2026)['type']).toBe('free_customer_service')
  })

  it('clear() forgets what each number has used', () => {
    const p = new Pricing()
    for (let i = 0; i < FREE_SERVICE_MESSAGES_PER_MONTH; i++) p.price(PNID, 'service', OCT_2026)
    p.clear()
    expect(p.price(PNID, 'service', OCT_2026)['type']).toBe('free_customer_service')
  })
})

// Not pinned: a reply 24h+ after the ad, inside a window a later plain
// message renewed. Meta says "respond within the customer service window"
// without saying whether a renewed window still counts.
describe('free entry point windows', () => {
  it('give every window its own id', () => {
    const p = new Pricing()
    const service = { open: true, windowMs: 24 * 60 * 60 * 1000 }
    for (const waId of ['5215555000001', '5215555000002']) p.noteAdEntry(PNID, waId, OCT_2026)
    const first = p.entryPoint(PNID, '5215555000001', OCT_2026, service)
    const second = p.entryPoint(PNID, '5215555000002', OCT_2026, service)
    expect(first?.window.id).toEqual(expect.any(String))
    expect(second?.window.id).not.toBe(first?.window.id)
  })
})

describe('isAuthInternational', () => {
  it('bills the authentication rate when the number’s business is unknown', () => {
    expect(isAuthInternational(undefined, 'IN', OCT_2026)).toBe(false)
  })
})
