import { describe, expect, it } from 'vitest'

import { buildInboundPayload, buildStatusPayload } from '../../src/webhooks/payloads.js'

const CONTEXT = {
  wabaId: 'WABA_1',
  phoneNumberId: 'PNID_1',
  displayPhoneNumber: '15550001111',
}

describe('buildInboundPayload', () => {
  const payload = buildInboundPayload({
    ...CONTEXT,
    user: { waId: '5215555000001', userId: 'MX.1', phoneShared: true, name: 'Test Customer' },
    messageId: 'wamid.IN1',
    timestampMs: 1_750_000_000_000,
    message: { type: 'text', text: { body: 'hola' } },
  })

  it('wraps the change in Meta’s entry/changes envelope', () => {
    expect(payload).toMatchObject({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA_1', changes: [{ field: 'messages' }] }],
    })
  })

  it('reports the customer number WITHOUT a leading + — the quirk that bites', () => {
    const value = payload.entry[0]!.changes[0]!.value
    expect(value.contacts?.[0]?.wa_id).toBe('5215555000001')
    expect(value.messages?.[0]?.from).toBe('5215555000001')
  })

  it('reports the business number as digits only, with no +', () => {
    expect(payload.entry[0]!.changes[0]!.value.metadata.display_phone_number).toBe('15550001111')
  })

  it('renders the timestamp as a string of unix SECONDS, not millis', () => {
    expect(payload.entry[0]!.changes[0]!.value.messages?.[0]?.timestamp).toBe('1750000000')
  })

  it('omits the statuses key entirely on a message webhook', () => {
    expect('statuses' in payload.entry[0]!.changes[0]!.value).toBe(false)
  })

  it('omits contacts[].profile when no contact name is known', () => {
    const p = buildInboundPayload({
      ...CONTEXT,
      user: { waId: '5215555000001', userId: 'MX.1', phoneShared: true },
      messageId: 'wamid.IN3',
      timestampMs: 0,
      message: { type: 'text', text: { body: 'x' } },
    })
    expect(p.entry[0]!.changes[0]!.value.contacts?.[0]?.profile).toBeUndefined()
  })

  it('carries an interactive button reply through untouched', () => {
    const p = buildInboundPayload({
      ...CONTEXT,
      user: { waId: '5215555000001', userId: 'MX.1', phoneShared: true },
      messageId: 'wamid.IN4',
      timestampMs: 0,
      message: {
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Yes' } },
      },
    })
    expect(p.entry[0]!.changes[0]!.value.messages?.[0]).toMatchObject({
      type: 'interactive',
      interactive: { button_reply: { id: 'yes' } },
    })
  })
})

describe('buildStatusPayload', () => {
  const payload = buildStatusPayload({
    ...CONTEXT,
    messageId: 'wamid.OUT1',
    status: 'delivered',
    user: { waId: '5215555000001', userId: 'MX.1', phoneShared: true },
    sentTo: 'phone',
    timestampMs: 1_750_000_120_000,
  })

  it('omits the messages key entirely — delivery receipts arrive alone', () => {
    // Spec §5.2: parsers that assume `value.messages` exists crash on every
    // delivery receipt. wamock sends them the way Meta does so that breaks here.
    expect('messages' in payload.entry[0]!.changes[0]!.value).toBe(false)
  })

  it('reports recipient_id without a leading +', () => {
    expect(payload.entry[0]!.changes[0]!.value.statuses?.[0]?.recipient_id).toBe('5215555000001')
  })

  it('renders the timestamp as unix seconds', () => {
    expect(payload.entry[0]!.changes[0]!.value.statuses?.[0]?.timestamp).toBe('1750000120')
  })

  // Left to Stryker: `failed && errorCode !== undefined` → `failed && true`.
  // Every caller hands a failed status its code (forceStatus refuses one
  // without), so the second half only narrows the type.
  it('attaches errors[] to a failed status only, whatever error code it is handed', () => {
    for (const status of ['sent', 'delivered', 'read', 'played'] as const) {
      const built = buildStatusPayload({
        ...CONTEXT,
        messageId: 'wamid.OUT1',
        status,
        user: { waId: '5215555000001', userId: 'MX.1', phoneShared: true },
        sentTo: 'phone',
        timestampMs: 1_750_000_120_000,
        errorCode: 131026,
      })
      expect(built.entry[0]!.changes[0]!.value.statuses?.[0], status).not.toHaveProperty('errors')
    }
  })

  it('attaches errors[] on a failed status', () => {
    const failed = buildStatusPayload({
      ...CONTEXT,
      messageId: 'wamid.OUT2',
      status: 'failed',
      user: { waId: '5215555000001', userId: 'MX.1', phoneShared: true },
      sentTo: 'phone',
      timestampMs: 0,
      errorCode: 131026,
    })
    expect(failed.entry[0]!.changes[0]!.value.statuses?.[0]?.errors?.[0]).toMatchObject({
      code: 131026,
      title: 'Message undeliverable',
    })
  })

  it('renders 131049 exactly as Meta’s own failed-status example', () => {
    const failed = buildStatusPayload({
      ...CONTEXT,
      messageId: 'wamid.OUT5',
      status: 'failed',
      user: { waId: '5215555000001', userId: 'MX.1', phoneShared: true },
      sentTo: 'phone',
      timestampMs: 0,
      errorCode: 131049,
    })
    expect(failed.entry[0]!.changes[0]!.value.statuses?.[0]?.errors).toEqual([
      {
        code: 131049,
        title: 'This message was not delivered to maintain healthy ecosystem engagement.',
        message: 'This message was not delivered to maintain healthy ecosystem engagement.',
        error_data: {
          details: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
        },
        href: '/documentation/business-messaging/whatsapp/support/error-codes',
      },
    ])
  })

  it('falls back to the title as details when it has nothing better', () => {
    const unknown = buildStatusPayload({
      ...CONTEXT,
      messageId: 'wamid.OUT6',
      status: 'failed',
      user: { waId: '5215555000001', userId: 'MX.1', phoneShared: true },
      sentTo: 'phone',
      timestampMs: 0,
      errorCode: 999999,
    })
    expect(unknown.entry[0]!.changes[0]!.value.statuses?.[0]?.errors?.[0]?.error_data).toEqual({
      details: 'Message failed to send',
    })
  })

  it('does not attach errors[] on a successful status', () => {
    expect(payload.entry[0]!.changes[0]!.value.statuses?.[0]?.errors).toBeUndefined()
  })

  it('falls back to a generic title for a code it has no wording for', () => {
    const unknown = buildStatusPayload({
      ...CONTEXT,
      messageId: 'wamid.OUT3',
      status: 'failed',
      user: { waId: '5215555000001', userId: 'MX.1', phoneShared: true },
      sentTo: 'phone',
      timestampMs: 0,
      errorCode: 999999,
    })
    expect(unknown.entry[0]!.changes[0]!.value.statuses?.[0]?.errors?.[0]?.title).toBe(
      'Message failed to send',
    )
  })

  it('attaches pricing when supplied', () => {
    const priced = buildStatusPayload({
      ...CONTEXT,
      messageId: 'wamid.OUT4',
      status: 'delivered',
      user: { waId: '5215555000001', userId: 'MX.1', phoneShared: true },
      sentTo: 'phone',
      timestampMs: 0,
      pricing: { billable: false, pricing_model: 'PMP', type: 'free_customer_service', category: 'service' },
    })
    const status = priced.entry[0]!.changes[0]!.value.statuses?.[0]
    expect(status?.pricing).toMatchObject({ pricing_model: 'PMP', category: 'service' })
  })

  it('omits pricing when not supplied', () => {
    expect(payload.entry[0]!.changes[0]!.value.statuses?.[0]?.pricing).toBeUndefined()
  })
})
