import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { GraphError } from '../src/errors/graph-error.js'
import { createServer } from '../src/server.js'

/**
 * Coexistence: one phone number used from the WhatsApp Business app and from
 * Cloud API at the same time.
 *
 * What breaks integrations here is that half the conversation happens where
 * the integration cannot see it. The business answers from the app, and the
 * integration only learns of it through `smb_message_echoes`. Those replies
 * open no service window. History arrives once, in phases, and only if asked
 * for within 24 hours of onboarding.
 */

const EPOCH = 1_750_000_000_000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const CUSTOMER = '5215555000001'

function harness(signup: Parameters<WamockEngine['createSignup']>[0] = {}) {
  const bodies: string[] = []
  const e = new WamockEngine({
    appSecret: 's',
    mode: 'frozen',
    start: EPOCH,
    transport: async (d) => {
      bodies.push(d.body)
    },
  })
  const tenant = e.createSignup({ coexistence: true, ...signup })
  const changes = () => bodies.map((b) => JSON.parse(b).entry[0].changes[0])
  const entries = () => bodies.map((b) => JSON.parse(b).entry[0])
  const ofField = (field: string) => changes().filter((c) => c.field === field)
  const flush = async () => {
    e.clock.advance(0)
    await e.settle()
  }
  const codeOf = (fn: () => unknown): number => {
    try {
      fn()
    } catch (err) {
      if (err instanceof GraphError) return err.code
      throw err
    }
    throw new Error('expected a GraphError')
  }
  const sync = (syncType: string) =>
    e.syncBusinessAppData(tenant.phone_number_id, { messaging_product: 'whatsapp', sync_type: syncType })
  return { e, tenant, bodies, changes, entries, ofField, flush, codeOf, sync }
}

describe('onboarding a Business app number', () => {
  it('marks the number as on the Business app and on Cloud API', () => {
    const { e, tenant } = harness()
    expect(e.getPhoneNumberFields(tenant.phone_number_id, ['is_on_biz_app', 'platform_type'])).toEqual({
      id: tenant.phone_number_id,
      is_on_biz_app: true,
      platform_type: 'CLOUD_API',
    })
  })

  it('reports is_on_biz_app false for an ordinary number', () => {
    const { e } = harness()
    expect(e.getPhoneNumberFields(e.state.defaultPhoneNumberId, ['is_on_biz_app'])['is_on_biz_app']).toBe(false)
  })

  it('announces PARTNER_ADDED for the converted Messaging account', async () => {
    const { e, tenant, entries, flush } = harness()
    await flush()

    const added = entries().find((entry) => entry.changes[0].field === 'account_update')!
    expect(added.time).toBe(Math.floor(EPOCH / 1000))
    expect(added.changes[0].value).toEqual({
      event: 'PARTNER_ADDED',
      waba_info: {
        waba_id: tenant.waba_id,
        owner_business_id: e.state.businessIdOf(tenant.phone_number_id),
      },
    })
  })
})

describe('synchronizing Business app data', () => {
  it('answers with a request id and sends the contacts', async () => {
    const { e, sync, ofField, flush } = harness({
      contacts: [{ phone: CUSTOMER, full_name: 'Pablo Morales', first_name: 'Pablo' }],
    })
    const res = sync('smb_app_state_sync')
    await flush()

    expect(res).toEqual({ messaging_product: 'whatsapp', request_id: expect.any(String) })
    const value = ofField('smb_app_state_sync')[0]!.value
    expect(value.state_sync).toEqual([
      {
        type: 'contact',
        contact: { full_name: 'Pablo Morales', first_name: 'Pablo', phone_number: CUSTOMER },
        action: 'add',
        metadata: { timestamp: String(Math.floor(e.clock.now() / 1000)) },
      },
    ])
  })

  it('refuses a second call of the same kind with 2593107', () => {
    const { sync, codeOf } = harness()
    sync('smb_app_state_sync')
    expect(codeOf(() => sync('smb_app_state_sync'))).toBe(2593107)
    // The other kind still has its one call.
    expect(() => sync('history')).not.toThrow()
  })

  it('refuses a call made 24 hours after onboarding with 2593108', () => {
    const { e, sync, codeOf } = harness()
    e.clock.advance(DAY)
    expect(codeOf(() => sync('history'))).toBe(2593108)
  })

  it('refuses a number that is not on the Business app', () => {
    const { e, codeOf } = harness()
    expect(
      codeOf(() =>
        e.syncBusinessAppData(e.state.defaultPhoneNumberId, { messaging_product: 'whatsapp', sync_type: 'history' }),
      ),
    ).toBe(100)
  })

  it('refuses an unknown sync type', () => {
    const { sync, codeOf } = harness()
    expect(codeOf(() => sync('everything'))).toBe(100)
  })

  it('sends history by phase, oldest phases last, with progress reaching 100', async () => {
    const { sync, ofField, flush } = harness({
      history: [
        {
          phone: CUSTOMER,
          messages: [
            { direction: 'in', text: 'old question', ago_ms: 100 * DAY },
            { direction: 'out', text: 'old answer', ago_ms: 100 * DAY - 1000 },
            { direction: 'in', text: 'yesterday', ago_ms: 2 * DAY },
            { direction: 'in', text: 'just now', ago_ms: HOUR },
            { direction: 'in', text: 'too old to sync', ago_ms: 200 * DAY },
          ],
        },
      ],
    })
    sync('history')
    await flush()

    const chunks = ofField('history').map((c) => c.value.history[0])
    expect(chunks.map((h) => h.metadata.phase)).toEqual([0, 1, 2])
    expect(chunks.map((h) => h.metadata.progress)).toEqual([25, 50, 100])
    expect(chunks.every((h) => h.metadata.chunk_order === 1)).toBe(true)

    const oldest = chunks[2].threads[0]
    expect(oldest.id).toBe(CUSTOMER)
    expect(oldest.messages.map((m: { text: { body: string } }) => m.text.body)).toEqual(['old question', 'old answer'])
    // A business message carries `to`; a customer message does not.
    expect(oldest.messages[1]).toMatchObject({ to: CUSTOMER, history_context: { status: 'READ' } })
    expect(oldest.messages[0]).not.toHaveProperty('to')
  })

  it('reports 2593109 when the business declined to share its history', async () => {
    const { sync, ofField, flush } = harness({ shareHistory: false })
    sync('history')
    await flush()

    expect(ofField('history')[0]!.value.history).toEqual([
      {
        errors: [
          {
            code: 2593109,
            title: 'History sync is turned off by the business from the WhatsApp Business App',
            message: 'History sync is turned off by the business from the WhatsApp Business App',
            error_data: { details: 'History sharing is turned off by the business' },
          },
        ],
      },
    ])
  })

  it('opens no service window for a customer seen only in history', () => {
    const { e, tenant, sync, codeOf } = harness({
      history: [{ phone: CUSTOMER, messages: [{ direction: 'in', text: 'hola', ago_ms: HOUR }] }],
    })
    sync('history')
    expect(
      codeOf(() =>
        e.sendMessage(tenant.phone_number_id, { messaging_product: 'whatsapp', to: CUSTOMER, type: 'text', text: { body: 'hi' } }),
      ),
    ).toBe(131047)
  })
})

describe('the Business app side', () => {
  it('echoes a message the business sent from the app', async () => {
    const { e, tenant, ofField, flush } = harness()
    e.businessAppSend({ phoneNumberId: tenant.phone_number_id, to: CUSTOMER, text: 'sent from my phone' })
    await flush()

    const value = ofField('smb_message_echoes')[0]!.value
    const userId = e.users.bsuid(e.state.businessIdOf(tenant.phone_number_id)!, CUSTOMER)
    expect(value.contacts).toEqual([{ wa_id: CUSTOMER, user_id: userId }])
    expect(value.message_echoes).toEqual([
      {
        from: e.state.phoneNumber(tenant.phone_number_id)!.displayPhoneNumber,
        to: CUSTOMER,
        to_user_id: userId,
        id: expect.stringMatching(/^wamid\./),
        timestamp: String(Math.floor(EPOCH / 1000)),
        type: 'text',
        text: { body: 'sent from my phone' },
      },
    ])
  })

  it('keeps a hidden phone number out of the echo', async () => {
    const { e, tenant, ofField, flush } = harness()
    e.simulateInbound({
      from: CUSTOMER,
      phoneNumberId: tenant.phone_number_id,
      username: 'pablo',
      message: { type: 'text', text: { body: 'hi' } },
    })
    e.businessAppSend({ phoneNumberId: tenant.phone_number_id, to: CUSTOMER, text: 'hola' })
    await flush()

    const value = ofField('smb_message_echoes')[0]!.value
    expect(value.contacts[0]).not.toHaveProperty('wa_id')
    expect(value.message_echoes[0]).not.toHaveProperty('to')
    expect(value.message_echoes[0].to_user_id).toBe(value.contacts[0].user_id)
  })

  it('does not open a service window, and is not billed', () => {
    const { e, tenant, codeOf } = harness()
    e.businessAppSend({ phoneNumberId: tenant.phone_number_id, to: CUSTOMER, text: 'hola' })
    expect(e.state.outbound()).toHaveLength(0)
    expect(
      codeOf(() =>
        e.sendMessage(tenant.phone_number_id, { messaging_product: 'whatsapp', to: CUSTOMER, type: 'text', text: { body: 'hi' } }),
      ),
    ).toBe(131047)
  })

  it('streams a contact change after onboarding', async () => {
    const { e, tenant, ofField, flush } = harness()
    e.businessAppContact({
      phoneNumberId: tenant.phone_number_id,
      phone: CUSTOMER,
      full_name: 'Pablo Morales',
      action: 'remove',
    })
    await flush()

    // `full_name` and `first_name` are left out of a removal.
    expect(ofField('smb_app_state_sync')[0]!.value.state_sync[0]).toMatchObject({
      contact: { phone_number: CUSTOMER },
      action: 'remove',
    })
    expect(ofField('smb_app_state_sync')[0]!.value.state_sync[0].contact).not.toHaveProperty('full_name')
  })

  it('only exists for a number on the Business app', () => {
    const { e, codeOf } = harness()
    expect(codeOf(() => e.businessAppSend({ phoneNumberId: e.state.defaultPhoneNumberId, to: CUSTOMER, text: 'x' }))).toBe(100)
  })
})

describe('coexistence limits and lifecycle', () => {
  const send = (e: WamockEngine, phoneNumberId: string) =>
    e.sendMessage(phoneNumberId, { messaging_product: 'whatsapp', to: CUSTOMER, type: 'text', text: { body: 'hi' } })

  it('caps Cloud API throughput at 20 messages per second', () => {
    const { e, tenant, codeOf } = harness()
    e.simulateInbound({ from: CUSTOMER, phoneNumberId: tenant.phone_number_id, message: { type: 'text', text: { body: 'hi' } } })
    for (let i = 0; i < 20; i++) send(e, tenant.phone_number_id)
    expect(codeOf(() => send(e, tenant.phone_number_id))).toBe(130429)

    e.clock.advance(1000)
    expect(() => send(e, tenant.phone_number_id)).not.toThrow()
  })

  it('leaves an ordinary number uncapped', () => {
    const { e } = harness()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hi' } } })
    for (let i = 0; i < 30; i++) send(e, e.state.defaultPhoneNumberId)
  })

  it('disconnects after 14 days without Business app activity, with PRIMARY_INACTIVITY', async () => {
    const { e, tenant, ofField, codeOf } = harness()
    e.clock.advance(14 * DAY - 1)
    await e.settle()
    expect(ofField('account_update').map((c) => c.value.event)).toEqual(['PARTNER_ADDED'])

    e.clock.advance(1)
    await e.settle()
    expect(ofField('account_update').at(-1)!.value).toEqual({
      event: 'PARTNER_REMOVED',
      waba_info: { waba_id: tenant.waba_id, owner_business_id: e.state.businessIdOf(tenant.phone_number_id) },
      disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' },
    })

    e.simulateInbound({ from: CUSTOMER, phoneNumberId: tenant.phone_number_id, message: { type: 'text', text: { body: 'hi' } } })
    expect(codeOf(() => send(e, tenant.phone_number_id))).toBe(133010)
    expect(e.getPhoneNumberFields(tenant.phone_number_id, ['is_on_biz_app'])['is_on_biz_app']).toBe(false)
  })

  it('counts a message sent from the app as activity', async () => {
    const { e, tenant, ofField } = harness()
    e.clock.advance(10 * DAY)
    e.businessAppSend({ phoneNumberId: tenant.phone_number_id, to: CUSTOMER, text: 'still here' })
    e.clock.advance(10 * DAY)
    await e.settle()
    expect(ofField('account_update').map((c) => c.value.event)).toEqual(['PARTNER_ADDED'])
  })

  it('suspends sending while offboarded, then reconnects on its own', async () => {
    const { e, tenant, ofField, codeOf } = harness()
    e.simulateInbound({ from: CUSTOMER, phoneNumberId: tenant.phone_number_id, message: { type: 'text', text: { body: 'hi' } } })
    e.businessAppOffboard({ phoneNumberId: tenant.phone_number_id })
    await e.flush()

    expect(ofField('account_update').at(-1)!.value).toEqual({ event: 'ACCOUNT_OFFBOARDED' })
    expect(codeOf(() => send(e, tenant.phone_number_id))).toBe(133010)

    e.clock.advance(5 * 60 * 1000)
    await e.settle()
    expect(ofField('account_update').at(-1)!.value).toEqual({ event: 'ACCOUNT_RECONNECTED' })
    expect(() => send(e, tenant.phone_number_id)).not.toThrow()
  })

  it('stays offboarded when the business does not reconnect', async () => {
    const { e, tenant, ofField } = harness()
    e.businessAppOffboard({ phoneNumberId: tenant.phone_number_id, reconnect: false })
    e.clock.advance(HOUR)
    await e.settle()
    expect(ofField('account_update').map((c) => c.value.event)).toEqual(['PARTNER_ADDED', 'ACCOUNT_OFFBOARDED'])
  })

  it('forgets everything, timers included, on reset', async () => {
    const { e, ofField } = harness()
    e.reset()
    e.clock.advance(15 * DAY)
    await e.settle()
    expect(ofField('account_update').filter((c) => c.value.event === 'PARTNER_REMOVED')).toHaveLength(0)
  })
})

describe('coexistence over HTTP', () => {
  it('onboards, syncs and echoes through the Graph route and the control API', async () => {
    const bodies: string[] = []
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: async (d) => void bodies.push(d.body) })
    const app = createServer(e)
    await app.ready()
    const post = (url: string, payload: unknown) =>
      app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) })
    try {
      const signup = (
        await post('/__mock/embedded-signup', {
          coexistence: true,
          contacts: [{ phone: CUSTOMER, full_name: 'Pablo Morales' }],
        })
      ).json()

      const synced = await post(`/v26.0/${signup.phone_number_id}/smb_app_data`, {
        messaging_product: 'whatsapp',
        sync_type: 'smb_app_state_sync',
      })
      expect(synced.statusCode).toBe(200)
      expect(synced.json()).toEqual({ messaging_product: 'whatsapp', request_id: expect.any(String) })

      const again = await post(`/v26.0/${signup.phone_number_id}/smb_app_data`, {
        messaging_product: 'whatsapp',
        sync_type: 'smb_app_state_sync',
      })
      expect(again.statusCode).toBe(400)
      expect(again.json().error).toMatchObject({ code: 2593107 })

      expect(
        (await post('/__mock/app/send', { phone_number_id: signup.phone_number_id, to: CUSTOMER, text: 'hola' })).json(),
      ).toEqual({ success: true })
      const fields = bodies.map((b) => JSON.parse(b).entry[0].changes[0].field)
      expect(fields).toEqual(['account_update', 'smb_app_state_sync', 'smb_message_echoes'])

      const typo = await post('/__mock/app/send', { phone_number_id: signup.phone_number_id, to: CUSTOMER, body: 'x' })
      expect(typo.json().error.error_data.details).toBe("text: Required; Unrecognized key(s) in object: 'body'")
    } finally {
      await app.close()
    }
  })
})

describe('coexistence through createWamock', () => {
  it('echoes, streams contacts and offboards through mock.businessApp', async () => {
    const { createWamock } = await import('../src/lib.js')
    const fields: string[] = []
    const mock = await createWamock({
      appSecret: 's',
      start: EPOCH,
      onWebhook: (d) => {
        fields.push(d.payload.entry[0]!.changes[0]!.field)
      },
    })
    try {
      const { phone_number_id } = mock.engine.createSignup({ coexistence: true })
      await mock.businessApp.send({ phoneNumberId: phone_number_id, to: CUSTOMER, text: 'hola' })
      await mock.businessApp.contact({ phoneNumberId: phone_number_id, phone: CUSTOMER, full_name: 'Pablo' })
      await mock.businessApp.offboard({ phoneNumberId: phone_number_id, reconnect: false })

      expect(fields).toEqual(['account_update', 'smb_message_echoes', 'smb_app_state_sync', 'account_update'])
    } finally {
      await mock.close()
    }
  })
})

describe('coexistence timers never outlive their purpose', () => {
  it('a second offboard replaces the first reconnection instead of adding one', async () => {
    const { e, tenant, ofField } = harness()
    e.businessAppOffboard({ phoneNumberId: tenant.phone_number_id })
    e.clock.advance(60 * 1000)
    e.businessAppOffboard({ phoneNumberId: tenant.phone_number_id, reconnect: false })
    e.clock.advance(HOUR)
    await e.settle()
    expect(ofField('account_update').map((c) => c.value.event)).toEqual([
      'PARTNER_ADDED',
      'ACCOUNT_OFFBOARDED',
      'ACCOUNT_OFFBOARDED',
    ])
  })

  it('reset cancels every pending reconnection', async () => {
    const { e, ofField } = harness()
    const second = e.createSignup({ coexistence: true }).phone_number_id
    e.businessAppOffboard({ phoneNumberId: second })
    e.businessAppOffboard({ phoneNumberId: second })
    e.reset()
    // The counter rewinds, so these get the very same ids the stale timers knew.
    e.createSignup({ coexistence: true })
    expect(e.createSignup({ coexistence: true }).phone_number_id).toBe(second)
    e.clock.advance(HOUR)
    await e.settle()
    expect(ofField('account_update').filter((c) => c.value.event === 'ACCOUNT_RECONNECTED')).toHaveLength(0)
  })

  it('counts a contact edit in the app as activity', async () => {
    const { e, tenant, ofField } = harness()
    e.clock.advance(10 * DAY)
    e.businessAppContact({ phoneNumberId: tenant.phone_number_id, phone: CUSTOMER, full_name: 'Pablo' })
    e.clock.advance(10 * DAY)
    await e.settle()
    expect(ofField('account_update').map((c) => c.value.event)).toEqual(['PARTNER_ADDED'])
  })
})

describe('coexistence payloads, field by field', () => {
  it('renders a history message exactly, timestamped back from onboarding', async () => {
    const { e, tenant, sync, ofField, flush } = harness({
      history: [{ phone: CUSTOMER, messages: [{ direction: 'in', text: 'hola', ago_ms: HOUR }] }],
    })
    sync('history')
    await flush()

    const userId = e.users.bsuid(e.state.businessIdOf(tenant.phone_number_id)!, CUSTOMER)
    expect(ofField('history')[0]!.value).toEqual({
      messaging_product: 'whatsapp',
      metadata: {
        display_phone_number: `+${e.state.phoneNumber(tenant.phone_number_id)!.displayPhoneNumber}`,
        phone_number_id: tenant.phone_number_id,
      },
      history: [
        {
          metadata: { phase: 0, chunk_order: 1, progress: 100 },
          threads: [
            {
              id: CUSTOMER,
              context: { wa_id: CUSTOMER, user_id: userId },
              messages: [
                {
                  from: CUSTOMER,
                  from_user_id: userId,
                  id: expect.stringMatching(/^wamid\./),
                  timestamp: String(Math.floor((EPOCH - HOUR) / 1000)),
                  type: 'text',
                  text: { body: 'hola' },
                  history_context: { status: 'READ' },
                },
              ],
            },
          ],
        },
      ],
    })
  })

  it('hides a username user’s phone in history, and names the username', async () => {
    const { e, sync, ofField, flush } = harness({
      history: [{ phone: CUSTOMER, messages: [{ direction: 'in', text: 'hola', ago_ms: HOUR }] }],
    })
    e.users.setProfile(CUSTOMER, { username: 'pablo' })
    sync('history')
    await flush()

    const thread = ofField('history')[0]!.value.history[0].threads[0]
    expect(thread).not.toHaveProperty('id')
    expect(thread.context).toEqual({ user_id: expect.any(String), username: 'pablo' })
    expect(thread.messages[0]).not.toHaveProperty('from')
  })

  it('puts a message exactly one day old in phase 1, not phase 0', async () => {
    const { sync, ofField, flush } = harness({
      history: [{ phone: CUSTOMER, messages: [{ direction: 'in', text: 'x', ago_ms: DAY }] }],
    })
    sync('history')
    await flush()
    expect(ofField('history')[0]!.value.history[0].metadata.phase).toBe(1)
  })

  it('still syncs one millisecond before the 24 hours run out', () => {
    const { e, sync } = harness()
    e.clock.advance(DAY - 1)
    expect(() => sync('history')).not.toThrow()
  })

  it('refuses a sync body that is not for whatsapp', () => {
    const { e, tenant, codeOf } = harness()
    expect(codeOf(() => e.syncBusinessAppData(tenant.phone_number_id, { sync_type: 'history' }))).toBe(100)
  })

  it('sends no contact webhook when the app has no contacts', async () => {
    const { sync, ofField, flush } = harness()
    sync('smb_app_state_sync')
    await flush()
    expect(ofField('smb_app_state_sync')).toHaveLength(0)
  })

  it('syncs the contact list as edited in the app before the sync', async () => {
    const { e, tenant, sync, ofField, flush } = harness({
      contacts: [
        { phone: CUSTOMER, full_name: 'Pablo' },
        { phone: '5215555000002', full_name: 'Ana' },
      ],
    })
    e.businessAppContact({ phoneNumberId: tenant.phone_number_id, phone: CUSTOMER, full_name: 'Pablo Morales', first_name: 'Pablo' })
    e.businessAppContact({ phoneNumberId: tenant.phone_number_id, phone: '5215555000002', action: 'remove' })
    await flush()
    const before = ofField('smb_app_state_sync').length
    sync('smb_app_state_sync')
    await flush()

    const synced = ofField('smb_app_state_sync').slice(before)[0]!.value.state_sync
    expect(synced.map((s: { contact: unknown }) => s.contact)).toEqual([
      { full_name: 'Pablo Morales', first_name: 'Pablo', phone_number: CUSTOMER },
    ])
  })

  it('names a username user in the echo’s contacts', async () => {
    const { e, tenant, ofField, flush } = harness()
    e.users.setProfile(CUSTOMER, { username: 'pablo' })
    e.businessAppSend({ phoneNumberId: tenant.phone_number_id, to: CUSTOMER, text: 'hola' })
    await flush()
    expect(ofField('smb_message_echoes')[0]!.value.contacts[0].profile).toEqual({ username: 'pablo' })
  })

  it('stays offboarded until the 5 minutes of reonboarding are up', async () => {
    const { e, tenant, ofField } = harness()
    e.businessAppOffboard({ phoneNumberId: tenant.phone_number_id })
    e.clock.advance(5 * 60 * 1000 - 1)
    await e.settle()
    expect(ofField('account_update').at(-1)!.value.event).toBe('ACCOUNT_OFFBOARDED')
  })

  it('reset cancels the inactivity timer even when ids are reused', async () => {
    const { e, ofField } = harness()
    e.reset()
    e.clock.advance(DAY)
    e.createSignup({ coexistence: true })
    e.clock.advance(13 * DAY)
    await e.settle()
    // The pre-reset timer was due at day 14; the new tenant's is due at day 15.
    expect(ofField('account_update').filter((c) => c.value.event === 'PARTNER_REMOVED')).toHaveLength(0)
  })
})
