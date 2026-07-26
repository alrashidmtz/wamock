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
    from: '5215555000001',
    contactName: 'Test Customer',
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

  it('reports the business number WITH a leading +', () => {
    expect(payload.entry[0]!.changes[0]!.value.metadata.display_phone_number).toBe('+15550001111')
  })

  it('normalizes a + the caller passed in the customer number', () => {
    const p = buildInboundPayload({
      ...CONTEXT,
      from: '+5215555000001',
      messageId: 'wamid.IN2',
      timestampMs: 0,
      message: { type: 'text', text: { body: 'x' } },
    })
    expect(p.entry[0]!.changes[0]!.value.messages?.[0]?.from).toBe('5215555000001')
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
      from: '5215555000001',
      messageId: 'wamid.IN3',
      timestampMs: 0,
      message: { type: 'text', text: { body: 'x' } },
    })
    expect(p.entry[0]!.changes[0]!.value.contacts?.[0]?.profile).toBeUndefined()
  })

  it('carries an interactive button reply through untouched', () => {
    const p = buildInboundPayload({
      ...CONTEXT,
      from: '5215555000001',
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
    recipientId: '5215555000001',
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

  it('attaches errors[] on a failed status', () => {
    const failed = buildStatusPayload({
      ...CONTEXT,
      messageId: 'wamid.OUT2',
      status: 'failed',
      recipientId: '5215555000001',
      timestampMs: 0,
      errorCode: 131026,
    })
    expect(failed.entry[0]!.changes[0]!.value.statuses?.[0]?.errors?.[0]).toMatchObject({
      code: 131026,
      title: 'Message undeliverable',
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
      recipientId: '5215555000001',
      timestampMs: 0,
      errorCode: 999999,
    })
    expect(unknown.entry[0]!.changes[0]!.value.statuses?.[0]?.errors?.[0]?.title).toBe(
      'Message failed to send',
    )
  })

  it('attaches conversation and pricing when supplied', () => {
    // Spec §5.4: integrators bill per conversation, not per message. Without
    // these objects they cannot test their own conversation counting.
    const priced = buildStatusPayload({
      ...CONTEXT,
      messageId: 'wamid.OUT4',
      status: 'sent',
      recipientId: '5215555000001',
      timestampMs: 0,
      conversation: { id: 'CONV_1', origin: { type: 'service' } },
      pricing: { billable: true, pricing_model: 'CBP', category: 'service' },
    })
    const status = priced.entry[0]!.changes[0]!.value.statuses?.[0]
    expect(status?.conversation).toMatchObject({ id: 'CONV_1' })
    expect(status?.pricing).toMatchObject({ category: 'service' })
  })

  it('omits conversation and pricing when not supplied', () => {
    expect(payload.entry[0]!.changes[0]!.value.statuses?.[0]?.conversation).toBeUndefined()
    expect(payload.entry[0]!.changes[0]!.value.statuses?.[0]?.pricing).toBeUndefined()
  })
})
