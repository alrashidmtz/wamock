import { describe, expect, it } from 'vitest'

import {
  buildBusinessCapabilityPayload,
  buildTemplateStatusPayload,
} from '../../src/webhooks/tech-payloads.js'

const valueOf = (payload: ReturnType<typeof buildTemplateStatusPayload>) =>
  payload.entry[0]!.changes[0]!.value as unknown as Record<string, unknown>

const fieldOf = (payload: ReturnType<typeof buildTemplateStatusPayload>) =>
  payload.entry[0]!.changes[0]!.field

describe('buildBusinessCapabilityPayload', () => {
  it('reports the portfolio limit as a number, on the business_capability_update field', () => {
    const payload = buildBusinessCapabilityPayload({
      wabaId: 'WABA_1',
      maxDailyConversationsPerBusiness: 2000,
      timeMs: 1_750_000_000_999,
    })

    expect(payload).toEqual({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_1',
          time: 1_750_000_000,
          changes: [
            {
              field: 'business_capability_update',
              value: { max_daily_conversations_per_business: 2000 },
            },
          ],
        },
      ],
    })
  })
})

describe('buildTemplateStatusPayload', () => {
  it('uses the message_template_status_update field, not messages', () => {
    const payload = buildTemplateStatusPayload({
      wabaId: 'WABA_1',
      templateId: '1001',
      name: 'order_update',
      language: 'es_MX',
      category: 'UTILITY',
      event: 'APPROVED',
      reason: 'NONE',
      timeMs: 0,
    })

    expect(fieldOf(payload)).toBe('message_template_status_update')
    expect(valueOf(payload)).toMatchObject({
      event: 'APPROVED',
      message_template_name: 'order_update',
      message_template_language: 'es_MX',
    })
  })

  it('always carries a reason, defaulting to NONE', () => {
    // The field is never absent in Meta's payload, so a receiver reading it
    // must never get undefined.
    const payload = buildTemplateStatusPayload({
      wabaId: 'WABA_1',
      templateId: '1001',
      name: 'order_update',
      language: 'es_MX',
      category: 'UTILITY',
      event: 'APPROVED',
      timeMs: 0,
    })

    expect(valueOf(payload)['reason']).toBe('NONE')
  })
})
