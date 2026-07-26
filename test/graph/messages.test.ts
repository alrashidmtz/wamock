import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../../src/core/engine.js'
import { GraphError } from '../../src/errors/graph-error.js'

const EPOCH = 1_750_000_000_000

function engine() {
  return new WamockEngine({ appSecret: 'app-secret', mode: 'frozen', start: EPOCH })
}

const textBody = (to = '5215555000001') => ({
  messaging_product: 'whatsapp',
  to,
  type: 'text',
  text: { body: 'hola' },
})

describe('sendMessage — success response', () => {
  it('returns the envelope Meta returns', () => {
    const e = engine()
    const res = e.sendMessage(e.state.defaultPhoneNumberId, textBody())

    expect(res).toMatchObject({
      messaging_product: 'whatsapp',
      contacts: [{ input: '5215555000001', wa_id: '5215555000001' }],
      messages: [{ message_status: 'accepted' }],
    })
    expect(res.messages[0]!.id).toMatch(/^wamid\./)
  })

  it('echoes `input` exactly as sent but normalizes `wa_id`', () => {
    // Meta echoes what you gave it in `input` and returns the canonical form in
    // `wa_id`. Integrations that key off `input` inherit whatever they typed.
    const e = engine()
    const res = e.sendMessage(e.state.defaultPhoneNumberId, textBody('+52 1 555 500 0001'))

    expect(res.contacts[0]!.input).toBe('+52 1 555 500 0001')
    expect(res.contacts[0]!.wa_id).toBe('5215555000001')
  })

  it('produces the same wamid for the same call sequence after a reset', () => {
    const e = engine()
    const first = e.sendMessage(e.state.defaultPhoneNumberId, textBody()).messages[0]!.id
    e.reset()
    const second = e.sendMessage(e.state.defaultPhoneNumberId, textBody()).messages[0]!.id

    expect(second).toBe(first)
  })

  it('records the send for later inspection', () => {
    const e = engine()
    e.sendMessage(e.state.defaultPhoneNumberId, textBody())

    expect(e.state.outbound()).toHaveLength(1)
    expect(e.state.outbound()[0]).toMatchObject({
      to: '5215555000001',
      type: 'text',
      sentAt: EPOCH,
    })
  })
})

describe('sendMessage — validation', () => {
  const expectGraphError = (fn: () => unknown, code: number) => {
    try {
      fn()
    } catch (err) {
      expect(err).toBeInstanceOf(GraphError)
      expect((err as GraphError).code).toBe(code)
      return
    }
    throw new Error(`expected a GraphError with code ${code}, but nothing was thrown`)
  }

  it('rejects a phone_number_id the mock does not host', () => {
    expectGraphError(() => engine().sendMessage('PNID_GHOST', textBody()), 100)
  })

  it('rejects a missing messaging_product', () => {
    const e = engine()
    expectGraphError(
      () => e.sendMessage(e.state.defaultPhoneNumberId, { to: '5215555000001', type: 'text', text: { body: 'x' } }),
      100,
    )
  })

  it('rejects a messaging_product other than whatsapp', () => {
    const e = engine()
    expectGraphError(
      () => e.sendMessage(e.state.defaultPhoneNumberId, { ...textBody(), messaging_product: 'sms' }),
      100,
    )
  })

  it('rejects a missing `to`', () => {
    const e = engine()
    expectGraphError(
      () => e.sendMessage(e.state.defaultPhoneNumberId, { messaging_product: 'whatsapp', type: 'text', text: { body: 'x' } }),
      100,
    )
  })

  it('rejects a recipient that cannot be a phone number with 131026, not 100', () => {
    // A malformed request is a 100; a well-formed request to an unreachable
    // number is a 131026. Integrations branch on exactly this distinction to
    // decide between "fix my code" and "drop this lead".
    const e = engine()
    expectGraphError(() => e.sendMessage(e.state.defaultPhoneNumberId, textBody('123')), 131026)
  })

  it('rejects a text send with no text body', () => {
    const e = engine()
    expectGraphError(
      () => e.sendMessage(e.state.defaultPhoneNumberId, { messaging_product: 'whatsapp', to: '5215555000001', type: 'text' }),
      100,
    )
  })

  it('rejects an unsupported message type', () => {
    const e = engine()
    expectGraphError(
      () => e.sendMessage(e.state.defaultPhoneNumberId, { messaging_product: 'whatsapp', to: '5215555000001', type: 'sticker' }),
      100,
    )
  })

  it('does not record a rejected send', () => {
    const e = engine()
    try {
      e.sendMessage(e.state.defaultPhoneNumberId, textBody('123'))
    } catch {
      /* expected */
    }
    expect(e.state.outbound()).toHaveLength(0)
  })
})

describe('sendMessage — scheduled delivery statuses', () => {
  it('emits sent then delivered as the clock advances', async () => {
    const e = engine()
    const wamid = e.sendMessage(e.state.defaultPhoneNumberId, textBody()).messages[0]!.id

    e.clock.advance(60_000)
    await e.settle()

    const statuses = e.deliverer
      .log()
      .map((d) => d.payload.entry[0]!.changes[0]!.value.statuses?.[0])
      .filter(Boolean)

    expect(statuses.map((s) => s!.status)).toEqual(['sent', 'delivered'])
    expect(statuses.every((s) => s!.id === wamid)).toBe(true)
  })

  it('sends each status in its own webhook, with no messages key', async () => {
    const e = engine()
    e.sendMessage(e.state.defaultPhoneNumberId, textBody())

    e.clock.advance(60_000)
    await e.settle()

    for (const delivery of e.deliverer.log()) {
      expect('messages' in delivery.payload.entry[0]!.changes[0]!.value).toBe(false)
    }
  })

  it('emits nothing before the clock moves', async () => {
    const e = engine()
    e.sendMessage(e.state.defaultPhoneNumberId, textBody())
    await e.settle()

    expect(e.deliverer.log()).toHaveLength(0)
  })
})
