import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { AUTH_INTERNATIONAL_MARKETS } from '../src/core/pricing.js'
import { createServer } from '../src/server.js'

/**
 * Authentication-international rates, as Meta's page describes them: an
 * authentication template to a user in a market with the rate is billed it
 * when the business is eligible, past its start time for that country, and
 * not based in that country.
 */

const EPOCH = Date.UTC(2025, 5, 15)
const DAY = 24 * 60 * 60 * 1000
const INDIA = '919876543210'
const INDONESIA = '6281234567890'
const MEXICO = '5215555000001'
const BANGLADESH = '8801712345678'

function harness(start = EPOCH) {
  const bodies: string[] = []
  const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start, transport: async (d) => void bodies.push(d.body) })
  const waba = e.state.defaultWabaId
  for (const [name, category] of [['otp', 'AUTHENTICATION'], ['receipt', 'UTILITY']] as const) {
    e.createTemplate(waba, { name, language: 'en_US', category, components: [] })
    e.transitionTemplate(waba, name, 'en_US', 'APPROVED')
  }
  /** Send a template and answer the pricing category its statuses carry. */
  const billedAs = async (to: string, name = 'otp'): Promise<string> => {
    const id = e.sendMessage(e.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name, language: { code: 'en_US' } },
    }).messages[0]!.id
    e.clock.advance(5000)
    await e.settle()
    const priced = bodies
      .map((b) => JSON.parse(b).entry[0].changes[0].value.statuses?.[0])
      .find((s) => s?.id === id && s.pricing)
    return priced.pricing.category
  }
  const accountUpdates = () =>
    bodies.map((b) => JSON.parse(b).entry[0]).filter((entry) => entry.changes[0].field === 'account_update')
  return { e, billedAs, accountUpdates }
}

describe('authentication-international rates', () => {
  it('bill a business that is not eligible the authentication rate', async () => {
    const { billedAs } = harness()
    expect(await billedAs(INDIA)).toBe('authentication')
  })

  it('bill an eligible business past its start time the international rate, in Meta’s spelling', async () => {
    const { e, billedAs } = harness()
    e.setAuthInternational(e.state.defaultBusinessId, { startTime: EPOCH })
    expect(await billedAs(INDIA)).toBe('authentication_international')
    expect(await billedAs(INDONESIA)).toBe('authentication_international')
    // Only markets with the rate, and only authentication templates.
    expect(await billedAs(MEXICO)).toBe('authentication')
    expect(await billedAs(INDIA, 'receipt')).toBe('utility')
  })

  it('start 30 days after eligibility unless told otherwise, as Meta sets them', async () => {
    const { e, billedAs } = harness()
    e.setAuthInternational(e.state.defaultBusinessId)
    expect(await billedAs(INDIA)).toBe('authentication')
    // Each send moves the clock 5s; the delivered status goes out 500ms in.
    e.clock.advance(30 * DAY - 5000 - 501)
    expect(await billedAs(INDIA)).toBe('authentication')
    expect(await billedAs(INDIA)).toBe('authentication_international')
  })

  it('apply to a message delivered on or after the start, though sent just before it', async () => {
    const { e, billedAs } = harness()
    e.setAuthInternational(e.state.defaultBusinessId, { startTime: EPOCH + 250 })
    expect(await billedAs(INDIA)).toBe('authentication_international')
  })

  it('apply from the very millisecond of the start, not one after', async () => {
    // The delivered status goes out 500ms after the send.
    const exact = harness()
    exact.e.setAuthInternational(exact.e.state.defaultBusinessId, { startTime: EPOCH + 500 })
    expect(await exact.billedAs(INDIA)).toBe('authentication_international')
    const after = harness()
    after.e.setAuthInternational(after.e.state.defaultBusinessId, { startTime: EPOCH + 501 })
    expect(await after.billedAs(INDIA)).toBe('authentication')
  })

  it('judge the instant the delivered status really goes out, latency and reordering included', async () => {
    const late = harness()
    late.e.scenario.configure({ latencyMs: 1000 })
    late.e.setAuthInternational(late.e.state.defaultBusinessId, { startTime: EPOCH + 800 })
    expect(await late.billedAs(INDIA)).toBe('authentication_international')

    const early = harness()
    early.e.scenario.configure({ outOfOrderStatuses: true })
    early.e.setAuthInternational(early.e.state.defaultBusinessId, { startTime: EPOCH + 100 })
    expect(await early.billedAs(INDIA)).toBe('authentication')
  })

  it('start later for an exception country', async () => {
    const { e, billedAs } = harness()
    e.setAuthInternational(e.state.defaultBusinessId, { startTime: EPOCH, exceptions: [{ country: 'ID', startTime: EPOCH + 10 * DAY }] })
    expect(await billedAs(INDIA)).toBe('authentication_international')
    expect(await billedAs(INDONESIA)).toBe('authentication')
    e.clock.advance(10 * DAY)
    expect(await billedAs(INDONESIA)).toBe('authentication_international')
  })

  it('never apply in the country the business is based in', async () => {
    const { e, billedAs } = harness()
    e.setAuthInternational(e.state.defaultBusinessId, { startTime: EPOCH, primaryLocation: 'IN' })
    expect(await billedAs(INDIA)).toBe('authentication')
    expect(await billedAs(INDONESIA)).toBe('authentication_international')
  })

  it('apply in every market on Meta’s page today, whatever date the virtual clock starts at', async () => {
    // wamock emulates Meta as it runs now: Bangladesh joined on October 1,
    // 2026, and a clock started before then still bills it at the rate.
    const { e, billedAs } = harness(Date.UTC(2025, 0, 15))
    e.setAuthInternational(e.state.defaultBusinessId, { startTime: Date.UTC(2025, 0, 1) })
    expect(await billedAs(BANGLADESH)).toBe('authentication_international')
  })

  it('announce eligibility and the primary location on account_update, with times in seconds', async () => {
    const { e, accountUpdates } = harness()
    e.setAuthInternational(e.state.defaultBusinessId, {
      startTime: EPOCH + DAY,
      exceptions: [{ country: 'ID', startTime: EPOCH + 2 * DAY }],
      primaryLocation: 'MX',
    })
    e.clock.advance(0)
    await e.settle()
    const [eligibility, location] = accountUpdates()
    expect(eligibility.id).toBe(e.state.defaultWabaId)
    expect(eligibility.changes[0].value).toEqual({
      auth_international_rate_eligibility: {
        exception_countries: [{ country_code: 'ID', start_time: (EPOCH + 2 * DAY) / 1000 }],
        start_time: (EPOCH + DAY) / 1000,
      },
      event: 'AUTH_INTL_PRICE_ELIGIBILITY_UPDATE',
    })
    expect(location.changes[0].value).toEqual({ country: 'MX', event: 'BUSINESS_PRIMARY_LOCATION_COUNTRY_UPDATE' })
  })
})

describe('the markets with the rate', () => {
  it('are the 18 on Meta’s page', () => {
    expect([...AUTH_INTERNATIONAL_MARKETS].sort()).toEqual(
      ['AE', 'BD', 'EG', 'ID', 'IN', 'IQ', 'KW', 'KZ', 'LK', 'MA', 'MY', 'NG', 'NP', 'OM', 'PK', 'SA', 'UA', 'ZA'],
    )
  })
})

describe('reading eligibility from the Messaging account', () => {
  it('answers auth_international_rate_eligibility and primary_business_location once set, through the control API', async () => {
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    const app = createServer(e)
    await app.ready()
    try {
      const read = async () =>
        (
          await app.inject({ method: 'GET', url: `/v26.0/${e.state.defaultWabaId}?fields=auth_international_rate_eligibility,primary_business_location` })
        ).json()
      expect(await read()).toEqual({ id: e.state.defaultWabaId })

      const set = await app.inject({
        method: 'POST',
        url: '/__mock/auth-international',
        payload: JSON.stringify({ start_time: EPOCH / 1000, exception_countries: [{ country_code: 'ID', start_time: EPOCH / 1000 + 60 }], primary_business_location: 'IN' }),
      })
      expect(set.json()).toEqual({ success: true })
      expect(await read()).toEqual({
        id: e.state.defaultWabaId,
        auth_international_rate_eligibility: {
          start_time: EPOCH / 1000,
          exception_countries: [{ country_code: 'ID', start_time: EPOCH / 1000 + 60 }],
        },
        primary_business_location: 'IN',
      })

      for (const payload of [{ primary_business_location: 'india' }, { start_time: 1.5 }, { business_id: 'NOPE' }, { extra: 1 }]) {
        const res = await app.inject({ method: 'POST', url: '/__mock/auth-international', payload: JSON.stringify(payload) })
        expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      }
    } finally {
      await app.close()
    }
  })

  it('forgets eligibility on reset', async () => {
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    e.setAuthInternational(e.state.defaultBusinessId, { startTime: EPOCH })
    e.reset()
    expect(e.getWabaFields(e.state.defaultWabaId, ['auth_international_rate_eligibility'])).toEqual({ id: e.state.defaultWabaId })
  })
})
