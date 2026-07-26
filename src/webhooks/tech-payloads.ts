import type { QualityRating } from '../core/types.js'
import type { WebhookPayload } from './payloads.js'

/**
 * Webhook payloads that only exist in tech-provider mode (spec §9.4, §9.5).
 *
 * Both matter because they arrive **asynchronously and unprompted**. A template
 * approval lands hours after submission; a quality downgrade lands whenever
 * Meta decides. Integrations that only react to their own API calls miss both,
 * and the first sign of trouble is messages failing.
 */

/** `message_template_status_update` — approval, rejection or pause. */
export function buildTemplateStatusPayload(options: {
  wabaId: string
  templateId: string
  name: string
  language: string
  event: string
  reason?: string
}): WebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: options.wabaId,
        changes: [
          {
            field: 'message_template_status_update' as unknown as 'messages',
            value: {
              event: options.event,
              message_template_id: options.templateId,
              message_template_name: options.name,
              message_template_language: options.language,
              // Meta always sends a reason; it is NONE for a clean approval.
              reason: options.reason ?? 'NONE',
            } as never,
          },
        ],
      },
    ],
  }
}

/** `phone_number_quality_update` — a downgrade, or a recovery. */
export function buildQualityUpdatePayload(options: {
  wabaId: string
  displayPhoneNumber: string
  quality: QualityRating
  currentLimit: string
}): WebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: options.wabaId,
        changes: [
          {
            field: 'phone_number_quality_update' as unknown as 'messages',
            value: {
              display_phone_number: options.displayPhoneNumber,
              // Meta reports an EVENT, not the rating: GREEN is UPGRADE,
              // YELLOW/RED are FLAGGED. Reading `quality_rating` off this
              // webhook returns undefined.
              event: options.quality === 'GREEN' ? 'UPGRADE' : 'FLAGGED',
              current_limit: options.currentLimit,
            } as never,
          },
        ],
      },
    ],
  }
}
