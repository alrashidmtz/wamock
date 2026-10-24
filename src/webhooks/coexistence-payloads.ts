import { toWebhookDisplayNumber } from '../core/phone.js'
import type { AccountChange, UserIdentity, WebhookContact, WebhookPayload } from './payloads.js'

/**
 * Webhooks that only exist for coexistence numbers: a phone number used from
 * the WhatsApp Business app and Cloud API at once. Shapes follow Meta's
 * "Onboarding WhatsApp Business app users" guide and the webhook references,
 * with the BSUID fields Meta added in 2026.
 */

interface NumberContext {
  wabaId: string
  phoneNumberId: string
  /** Digits only. */
  displayPhoneNumber: string
}

const toMetaTimestamp = (ms: number): string => String(Math.floor(ms / 1000))

const metadata = (ctx: NumberContext) => ({
  display_phone_number: toWebhookDisplayNumber(ctx.displayPhoneNumber),
  phone_number_id: ctx.phoneNumberId,
})

const envelope = (
  id: string,
  field: AccountChange['field'],
  value: Record<string, unknown>,
  timeMs?: number,
): WebhookPayload<AccountChange> => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id,
      ...(timeMs !== undefined ? { time: Math.floor(timeMs / 1000) } : {}),
      changes: [{ field, value }],
    },
  ],
})

const contactOf = (user: UserIdentity): WebhookContact => ({
  ...(user.username !== undefined ? { profile: { username: user.username } } : {}),
  ...(user.phoneShared ? { wa_id: user.waId } : {}),
  user_id: user.userId,
})

/**
 * `account_update` for the coexistence lifecycle.
 *
 * `PARTNER_ADDED` and `PARTNER_REMOVED` carry `waba_info`, as in the
 * `account_update` reference. The onboarding guide shows `PARTNER_REMOVED`
 * with a `phone_number` field instead; the two pages disagree, and wamock
 * follows the reference. `ACCOUNT_OFFBOARDED` and `ACCOUNT_RECONNECTED`
 * carry nothing but the event.
 */
export function buildAccountUpdatePayload(options: {
  wabaId: string
  timeMs: number
  event: 'PARTNER_ADDED' | 'PARTNER_REMOVED' | 'ACCOUNT_OFFBOARDED' | 'ACCOUNT_RECONNECTED'
  ownerBusinessId?: string
  disconnection?: { reason: string; initiatedBy: 'USER' | 'SYSTEM' }
}): WebhookPayload<AccountChange> {
  const withWabaInfo = options.event === 'PARTNER_ADDED' || options.event === 'PARTNER_REMOVED'
  return envelope(
    options.wabaId,
    'account_update',
    {
      event: options.event,
      ...(withWabaInfo
        ? {
            waba_info: {
              waba_id: options.wabaId,
              ...(options.ownerBusinessId !== undefined ? { owner_business_id: options.ownerBusinessId } : {}),
            },
          }
        : {}),
      ...(options.disconnection
        ? {
            disconnection_info: {
              reason: options.disconnection.reason,
              initiated_by: options.disconnection.initiatedBy,
            },
          }
        : {}),
    },
    options.timeMs,
  )
}

/**
 * `account_update` for authentication-international rates, as Meta's page
 * shows both: `AUTH_INTL_PRICE_ELIGIBILITY_UPDATE` with the start times (unix
 * seconds), and `BUSINESS_PRIMARY_LOCATION_COUNTRY_UPDATE` with the country
 * Meta determined the business is based in.
 */
export function buildAuthInternationalPayload(
  options: { wabaId: string; timeMs: number } & (
    | { event: 'AUTH_INTL_PRICE_ELIGIBILITY_UPDATE'; startTime: number; exceptions: Array<{ country: string; startTime: number }> }
    | { event: 'BUSINESS_PRIMARY_LOCATION_COUNTRY_UPDATE'; country: string }
  ),
): WebhookPayload<AccountChange> {
  const seconds = (ms: number) => Math.floor(ms / 1000)
  return envelope(
    options.wabaId,
    'account_update',
    options.event === 'AUTH_INTL_PRICE_ELIGIBILITY_UPDATE'
      ? {
          auth_international_rate_eligibility: {
            exception_countries: options.exceptions.map((exception) => ({
              country_code: exception.country,
              start_time: seconds(exception.startTime),
            })),
            start_time: seconds(options.startTime),
          },
          event: options.event,
        }
      : { country: options.country, event: options.event },
    options.timeMs,
  )
}

export interface AppContact {
  /** Digits only. */
  phone: string
  full_name?: string
  first_name?: string
}

/**
 * `smb_app_state_sync` — the Business app's contacts, on the first sync and on
 * every later add, edit or removal. A removal leaves the names out.
 */
export function buildStateSyncPayload(
  options: NumberContext & {
    contacts: AppContact[]
    action: 'add' | 'remove'
    timestampMs: number
  },
): WebhookPayload<AccountChange> {
  return envelope(options.wabaId, 'smb_app_state_sync', {
    messaging_product: 'whatsapp',
    metadata: metadata(options),
    state_sync: options.contacts.map((contact) => ({
      type: 'contact',
      contact: {
        ...(options.action === 'add' && contact.full_name !== undefined ? { full_name: contact.full_name } : {}),
        ...(options.action === 'add' && contact.first_name !== undefined ? { first_name: contact.first_name } : {}),
        phone_number: contact.phone,
      },
      action: options.action,
      metadata: { timestamp: toMetaTimestamp(options.timestampMs) },
    })),
  })
}

/**
 * `smb_message_echoes` — a message the business sent from the Business app or
 * a companion device. It is the only way an integration learns what was said
 * from the app; nothing about it touches the service window or the bill.
 */
export function buildMessageEchoPayload(
  options: NumberContext & {
    user: UserIdentity
    messageId: string
    timestampMs: number
    text: string
  },
): WebhookPayload<AccountChange> {
  const { user } = options
  return envelope(options.wabaId, 'smb_message_echoes', {
    messaging_product: 'whatsapp',
    metadata: metadata(options),
    contacts: [contactOf(user)],
    message_echoes: [
      {
        // The business number, digits only like everywhere in a webhook.
        from: toWebhookDisplayNumber(options.displayPhoneNumber),
        ...(user.phoneShared ? { to: user.waId } : {}),
        to_user_id: user.userId,
        id: options.messageId,
        timestamp: toMetaTimestamp(options.timestampMs),
        type: 'text',
        text: { body: options.text },
      },
    ],
  })
}

export interface HistoryMessage {
  /** Who wrote it: the customer (`in`) or the business (`out`). */
  direction: 'in' | 'out'
  text: string
  atMs: number
  id: string
}

export interface HistoryThread {
  user: UserIdentity
  messages: HistoryMessage[]
}

/**
 * One `history` chunk. `threads[].id` is the customer's phone number, and
 * `to` appears only on the business's own messages. Every message is text
 * here: wamock does not emulate media placeholders or the follow-up media
 * webhooks.
 */
export function buildHistoryPayload(
  options: NumberContext & {
    phase: 0 | 1 | 2
    chunkOrder: number
    progress: number
    threads: HistoryThread[]
  },
): WebhookPayload<AccountChange> {
  return envelope(options.wabaId, 'history', {
    messaging_product: 'whatsapp',
    metadata: metadata(options),
    history: [
      {
        metadata: { phase: options.phase, chunk_order: options.chunkOrder, progress: options.progress },
        threads: options.threads.map(({ user, messages }) => ({
          ...(user.phoneShared ? { id: user.waId } : {}),
          context: {
            ...(user.phoneShared ? { wa_id: user.waId } : {}),
            user_id: user.userId,
            ...(user.username !== undefined ? { username: user.username } : {}),
          },
          messages: messages.map((message) =>
            message.direction === 'in'
              ? {
                  ...(user.phoneShared ? { from: user.waId } : {}),
                  from_user_id: user.userId,
                  id: message.id,
                  timestamp: toMetaTimestamp(message.atMs),
                  type: 'text',
                  text: { body: message.text },
                  history_context: { status: 'READ' },
                }
              : {
                  from: toWebhookDisplayNumber(options.displayPhoneNumber),
                  ...(user.phoneShared ? { to: user.waId } : {}),
                  id: message.id,
                  timestamp: toMetaTimestamp(message.atMs),
                  type: 'text',
                  text: { body: message.text },
                  history_context: { status: 'READ' },
                },
          ),
        })),
      },
    ],
  })
}

/** The `history` webhook when the business declined to share its chat history. */
export function buildHistoryDeclinedPayload(options: NumberContext): WebhookPayload<AccountChange> {
  const title = 'History sync is turned off by the business from the WhatsApp Business App'
  return envelope(options.wabaId, 'history', {
    messaging_product: 'whatsapp',
    metadata: metadata(options),
    history: [
      {
        errors: [
          {
            code: 2593109,
            title,
            message: title,
            error_data: { details: 'History sharing is turned off by the business' },
          },
        ],
      },
    ],
  })
}
