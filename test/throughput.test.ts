import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { GraphError } from '../src/errors/graph-error.js'
import { createServer } from '../src/server.js'

/**
 * Higher throughput, as Meta's throughput page describes it: an eligible
 * number is upgraded from 80 to 1,000 messages per second, is not usable for
 * up to a minute meanwhile (131057), and `phone_number_quality_update`
 * announces the upgrade once it is done.
 */

const EPOCH = 1_750_000_000_000
const CUSTOMER = '5215555000001'

function harness() {
  const bodies: string[] = []
  const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: async (d) => void bodies.push(d.body) })
  const pnid = e.state.defaultPhoneNumberId
  const codeOf = (fn: () => unknown): number => {
    try {
      fn()
    } catch (error) {
      if (error instanceof GraphError) return error.code
      throw error
    }
    throw new Error('expected a GraphError')
  }
  const text = () => e.sendMessage(pnid, { messaging_product: 'whatsapp', to: CUSTOMER, type: 'text', text: { body: 'x' } })
  const level = () => (e.getPhoneNumberFields(pnid, ['throughput'])['throughput'] as { level: string }).level
  const qualityUpdates = () =>
    bodies.map((b) => JSON.parse(b).entry[0]).filter((entry) => entry.changes[0].field === 'phone_number_quality_update')
  return { e, pnid, codeOf, text, level, qualityUpdates }
}

describe('a throughput upgrade', () => {
  it('leaves the number unusable for a minute, then announces itself and lifts the level', async () => {
    const { e, pnid, codeOf, text, level, qualityUpdates } = harness()
    const { messageId } = e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    expect(level()).toBe('STANDARD')

    e.upgradeThroughput(pnid)
    expect(codeOf(text)).toBe(131057)
    expect(codeOf(() => e.postMessages(pnid, { messaging_product: 'whatsapp', status: 'read', message_id: messageId }))).toBe(131057)
    expect(level()).toBe('STANDARD')

    e.clock.advance(60_000 - 1)
    await e.settle()
    expect(qualityUpdates()).toEqual([])
    e.clock.advance(1)
    await e.settle()
    const [update] = qualityUpdates()
    expect(update.id).toBe(e.state.defaultWabaId)
    expect(update.changes[0].value).toEqual({
      display_phone_number: e.state.phoneNumber(pnid)!.displayPhoneNumber,
      event: 'THROUGHPUT_UPGRADE',
      max_daily_conversations_per_business: 'TIER_UNLIMITED',
    })
    expect(level()).toBe('HIGH')
    expect(() => text()).not.toThrow()
  })

  it('needs an unlimited portfolio, a quality of YELLOW or better, and happens once', () => {
    const { e, pnid, codeOf } = harness()
    e.setTier(pnid, 'TIER_2K')
    expect(codeOf(() => e.upgradeThroughput(pnid))).toBe(100)
    e.setTier(pnid, 'TIER_UNLIMITED')
    for (const quality of ['RED', 'NA', 'UNKNOWN'] as const) {
      e.setQuality(pnid, quality)
      expect(codeOf(() => e.upgradeThroughput(pnid)), quality).toBe(100)
    }
    e.setQuality(pnid, 'YELLOW')
    expect(e.upgradeThroughput(pnid)).toEqual({ success: true })
    expect(codeOf(() => e.upgradeThroughput(pnid))).toBe(100)
  })

  it('is refused for a number shared with the WhatsApp Business app, fixed at 20 per second', () => {
    const { e, codeOf } = harness()
    const tenant = e.createSignup({ coexistence: true, businessId: e.state.defaultBusinessId })
    expect(codeOf(() => e.upgradeThroughput(tenant.phone_number_id))).toBe(100)
  })

  it('is forgotten by a reset, announcement included', async () => {
    const { e, pnid, qualityUpdates, level } = harness()
    e.upgradeThroughput(pnid)
    e.reset()
    e.clock.advance(120_000)
    await e.settle()
    expect(qualityUpdates()).toEqual([])
    expect(level()).toBe('STANDARD')
  })

  it('answers 131057 to every Graph request on the number meanwhile, changing nothing, but not to the control API', async () => {
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    const pnid = e.state.defaultPhoneNumberId
    const app = createServer(e)
    await app.ready()
    try {
      e.upgradeThroughput(pnid)
      const calls = [
        { method: 'GET', url: `/v26.0/${pnid}?fields=throughput` },
        { method: 'POST', url: `/v26.0/${pnid}`, payload: { webhook_configuration: { override_callback_uri: 'https://example.com/hook', verify_token: 't' } } },
        { method: 'GET', url: `/v26.0/${pnid}/block_users` },
        { method: 'POST', url: `/v26.0/${pnid}/block_users`, payload: { messaging_product: 'whatsapp', block_users: [{ user: CUSTOMER }] } },
        { method: 'POST', url: `/v26.0/${pnid}/deregister`, payload: {} },
        { method: 'POST', url: `/v26.0/${pnid}/register`, payload: { messaging_product: 'whatsapp', pin: '123456' } },
        { method: 'POST', url: `/v26.0/${pnid}/messages`, payload: { messaging_product: 'whatsapp', to: CUSTOMER, type: 'text', text: { body: 'x' } } },
      ] as const
      for (const call of calls) {
        const res = await app.inject({ ...call, ...('payload' in call ? { payload: JSON.stringify(call.payload), headers: { 'content-type': 'application/json' } } : {}) })
        expect(res.statusCode, `${call.method} ${call.url}`).toBe(400)
        expect(res.json().error.code, `${call.method} ${call.url}`).toBe(131057)
      }
      const number = e.state.phoneNumber(pnid)!
      expect(number.registered).not.toBe(false)
      expect(number.callbackOverride).toBeUndefined()
      expect(e.state.outbound()).toEqual([])
      expect(e.listBlockedUsers(pnid, {}).data).toEqual([])

      // The WABA is not the number, and the control API plays Meta.
      expect((await app.inject({ method: 'GET', url: `/v26.0/${e.state.defaultWabaId}/phone_numbers` })).statusCode).toBe(200)
      expect((await app.inject({ method: 'POST', url: '/__mock/quality', payload: JSON.stringify({ quality_rating: 'GREEN' }) })).statusCode).toBe(200)

      e.clock.advance(60_000)
      expect((await app.inject({ method: 'GET', url: `/v26.0/${pnid}?fields=throughput` })).json().throughput).toEqual({ level: 'HIGH' })
    } finally {
      await app.close()
    }
  })

  it('is played through POST /__mock/throughput-upgrade', async () => {
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    const app = createServer(e)
    await app.ready()
    try {
      const res = await app.inject({ method: 'POST', url: '/__mock/throughput-upgrade', payload: '{}' })
      expect(res.json()).toEqual({ success: true })
      expect((await app.inject({ method: 'POST', url: '/__mock/throughput-upgrade', payload: '{"typo":1}' })).statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})
