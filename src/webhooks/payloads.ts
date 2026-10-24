import { toWebhookDisplayNumber } from '../core/phone.js'
import { defaultDetails } from '../errors/graph-error.js'

/**
 * Webhook body builders — the mock speaking as Meta.
 *
 * Two quirks are reproduced on purpose here, because both break naive
 * receivers and neither is visible without real traffic:
 *
 * 1. **Delivery receipts arrive with no `messages` key at all.** Parsers that
 *    do `value.messages.forEach(...)` crash on every status callback.
 * 2. **Every number in a webhook is digits only**, the business's own
 *    included, while the Graph API formats the business number. See core/phone.ts.
 */

export interface WebhookMetadata {
  display_phone_number: string
  phone_number_id: string
}

export interface InboundMessageBody {
  /** Absent when the user has a username and the phone number cannot be shared. */
  from?: string
  /** The user's business-scoped user ID. Always present since April 2026. */
  from_user_id?: string
  id: string
  timestamp: string
  type: string
  text?: { body: string }
  interactive?: Record<string, unknown>
  [key: string]: unknown
}

export interface StatusBody {
  id: string
  status: string
  timestamp: string
  /** Absent for a BSUID send whose recipient's phone number cannot be shared. */
  recipient_id?: string
  recipient_user_id?: string
  /** Echoed from the send, on every status, when it carried one. */
  biz_opaque_callback_data?: string
  conversation?: Record<string, unknown>
  pricing?: Record<string, unknown>
  errors?: StatusError[]
}

/** A user as a webhook describes them. Every field but `user_id` can be absent. */
export interface WebhookContact {
  profile?: { name?: string; username?: string }
  wa_id?: string
  user_id: string
}

/**
 * Who a webhook is about, as the engine knows them. `phoneShared` decides
 * whether the phone number may appear at all.
 */
export interface UserIdentity {
  /** Digits only, no `+`. Always known to the mock, not always disclosed. */
  waId: string
  userId: string
  phoneShared: boolean
  name?: string
  username?: string
}

const contactOf = (user: UserIdentity, options: { withUsername: boolean; withPhone: boolean }): WebhookContact => {
  const profile = {
    ...(user.name !== undefined ? { name: user.name } : {}),
    ...(options.withUsername && user.username !== undefined ? { username: user.username } : {}),
  }
  return {
    ...(Object.keys(profile).length > 0 ? { profile } : {}),
    ...(options.withPhone ? { wa_id: user.waId } : {}),
    user_id: user.userId,
  }
}

export interface ChangeValue {
  messaging_product: 'whatsapp'
  metadata: WebhookMetadata
  contacts?: WebhookContact[]
  messages?: InboundMessageBody[]
  statuses?: StatusBody[]
}

/** The `messages` field: inbound messages and delivery statuses. */
export interface MessagesChange {
  field: 'messages'
  value: ChangeValue
}

/**
 * Every other field. Their values share no shape with `messages` or with each
 * other, so each builder owns its own and the union only promises the name.
 */
export interface AccountChange {
  field:
    | 'message_template_status_update'
    | 'business_capability_update'
    | 'template_category_update'
    | 'user_preferences'
    | 'account_update'
    | 'history'
    | 'smb_app_state_sync'
    | 'smb_message_echoes'
  value: Record<string, unknown>
}

export type WebhookChange = MessagesChange | AccountChange

/**
 * Meta's webhook envelope. Builders return the narrow form for their field, so
 * callers that know what they built read its value without casting.
 */
export interface WebhookPayload<C extends WebhookChange = WebhookChange> {
  object: 'whatsapp_business_account'
  entry: Array<{
    id: string
    /** Unix seconds. Meta sends it on account-level fields; `messages` carries none. */
    time?: number
    changes: C[]
  }>
}

interface Context {
  wabaId: string
  phoneNumberId: string
  /** Digits only, as every webhook carries it. */
  displayPhoneNumber: string
}

/** Meta timestamps are unix SECONDS, as a string. */
const toMetaTimestamp = (ms: number): string => String(Math.floor(ms / 1000))

const envelope = (wabaId: string, value: ChangeValue): WebhookPayload<MessagesChange> => ({
  object: 'whatsapp_business_account',
  entry: [{ id: wabaId, changes: [{ field: 'messages', value }] }],
})

const metadata = (ctx: Context): WebhookMetadata => ({
  display_phone_number: toWebhookDisplayNumber(ctx.displayPhoneNumber),
  phone_number_id: ctx.phoneNumberId,
})

/** The type-specific content of an inbound message, minus the envelope fields. */
export type InboundContent = { type: string } & Record<string, unknown>

/** Envelope fields the mock owns; message content may never set them. */
const RESERVED_MESSAGE_KEYS = new Set(['from', 'from_user_id', 'id', 'timestamp', 'type'])

const stripReserved = (content: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(content).filter(([key]) => !RESERVED_MESSAGE_KEYS.has(key)))

export interface InboundOptions extends Context {
  user: UserIdentity
  messageId: string
  timestampMs: number
  message: InboundContent
}

export function buildInboundPayload(options: InboundOptions): WebhookPayload<MessagesChange> {
  const { user } = options
  const { type, ...content } = options.message

  return envelope(options.wabaId, {
    messaging_product: 'whatsapp',
    metadata: metadata(options),
    // A username always shows on an incoming message; the phone number only
    // when it may be shared.
    contacts: [contactOf(user, { withUsername: true, withPhone: user.phoneShared })],
    messages: [
      {
        ...(user.phoneShared ? { from: user.waId } : {}),
        from_user_id: user.userId,
        id: options.messageId,
        timestamp: toMetaTimestamp(options.timestampMs),
        type,
        // Reserved keys are stripped rather than relying on spread order.
        // Meta emits the envelope fields first, so they stay first for
        // fidelity — but that means `content` spreads LAST and could override
        // `from` or `id`. Nothing feeds it unfiltered input today; this makes
        // sure a future change that does cannot break the envelope silently.
        ...stripReserved(content),
      },
    ],
  })
}

/**
 * The statuses Meta's status webhook carries. `played` is the first play of a
 * voice message, sent since March 17, 2026.
 */
export const MESSAGE_STATUSES = ['sent', 'delivered', 'read', 'played', 'failed'] as const
export type MessageStatus = (typeof MESSAGE_STATUSES)[number]

const STATUSES_WITH_CONTACTS: ReadonlySet<MessageStatus> = new Set(['sent', 'delivered', 'read'])

export interface StatusOptions extends Context {
  messageId: string
  status: MessageStatus
  user: UserIdentity
  /** How the business addressed the message: `to` or `recipient`. */
  sentTo: 'phone' | 'user_id'
  timestampMs: number
  /** Present only on `failed`. Resolved to Meta's title/message text. */
  errorCode?: number
  /** Only for a message inside a free entry point window, since v24.0. */
  conversation?: Record<string, unknown>
  pricing?: Record<string, unknown>
  bizOpaqueCallbackData?: string
}

/**
 * A status, identifying the recipient as Meta does since April 2026:
 *
 * - `recipient_user_id` always, except on a `failed` status for a message
 *   sent to a phone number.
 * - `recipient_id` when the message went to a phone number, or when the
 *   recipient's phone number may be shared.
 * - A `contacts` array on `sent`, `delivered` and `read`, never on `failed`
 *   or `played`.
 *   Its `wa_id` follows the same rule as `recipient_id`, and the username
 *   appears on `delivered` and `read` only.
 */
export function buildStatusPayload(options: StatusOptions): WebhookPayload<MessagesChange> {
  const { user, sentTo } = options
  const failed = options.status === 'failed'
  const withPhone = sentTo === 'phone' || user.phoneShared

  const status: StatusBody = {
    id: options.messageId,
    status: options.status,
    timestamp: toMetaTimestamp(options.timestampMs),
    ...(withPhone ? { recipient_id: user.waId } : {}),
    ...(failed && sentTo === 'phone' ? {} : { recipient_user_id: user.userId }),
    ...(options.bizOpaqueCallbackData !== undefined
      ? { biz_opaque_callback_data: options.bizOpaqueCallbackData }
      : {}),
    ...(options.conversation ? { conversation: options.conversation } : {}),
    ...(options.pricing ? { pricing: options.pricing } : {}),
    // `errors` describes a failure to send or deliver: a `failed` status only.
    ...(failed && options.errorCode !== undefined ? { errors: [statusError(options.errorCode)] } : {}),
  }

  // No `messages` key. Not an empty array — absent, exactly like Meta.
  return envelope(options.wabaId, {
    messaging_product: 'whatsapp',
    metadata: metadata(options),
    // Meta's BSUID reference: `contacts` comes "only" with sent, delivered
    // and read, so not with failed nor with a voice message's played.
    ...(STATUSES_WITH_CONTACTS.has(options.status)
      ? { contacts: [contactOf(user, { withUsername: options.status !== 'sent', withPhone })] }
      : {}),
    statuses: [status],
  })
}

/**
 * `user_preferences` — a user stopped or resumed marketing messages. The only
 * signal a business gets: sends are still accepted afterwards, and fail on
 * their status with 131050.
 */
export function buildUserPreferencePayload(
  options: Context & { user: UserIdentity; value: 'stop' | 'resume'; timestampMs: number },
): WebhookPayload<AccountChange> {
  const { user } = options
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: options.wabaId,
        changes: [
          {
            field: 'user_preferences',
            value: {
              messaging_product: 'whatsapp',
              metadata: metadata(options),
              contacts: [contactOf(user, { withUsername: true, withPhone: user.phoneShared })],
              user_preferences: [
                {
                  ...(user.phoneShared ? { wa_id: user.waId } : {}),
                  user_id: user.userId,
                  detail: `User requested to ${options.value} marketing messages`,
                  category: 'marketing_messages',
                  value: options.value,
                  // An integer here, unlike the string timestamps on messages.
                  timestamp: Math.floor(options.timestampMs / 1000),
                },
              ],
            },
          },
        ],
      },
    ],
  }
}

export interface NumberChangeOptions extends Context {
  messageId: string
  timestampMs: number
  /** The user before the change. */
  previous: UserIdentity
  /** The user after it. `phoneShared` picks which system message Meta sends. */
  current: UserIdentity
}

/**
 * A user changed their phone number, which regenerates their BSUID. There is
 * no `user_id_update` field: it arrives on `messages` as a `system` message,
 * `user_changed_number` when the new number may be shared and
 * `user_changed_user_id`, with no phone number anywhere, when it may not.
 * Neither carries a `contacts` array.
 */
export function buildNumberChangePayload(options: NumberChangeOptions): WebhookPayload<MessagesChange> {
  const { previous, current } = options
  const system = current.phoneShared
    ? {
        // Meta names the user when it knows their name: "User Sheena Nelson
        // changed from …". Without one wamock drops the name, not the sentence.
        body: `User ${current.name !== undefined ? `${current.name} ` : ''}changed from ${previous.waId} to ${current.waId}`,
        wa_id: current.waId,
        type: 'user_changed_number',
        user_id: current.userId,
        previous_user_id: previous.userId,
      }
    : {
        body: `User changed from ${previous.userId} to ${current.userId}`,
        type: 'user_changed_user_id',
        user_id: current.userId,
        previous_user_id: previous.userId,
      }

  return envelope(options.wabaId, {
    messaging_product: 'whatsapp',
    metadata: metadata(options),
    messages: [
      {
        ...(current.phoneShared ? { from: previous.waId } : {}),
        id: options.messageId,
        timestamp: toMetaTimestamp(options.timestampMs),
        system,
        type: 'system',
      },
    ],
  })
}

/**
 * The error object on a `failed` status. `title` and `message` are the same
 * short string; the explanation lives in `error_data.details`, and `href`
 * points at Meta's error code page. Receivers that read only `message` log the
 * least useful of the three.
 */
export interface StatusError {
  code: number
  title: string
  message: string
  error_data: { details: string }
  href: string
}

/** As Meta sends it: a path, not an absolute URL. */
const ERROR_CODES_HREF = '/documentation/business-messaging/whatsapp/support/error-codes'

/**
 * Status titles are short labels, not the Graph send-time message. Kept local
 * to the webhook layer since the wording differs from the error catalogue.
 */
const STATUS_ERROR_TITLES: Record<number, string> = {
  131026: 'Message undeliverable',
  131047: 'Re-engagement message',
  131048: 'Spam rate limit hit',
  131049: 'This message was not delivered to maintain healthy ecosystem engagement.',
  // Meta's error code reference gives this sentence and no shorter title.
  131050:
    'Unable to deliver the message. This recipient has chosen to stop receiving marketing messages on WhatsApp from your business.',
  // Meta's error code reference gives this sentence and no shorter title.
  131053: 'Unable to upload the media used in the message.',
  // Meta's error code reference gives this sentence and no shorter title.
  130403: 'Unable to deliver the message. This business has blocked the end user on WhatsApp',
  130429: 'Rate limit hit',
  132015: 'Template is paused',
  131000: 'Something went wrong',
}

/**
 * Details for codes that only ever arrive on a status, so the Graph catalogue
 * has none. 131049 is Meta's own example, verbatim.
 */
const STATUS_ONLY_DETAILS: Record<number, string> = {
  131049: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
  // Meta's error code reference.
  131053: 'The media could not be uploaded for one or more reasons, such as an unsupported media type.',
}

function statusError(code: number): StatusError {
  const title = STATUS_ERROR_TITLES[code] ?? 'Message failed to send'
  return {
    code,
    title,
    message: title,
    error_data: { details: STATUS_ONLY_DETAILS[code] ?? defaultDetails(code) ?? title },
    href: ERROR_CODES_HREF,
  }
}
