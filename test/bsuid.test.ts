import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { GraphError } from '../src/errors/graph-error.js'

/**
 * Business-scoped user IDs and usernames, end to end through the engine.
 *
 * Since April 2026 every `messages` webhook carries the user's BSUID, and a
 * user with a username stops disclosing their phone number. The failures this
 * reproduces are silent: a receiver keyed on `wa_id` drops the message, and a
 * sender that only knows `to` cannot reach a customer it only ever saw by BSUID.
 */

const EPOCH = 1_750_000_000_000
const DAY = 24 * 60 * 60 * 1000
const CUSTOMER = '5215555000001'

function harness() {
  const bodies: string[] = []
  const e = new WamockEngine({
    appSecret: 's',
    mode: 'frozen',
    start: EPOCH,
    transport: async (d) => {
      bodies.push(d.body)
    },
  })
  const values = () =>
    bodies.map((b) => JSON.parse(b).entry[0].changes[0].value)
  const statuses = () => values().filter((v) => v['statuses']).map((v) => v)
  const bsuid = () => e.users.bsuid(e.state.defaultBusinessId, CUSTOMER)
  const flush = async () => {
    e.clock.advance(60_000)
    await e.settle()
  }
  return { e, bodies, values, statuses, bsuid, flush }
}

const text = (to: Record<string, string>) => ({
  messaging_product: 'whatsapp',
  ...to,
  type: 'text',
  text: { body: 'hola' },
})

const codeOf = (fn: () => unknown): number => {
  try {
    fn()
  } catch (err) {
    if (err instanceof GraphError) return err.code
    throw err
  }
  throw new Error('expected a GraphError')
}

describe('incoming messages carry a BSUID', () => {
  it('alongside the phone number, for a user without a username', async () => {
    const { e, values, bsuid, flush } = harness()
    e.simulateInbound({ from: CUSTOMER, contactName: 'Pablo', message: { type: 'text', text: { body: 'hi' } } })
    await flush()

    const value = values()[0]!
    expect(value['contacts']).toEqual([{ profile: { name: 'Pablo' }, wa_id: CUSTOMER, user_id: bsuid() }])
    expect(value['messages'][0]).toMatchObject({ from: CUSTOMER, from_user_id: bsuid() })
  })

  it('without the phone number, for a user with a username and no recent contact', async () => {
    const { e, values, bsuid, flush } = harness()
    e.simulateInbound({
      from: CUSTOMER,
      contactName: 'Pablo',
      username: 'pablomorales',
      message: { type: 'text', text: { body: 'hi' } },
    })
    await flush()

    const value = values()[0]!
    expect(value['contacts']).toEqual([
      { profile: { name: 'Pablo', username: 'pablomorales' }, user_id: bsuid() },
    ])
    expect(value['messages'][0]).not.toHaveProperty('from')
    expect(value['messages'][0]['from_user_id']).toBe(bsuid())
  })

  it('with the phone number again within 30 days of the business messaging that phone', async () => {
    const { e, values, flush } = harness()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hi' } } })
    e.sendMessage(e.state.defaultPhoneNumberId, text({ to: CUSTOMER }))
    e.clock.advance(DAY)
    e.simulateInbound({ from: CUSTOMER, username: 'pablo', message: { type: 'text', text: { body: 'again' } } })
    await flush()

    const inbound = values().filter((v) => v['messages'])
    expect(inbound[1]!['contacts'][0]['wa_id']).toBe(CUSTOMER)
  })

  it('without it once those 30 days have passed', async () => {
    const { e, values, flush } = harness()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hi' } } })
    e.sendMessage(e.state.defaultPhoneNumberId, text({ to: CUSTOMER }))
    e.clock.advance(31 * DAY)
    e.simulateInbound({ from: CUSTOMER, username: 'pablo', message: { type: 'text', text: { body: 'again' } } })
    await flush()

    const inbound = values().filter((v) => v['messages'])
    expect(inbound.at(-1)!['contacts'][0]).not.toHaveProperty('wa_id')
  })

  it('gives the same user another BSUID under another portfolio', () => {
    const { e } = harness()
    const other = e.createSignup().phone_number_id
    const here = e.users.bsuid(e.state.defaultBusinessId, CUSTOMER)
    const there = e.users.bsuid(e.state.businessIdOf(other)!, CUSTOMER)
    expect(here).not.toBe(there)
  })
})

describe('statuses identify the recipient by BSUID too', () => {
  it('for a message sent to a phone number', async () => {
    const { e, statuses, bsuid, flush } = harness()
    e.simulateInbound({ from: CUSTOMER, contactName: 'Pablo', username: 'pablo', message: { type: 'text', text: { body: 'hi' } } })
    e.sendMessage(e.state.defaultPhoneNumberId, text({ to: CUSTOMER }))
    await flush()

    const [sent, delivered] = statuses()
    expect(sent!['statuses'][0]).toMatchObject({ recipient_id: CUSTOMER, recipient_user_id: bsuid() })
    // Sent to the phone number: wa_id is always there. The username is not on `sent`.
    expect(sent!['contacts']).toEqual([{ profile: { name: 'Pablo' }, wa_id: CUSTOMER, user_id: bsuid() }])
    expect(delivered!['contacts']).toEqual([
      { profile: { name: 'Pablo', username: 'pablo' }, wa_id: CUSTOMER, user_id: bsuid() },
    ])
  })

  it('leaves contacts and the BSUID off a failed status for a phone-number send', async () => {
    const { e, statuses, flush } = harness()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hi' } } })
    const id = e.sendMessage(e.state.defaultPhoneNumberId, text({ to: CUSTOMER })).messages[0]!.id
    await flush()
    e.forceStatus(id, 'failed', 131026)
    await flush()

    const failed = statuses().at(-1)!
    expect(failed).not.toHaveProperty('contacts')
    expect(failed['statuses'][0]).not.toHaveProperty('recipient_user_id')
    expect(failed['statuses'][0]['recipient_id']).toBe(CUSTOMER)
  })
})

describe('sending to a BSUID with `recipient`', () => {
  it('reaches the customer and answers with user_id instead of wa_id', async () => {
    const { e, bsuid } = harness()
    e.simulateInbound({ from: CUSTOMER, username: 'pablo', message: { type: 'text', text: { body: 'hi' } } })

    const res = e.sendMessage(e.state.defaultPhoneNumberId, text({ recipient: bsuid() }))
    expect(res.contacts).toEqual([{ input: bsuid(), user_id: bsuid() }])
    expect(e.state.outbound()[0]).toMatchObject({ to: CUSTOMER, recipientUserId: bsuid(), sentTo: 'user_id' })
  })

  it('keeps the phone number off statuses when it cannot be shared', async () => {
    const { e, statuses, bsuid, flush } = harness()
    e.simulateInbound({ from: CUSTOMER, username: 'pablo', message: { type: 'text', text: { body: 'hi' } } })
    e.sendMessage(e.state.defaultPhoneNumberId, text({ recipient: bsuid() }))
    await flush()

    const delivered = statuses()[1]!
    expect(delivered['statuses'][0]).not.toHaveProperty('recipient_id')
    expect(delivered['statuses'][0]['recipient_user_id']).toBe(bsuid())
    expect(delivered['contacts'][0]).not.toHaveProperty('wa_id')
  })

  it('keeps the BSUID on a failed status for a BSUID send', async () => {
    const { e, statuses, bsuid, flush } = harness()
    e.simulateInbound({ from: CUSTOMER, username: 'pablo', message: { type: 'text', text: { body: 'hi' } } })
    const id = e.sendMessage(e.state.defaultPhoneNumberId, text({ recipient: bsuid() })).messages[0]!.id
    e.forceStatus(id, 'failed', 131026)
    await flush()

    const failed = statuses().find((v) => v['statuses'][0]['status'] === 'failed')!
    expect(failed['statuses'][0]['recipient_user_id']).toBe(bsuid())
    expect(failed).not.toHaveProperty('contacts')
  })

  it('lets `to` win when both are present, as Meta does', () => {
    const { e, bsuid } = harness()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hi' } } })
    const res = e.sendMessage(e.state.defaultPhoneNumberId, text({ to: CUSTOMER, recipient: bsuid() }))
    expect(res.contacts).toEqual([{ input: CUSTOMER, wa_id: CUSTOMER }])
    // A phone-number send all the way down, not just in the response.
    expect(e.state.outbound()[0]!.sentTo).toBe('phone')
  })

  it('still needs an open window for a free-form message', () => {
    const { e, bsuid } = harness()
    expect(codeOf(() => e.sendMessage(e.state.defaultPhoneNumberId, text({ recipient: bsuid() })))).toBe(131047)
  })

  it('fails for a BSUID scoped to another portfolio', () => {
    const { e } = harness()
    const other = e.createSignup().phone_number_id
    const foreign = e.users.bsuid(e.state.businessIdOf(other)!, CUSTOMER)
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hi' } } })
    expect(codeOf(() => e.sendMessage(e.state.defaultPhoneNumberId, text({ recipient: foreign })))).toBe(131009)
  })

  it('fails for a BSUID nobody issued', () => {
    const { e } = harness()
    expect(codeOf(() => e.sendMessage(e.state.defaultPhoneNumberId, text({ recipient: 'MX.123' })))).toBe(131009)
  })

  it('refuses an authentication template with 131062', () => {
    const { e, bsuid } = harness()
    bsuid()
    e.createTemplate(e.state.defaultWabaId, { name: 'otp', language: 'es_MX', category: 'AUTHENTICATION', components: [] })
    e.transitionTemplate(e.state.defaultWabaId, 'otp', 'es_MX', 'APPROVED')
    const send = () =>
      e.sendMessage(e.state.defaultPhoneNumberId, {
        messaging_product: 'whatsapp',
        recipient: bsuid(),
        type: 'template',
        template: { name: 'otp', language: { code: 'es_MX' } },
      })
    expect(codeOf(send)).toBe(131062)
  })
})

describe('a user changing their phone number', () => {
  it('arrives as user_changed_number when the new number can be shared', async () => {
    const { e, values, flush } = harness()
    e.simulateInbound({ from: CUSTOMER, contactName: 'Sheena Nelson', message: { type: 'text', text: { body: 'hi' } } })
    const before = e.users.bsuid(e.state.defaultBusinessId, CUSTOMER)
    e.changeUserNumber({ from: CUSTOMER, to: '5215555000099' })
    await flush()

    const message = values().at(-1)!['messages'][0]
    expect(message).toMatchObject({
      from: CUSTOMER,
      type: 'system',
      system: {
        body: `User Sheena Nelson changed from ${CUSTOMER} to 5215555000099`,
        wa_id: '5215555000099',
        type: 'user_changed_number',
        user_id: e.users.bsuid(e.state.defaultBusinessId, '5215555000099'),
        previous_user_id: before,
      },
    })
    expect(values().at(-1)).not.toHaveProperty('contacts')
  })

  it('arrives as user_changed_user_id, with no phone number, for a user with a username', async () => {
    const { e, values, flush } = harness()
    e.simulateInbound({ from: CUSTOMER, username: 'pablo', message: { type: 'text', text: { body: 'hi' } } })
    const before = e.users.bsuid(e.state.defaultBusinessId, CUSTOMER)
    e.changeUserNumber({ from: CUSTOMER, to: '5215555000099' })
    await flush()

    const message = values().at(-1)!['messages'][0]
    const after = e.users.bsuid(e.state.defaultBusinessId, '5215555000099')
    expect(message).not.toHaveProperty('from')
    expect(message.system).toEqual({
      body: `User changed from ${before} to ${after}`,
      type: 'user_changed_user_id',
      user_id: after,
      previous_user_id: before,
    })
  })

  it('carries the username over to the new number', () => {
    const { e } = harness()
    e.simulateInbound({ from: CUSTOMER, username: 'pablo', message: { type: 'text', text: { body: 'hi' } } })
    e.changeUserNumber({ from: CUSTOMER, to: '5215555000099' })
    expect(e.users.profile('5215555000099')).toEqual({ username: 'pablo' })
  })
})

describe('the same, through the control API and the library', () => {
  it('takes a username on POST /__mock/inbound and hides the phone number', async () => {
    const { createServer } = await import('../src/server.js')
    const { e, values } = harness()
    const app = createServer(e)
    await app.ready()
    try {
      await app.inject({
        method: 'POST',
        url: '/__mock/inbound',
        payload: JSON.stringify({ from: CUSTOMER, text: 'hola', username: 'pablo' }),
      })
      const value = values()[0]!
      expect(value['contacts'][0]).toEqual({ profile: { username: 'pablo' }, user_id: e.users.bsuid(e.state.defaultBusinessId, CUSTOMER) })
      expect(value['messages'][0]).not.toHaveProperty('from')
    } finally {
      await app.close()
    }
  })

  it('announces POST /__mock/users/change-number before answering', async () => {
    const { createServer } = await import('../src/server.js')
    const { e, values } = harness()
    const app = createServer(e)
    await app.ready()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/__mock/users/change-number',
        payload: JSON.stringify({ from: CUSTOMER, to: '5215555000099' }),
      })
      expect(res.json()).toEqual({ success: true })
      expect(values().at(-1)!['messages'][0]['system']['type']).toBe('user_changed_number')
    } finally {
      await app.close()
    }
  })

  it('names a mistyped key on POST /__mock/users/change-number', async () => {
    const { createServer } = await import('../src/server.js')
    const { e } = harness()
    const app = createServer(e)
    await app.ready()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/__mock/users/change-number',
        payload: JSON.stringify({ from: CUSTOMER, new: '5215555000099' }),
      })
      expect(res.json().error.error_data.details).toBe("to: Required; Unrecognized key(s) in object: 'new'")
    } finally {
      await app.close()
    }
  })

  it('sends to a BSUID and changes numbers through createWamock', async () => {
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
      await mock.inbound({ from: CUSTOMER, text: 'hola', username: 'pablo' })
      const userId = JSON.parse(payloads[0]!).entry[0].changes[0].value.contacts[0].user_id as string

      await mock.send({ recipient: userId, text: 'buenas' })
      expect(mock.messages()[0]).toMatchObject({ to: CUSTOMER, recipientUserId: userId, sentTo: 'user_id' })

      await mock.changeUserNumber({ from: CUSTOMER, to: '5215555000099' })
      expect(JSON.parse(payloads.at(-1)!).entry[0].changes[0].value.messages[0].system.previous_user_id).toBe(userId)
    } finally {
      await mock.close()
    }
  })
})
