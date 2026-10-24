import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { createServer } from '../src/server.js'

/**
 * A user stopping, then resuming, marketing messages from a business.
 *
 * The stop arrives as a `user_preferences` webhook, never as an error. A
 * marketing template sent afterwards is ACCEPTED, then fails on its status
 * with 131050 — so an integration that only checks the send response keeps
 * paying for campaigns nobody receives, and never learns why.
 */

const EPOCH = 1_750_000_000_000
const CUSTOMER = '5215555000001'

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
  const changes = () => payloads.map((b) => JSON.parse(b).entry[0].changes[0])
  const statusesOf = (id: string) =>
    changes()
      .filter((c) => c.field === 'messages' && c.value.statuses?.[0]?.id === id)
      .map((c) => c.value.statuses[0])
  for (const [name, category] of [['promo', 'MARKETING'], ['aviso', 'UTILITY']] as const) {
    e.createTemplate(e.state.defaultWabaId, { name, language: 'es_MX', category, components: [] })
    e.transitionTemplate(e.state.defaultWabaId, name, 'es_MX', 'APPROVED')
  }
  const send = (name: string) =>
    e.sendMessage(e.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      to: CUSTOMER,
      type: 'template',
      template: { name, language: { code: 'es_MX' } },
    }).messages[0]!.id
  const flush = async () => {
    e.clock.advance(60_000)
    await e.settle()
  }
  payloads.length = 0
  return { e, changes, statusesOf, send, flush, payloads }
}

describe('user_preferences', () => {
  it('announces a stop with Meta’s payload', async () => {
    const { e, changes, flush } = harness()
    e.simulateInbound({ from: CUSTOMER, contactName: 'Sheena Nelson', message: { type: 'text', text: { body: 'hi' } } })
    await flush()
    const stoppedAt = e.clock.now()
    e.setUserPreference({ from: CUSTOMER, value: 'stop' })
    await flush()

    const userId = e.users.bsuid(e.state.defaultBusinessId, CUSTOMER)
    expect(changes().at(-1)).toEqual({
      field: 'user_preferences',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '+15550001111', phone_number_id: e.state.defaultPhoneNumberId },
        contacts: [{ profile: { name: 'Sheena Nelson' }, wa_id: CUSTOMER, user_id: userId }],
        user_preferences: [
          {
            wa_id: CUSTOMER,
            user_id: userId,
            detail: 'User requested to stop marketing messages',
            category: 'marketing_messages',
            value: 'stop',
            timestamp: Math.floor(stoppedAt / 1000),
          },
        ],
      },
    })
  })

  it('accepts a marketing template to a stopped user, then fails it with 131050', async () => {
    const { e, statusesOf, send, flush } = harness()
    e.setUserPreference({ from: CUSTOMER, value: 'stop' })
    const id = send('promo')
    await flush()

    const statuses = statusesOf(id)
    expect(statuses.map((s) => s.status)).toEqual(['failed'])
    expect(statuses[0].errors[0].code).toBe(131050)
    expect(statuses[0]).not.toHaveProperty('pricing')
  })

  it('still delivers utility templates to a stopped user', async () => {
    const { e, statusesOf, send, flush } = harness()
    e.setUserPreference({ from: CUSTOMER, value: 'stop' })
    const id = send('aviso')
    await flush()
    expect(statusesOf(id).map((s) => s.status)).toEqual(['sent', 'delivered'])
  })

  it('delivers marketing again after a resume', async () => {
    const { e, statusesOf, send, flush, changes } = harness()
    e.setUserPreference({ from: CUSTOMER, value: 'stop' })
    e.setUserPreference({ from: CUSTOMER, value: 'resume' })
    await flush()
    expect(changes().at(-1)!.value.user_preferences[0]).toMatchObject({
      value: 'resume',
      detail: 'User requested to resume marketing messages',
    })

    const id = send('promo')
    await flush()
    expect(statusesOf(id).map((s) => s.status)).toEqual(['sent', 'delivered'])
  })

  it('is kept per business phone number', async () => {
    const { e, statusesOf, flush } = harness()
    const other = e.createSignup({ businessId: e.state.defaultBusinessId }).phone_number_id
    e.createTemplate(e.state.waba(e.state.phoneNumber(other)!.wabaId)!.wabaId, {
      name: 'promo',
      language: 'es_MX',
      category: 'MARKETING',
      components: [],
    })
    e.transitionTemplate(e.state.phoneNumber(other)!.wabaId, 'promo', 'es_MX', 'APPROVED')
    e.setUserPreference({ from: CUSTOMER, value: 'stop' })

    const id = e.sendMessage(other, {
      messaging_product: 'whatsapp',
      to: CUSTOMER,
      type: 'template',
      template: { name: 'promo', language: { code: 'es_MX' } },
    }).messages[0]!.id
    await flush()
    expect(statusesOf(id).map((s) => s.status)).toEqual(['sent', 'delivered'])
  })

  it('omits wa_id for a user with a username whose phone cannot be shared', async () => {
    const { e, changes, flush } = harness()
    e.simulateInbound({ from: CUSTOMER, username: 'pablo', message: { type: 'text', text: { body: 'hi' } } })
    e.setUserPreference({ from: CUSTOMER, value: 'stop' })
    await flush()

    const value = changes().at(-1)!.value
    expect(value.contacts[0]).not.toHaveProperty('wa_id')
    expect(value.user_preferences[0]).not.toHaveProperty('wa_id')
  })

  it('forgets every stop on reset', async () => {
    const { e, statusesOf, flush } = harness()
    e.setUserPreference({ from: CUSTOMER, value: 'stop' })
    e.reset()
    e.createTemplate(e.state.defaultWabaId, { name: 'promo', language: 'es_MX', category: 'MARKETING', components: [] })
    e.transitionTemplate(e.state.defaultWabaId, 'promo', 'es_MX', 'APPROVED')
    const id = e.sendMessage(e.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      to: CUSTOMER,
      type: 'template',
      template: { name: 'promo', language: { code: 'es_MX' } },
    }).messages[0]!.id
    await flush()
    expect(statusesOf(id).map((s) => s.status)).toEqual(['sent', 'delivered'])
  })

  it('works through POST /__mock/users/preferences, answering after delivery', async () => {
    const { e, changes } = harness()
    const app = createServer(e)
    await app.ready()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/__mock/users/preferences',
        payload: JSON.stringify({ from: CUSTOMER, value: 'stop' }),
      })
      expect(res.json()).toEqual({ success: true })
      expect(changes().at(-1)!.field).toBe('user_preferences')

      const bad = await app.inject({
        method: 'POST',
        url: '/__mock/users/preferences',
        payload: JSON.stringify({ from: CUSTOMER, value: 'pause' }),
      })
      expect(bad.json().error.error_data.details).toBe(
        "value: Invalid enum value. Expected 'stop' | 'resume', received 'pause'",
      )
    } finally {
      await app.close()
    }
  })
})

describe('user_preferences through createWamock', () => {
  it('stops marketing and reports the 131050 failure', async () => {
    const { createWamock } = await import('../src/lib.js')
    const payloads: string[] = []
    const mock = await createWamock({
      appSecret: 's',
      start: EPOCH,
      onWebhook: (d) => {
        payloads.push(d.body)
      },
    })
    try {
      await mock.approveTemplate({ name: 'promo', language: 'es_MX', category: 'MARKETING' })
      await mock.setUserPreference({ from: CUSTOMER, value: 'stop' })
      const { id } = await mock.send({ to: CUSTOMER, template: { name: 'promo', language: 'es_MX' } })
      await mock.time.advance(60_000)

      const failed = payloads
        .map((b) => JSON.parse(b).entry[0].changes[0].value.statuses?.[0])
        .find((s) => s?.id === id)
      expect(failed).toMatchObject({ status: 'failed', errors: [{ code: 131050 }] })
    } finally {
      await mock.close()
    }
  })
})
