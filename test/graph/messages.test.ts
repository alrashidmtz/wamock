import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../../src/core/engine.js'
import { GraphError } from '../../src/errors/graph-error.js'

const EPOCH = 1_750_000_000_000

function engine() {
  return new WamockEngine({ appSecret: 'app-secret', mode: 'frozen', start: EPOCH })
}

/**
 * Free-form sends need an open 24h window (see send-gating.test.ts). These
 * tests are about the send path itself, so every one of them starts from a
 * customer having written in — the same precondition a real integration has.
 */
function openWindow(e: WamockEngine) {
  e.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
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
    openWindow(e)
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
    openWindow(e)
    const res = e.sendMessage(e.state.defaultPhoneNumberId, textBody('+52 1 555 500 0001'))

    expect(res.contacts[0]!.input).toBe('+52 1 555 500 0001')
    expect(res.contacts[0]!.wa_id).toBe('5215555000001')
  })

  it('produces the same wamid for the same call sequence after a reset', () => {
    const e = engine()
    openWindow(e)
    const first = e.sendMessage(e.state.defaultPhoneNumberId, textBody()).messages[0]!.id
    e.reset()
    openWindow(e)
    const second = e.sendMessage(e.state.defaultPhoneNumberId, textBody()).messages[0]!.id

    expect(second).toBe(first)
  })

  it('records the send for later inspection', () => {
    const e = engine()
    openWindow(e)
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
    openWindow(e)
    const wamid = e.sendMessage(e.state.defaultPhoneNumberId, textBody()).messages[0]!.id

    e.clock.advance(60_000)
    await e.settle()

    const statuses = e.deliverer
      .log()
      .map((d) => d.payload.entry[0]!.changes[0]!)
      .map((change) => (change.field === 'messages' ? change.value.statuses?.[0] : undefined))
      .filter(Boolean)

    expect(statuses.map((s) => s!.status)).toEqual(['sent', 'delivered'])
    expect(statuses.every((s) => s!.id === wamid)).toBe(true)
  })

  it('sends each status in its own webhook, with no messages key', async () => {
    const e = engine()
    openWindow(e)
    e.sendMessage(e.state.defaultPhoneNumberId, textBody())

    e.clock.advance(60_000)
    await e.settle()

    const statusWebhooks = e.deliverer
      .log()
      .map((d) => d.payload.entry[0]!.changes[0]!.value)
      .filter((value) => value.statuses !== undefined)

    expect(statusWebhooks).toHaveLength(2)
    for (const value of statusWebhooks) {
      // A status webhook carries statuses and nothing else — no empty
      // `messages` array to make a naive parser look correct.
      expect('messages' in value).toBe(false)
    }
  })

  it('emits nothing before the clock moves', async () => {
    const e = engine()
    openWindow(e)
    e.sendMessage(e.state.defaultPhoneNumberId, textBody())
    await e.settle()

    expect(e.deliverer.log()).toHaveLength(0)
  })
})

/** The `error_data.details` a Graph error renders, which is where the reason lives. */
const detailsOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    return (err as GraphError).toBody('x').error.error_data?.details ?? ''
  }
  throw new Error('expected a GraphError')
}

describe('documented send rules', () => {
  const text = (body: string, extra: Record<string, unknown> = {}) => ({
    messaging_product: 'whatsapp',
    to: '5215555000001',
    type: 'text',
    text: { body },
    ...extra,
  })

  it('accepts a 4096-character text and refuses 4097', () => {
    const e = engine()
    openWindow(e)
    expect(() => e.sendMessage(e.state.defaultPhoneNumberId, text('x'.repeat(4096)))).not.toThrow()
    expect(detailsOf(() => e.sendMessage(e.state.defaultPhoneNumberId, text('x'.repeat(4097))))).toMatch(/4096/)
  })

  it('accepts recipient_type individual, and refuses group, which wamock does not emulate', () => {
    const e = engine()
    openWindow(e)
    expect(() => e.sendMessage(e.state.defaultPhoneNumberId, text('hi', { recipient_type: 'individual' }))).not.toThrow()
    expect(detailsOf(() => e.sendMessage(e.state.defaultPhoneNumberId, text('hi', { recipient_type: 'group' })))).toMatch(/group/)
    expect(detailsOf(() => e.sendMessage(e.state.defaultPhoneNumberId, text('hi', { recipient_type: 'everyone' })))).toMatch(/recipient_type/)
  })

  it('echoes biz_opaque_callback_data on every status of the message', async () => {
    const e = engine()
    openWindow(e)
    const id = e.sendMessage(e.state.defaultPhoneNumberId, text('hi', { biz_opaque_callback_data: 'order-42' })).messages[0]!.id
    e.clock.advance(60_000)
    await e.settle()
    e.forceStatus(id, 'read')
    e.clock.advance(0)
    await e.settle()

    const statuses = e.deliverer
      .log()
      .map((d) => d.payload.entry[0]!.changes[0]!)
      .map((c) => (c.field === 'messages' ? c.value.statuses?.[0] : undefined))
      .filter((s) => s?.id === id)
    expect(statuses.map((s) => s!.status)).toEqual(['sent', 'delivered', 'read'])
    expect(statuses.every((s) => s!.biz_opaque_callback_data === 'order-42')).toBe(true)
  })

  it('takes biz_opaque_callback_data up to Meta’s 512 characters, and nothing but a string', () => {
    const e = engine()
    openWindow(e)
    const send = (opaque: unknown) => () =>
      e.sendMessage(e.state.defaultPhoneNumberId, text('hi', { biz_opaque_callback_data: opaque }))
    expect(send('x'.repeat(512))).not.toThrow()
    for (const opaque of ['x'.repeat(513), 42, { order: 42 }, null]) {
      expect(detailsOf(send(opaque)), JSON.stringify(opaque)).toMatch(/biz_opaque_callback_data/)
    }
    expect(e.state.outbound()).toHaveLength(1)
  })

  it('keeps an access_token sent in the body out of the recorded message', () => {
    const e = engine()
    openWindow(e)
    e.sendMessage(e.state.defaultPhoneNumberId, text('hi', { access_token: 'EAAsecret' }))
    expect(JSON.stringify(e.state.outbound())).not.toContain('EAAsecret')
  })

  it('leaves biz_opaque_callback_data off when the send had none', async () => {
    const e = engine()
    openWindow(e)
    e.sendMessage(e.state.defaultPhoneNumberId, text('hi'))
    e.clock.advance(60_000)
    await e.settle()
    expect(JSON.stringify(e.deliverer.log().map((d) => d.payload))).not.toContain('biz_opaque_callback_data')
  })
})
