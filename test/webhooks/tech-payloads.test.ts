import { describe, expect, it } from 'vitest'

import {
  buildQualityUpdatePayload,
  buildTemplateStatusPayload,
} from '../../src/webhooks/tech-payloads.js'

const valueOf = (payload: ReturnType<typeof buildQualityUpdatePayload>) =>
  payload.entry[0]!.changes[0]!.value as unknown as Record<string, unknown>

const fieldOf = (payload: ReturnType<typeof buildQualityUpdatePayload>) =>
  payload.entry[0]!.changes[0]!.field

describe('buildQualityUpdatePayload', () => {
  it('reports a downgrade as FLAGGED', () => {
    const payload = buildQualityUpdatePayload({
      wabaId: 'WABA_1',
      displayPhoneNumber: '+15550001111',
      quality: 'RED',
      currentLimit: 'TIER_250',
    })

    expect(fieldOf(payload)).toBe('phone_number_quality_update')
    expect(valueOf(payload)).toMatchObject({ event: 'FLAGGED', current_limit: 'TIER_250' })
  })

  it('reports YELLOW as FLAGGED too — anything short of GREEN is a warning', () => {
    const payload = buildQualityUpdatePayload({
      wabaId: 'WABA_1',
      displayPhoneNumber: '+15550001111',
      quality: 'YELLOW',
      currentLimit: 'TIER_1K',
    })

    expect(valueOf(payload)['event']).toBe('FLAGGED')
  })

  it('reports a recovery to GREEN as UPGRADE', () => {
    // Meta sends an EVENT, not the rating. Code that reads `quality_rating`
    // off this webhook gets undefined — which is why the mapping is explicit.
    const payload = buildQualityUpdatePayload({
      wabaId: 'WABA_1',
      displayPhoneNumber: '+15550001111',
      quality: 'GREEN',
      currentLimit: 'TIER_10K',
    })

    expect(valueOf(payload)['event']).toBe('UPGRADE')
    expect(valueOf(payload)['quality_rating']).toBeUndefined()
  })
})

describe('buildTemplateStatusPayload', () => {
  it('uses the message_template_status_update field, not messages', () => {
    const payload = buildTemplateStatusPayload({
      wabaId: 'WABA_1',
      templateId: '1001',
      name: 'order_update',
      language: 'es_MX',
      event: 'APPROVED',
      reason: 'NONE',
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
      event: 'APPROVED',
    })

    expect(valueOf(payload)['reason']).toBe('NONE')
  })
})
