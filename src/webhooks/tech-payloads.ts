import { toWebhookDisplayNumber } from '../core/phone.js'
import type { AccountChange, WebhookPayload } from './payloads.js'

/**
 * Webhook payloads that only exist in tech-provider mode (spec §9.4, §9.5).
 *
 * Both matter because they arrive **asynchronously and unprompted**. A template
 * approval lands hours after submission; a limit change lands whenever Meta
 * decides. Integrations that only react to their own API calls miss both,
 * and the first sign of trouble is messages failing.
 */

/**
 * `message_template_status_update` — approval, rejection, pause, unpause or
 * disablement.
 *
 * `message_template_id` is a NUMBER here, as in Meta's reference, although the
 * template API hands the same id out as a string. A receiver that compares
 * the two with `===` never matches its own template.
 */
export function buildTemplateStatusPayload(options: {
  wabaId: string
  templateId: string
  name: string
  language: string
  category: string
  event: string
  reason?: string
  timeMs: number
  otherInfo?: { title: string; description: string }
  disableDateMs?: number
  rejectionInfo?: { reason: string; recommendation: string }
}): WebhookPayload<AccountChange> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: options.wabaId,
        time: Math.floor(options.timeMs / 1000),
        changes: [
          {
            field: 'message_template_status_update',
            value: {
              event: options.event,
              message_template_id: Number(options.templateId),
              message_template_name: options.name,
              message_template_language: options.language,
              // Meta always sends a reason; NONE for an approval or a pause.
              reason: options.reason ?? 'NONE',
              message_template_category: options.category,
              ...(options.disableDateMs !== undefined
                ? { disable_info: { disable_date: Math.floor(options.disableDateMs / 1000) } }
                : {}),
              ...(options.otherInfo ? { other_info: options.otherInfo } : {}),
              ...(options.rejectionInfo ? { rejection_info: options.rejectionInfo } : {}),
            },
          },
        ],
      },
    ],
  }
}

/**
 * `business_capability_update` — the portfolio's messaging limit changed.
 *
 * `max_daily_conversations_per_business` is a NUMBER here (`2000`, and `-1`
 * for unlimited), as in Meta's payload example and its declared type — not
 * the `TIER_2K` string the phone-number lookup returns for the same limit.
 * Meta's reference lists tier strings in the same breath; the example and the
 * type agree with each other, so wamock follows them. A receiver that maps
 * one format onto the other should accept both.
 */
export function buildBusinessCapabilityPayload(options: {
  wabaId: string
  maxDailyConversationsPerBusiness: number
  timeMs: number
}): WebhookPayload<AccountChange> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: options.wabaId,
        time: Math.floor(options.timeMs / 1000),
        changes: [
          {
            field: 'business_capability_update',
            value: {
              max_daily_conversations_per_business: options.maxDailyConversationsPerBusiness,
            },
          },
        ],
      },
    ],
  }
}

/**
 * `phone_number_quality_update` for a throughput upgrade, as Meta's
 * throughput page describes it: `event` THROUGHPUT_UPGRADE and
 * `max_daily_conversations_per_business` TIER_UNLIMITED. The older
 * `current_limit` is left out: the reference says it was removed in February
 * 2026. The business number is digits only, as in every webhook.
 */
export function buildThroughputUpgradePayload(options: {
  wabaId: string
  displayPhoneNumber: string
  timeMs: number
}): WebhookPayload<AccountChange> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: options.wabaId,
        time: Math.floor(options.timeMs / 1000),
        changes: [
          {
            field: 'phone_number_quality_update',
            value: {
              display_phone_number: toWebhookDisplayNumber(options.displayPhoneNumber),
              event: 'THROUGHPUT_UPGRADE',
              max_daily_conversations_per_business: 'TIER_UNLIMITED',
            },
          },
        ],
      },
    ],
  }
}

/**
 * `template_category_update` — Meta recategorizing an approved template.
 *
 * Two shapes. The advance notice, 24 hours ahead, carries `correct_category`
 * (what it will become) and `new_category`, which holds the template's
 * CURRENT category: a receiver that reads `new_category` as the new one
 * applies the change a day early and to the wrong value. The change itself
 * carries `previous_category` and `new_category`.
 */
export function buildTemplateCategoryPayload(
  options: {
    wabaId: string
    templateId: string
    name: string
    language: string
    timeMs: number
  } & (
    | { notice: { current: string; correct: string; updateAtMs: number } }
    | { change: { previous: string; next: string } }
  ),
): WebhookPayload<AccountChange> {
  const detail =
    'notice' in options
      ? {
          new_category: options.notice.current,
          correct_category: options.notice.correct,
          category_update_timestamp: Math.floor(options.notice.updateAtMs / 1000),
        }
      : { previous_category: options.change.previous, new_category: options.change.next }

  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: options.wabaId,
        time: Math.floor(options.timeMs / 1000),
        changes: [
          {
            field: 'template_category_update',
            value: {
              message_template_id: Number(options.templateId),
              message_template_name: options.name,
              message_template_language: options.language,
              ...detail,
            },
          },
        ],
      },
    ],
  }
}
