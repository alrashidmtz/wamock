import { normalizeWaId, toDisplayPhoneNumber } from '../core/phone.js'

/**
 * Webhook body builders — the mock speaking as Meta.
 *
 * Two quirks are reproduced on purpose here, because both break naive
 * receivers and neither is visible without real traffic:
 *
 * 1. **Delivery receipts arrive with no `messages` key at all.** Parsers that
 *    do `value.messages.forEach(...)` crash on every status callback.
 * 2. **Customer numbers carry no `+`, business numbers do.** See core/phone.ts.
 */

export interface WebhookMetadata {
  display_phone_number: string
  phone_number_id: string
}

export interface InboundMessageBody {
  from: string
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
  recipient_id: string
  conversation?: Record<string, unknown>
  pricing?: Record<string, unknown>
  errors?: Array<{ code: number; title: string; message: string }>
}

export interface ChangeValue {
  messaging_product: 'whatsapp'
  metadata: WebhookMetadata
  contacts?: Array<{ profile?: { name: string }; wa_id: string }>
  messages?: InboundMessageBody[]
  statuses?: StatusBody[]
}

export interface WebhookPayload {
  object: 'whatsapp_business_account'
  entry: Array<{ id: string; changes: Array<{ field: 'messages'; value: ChangeValue }> }>
}

interface Context {
  wabaId: string
  phoneNumberId: string
  /** Digits only; rendered with `+`. */
  displayPhoneNumber: string
}

/** Meta timestamps are unix SECONDS, as a string. */
const toMetaTimestamp = (ms: number): string => String(Math.floor(ms / 1000))

const envelope = (wabaId: string, value: ChangeValue): WebhookPayload => ({
  object: 'whatsapp_business_account',
  entry: [{ id: wabaId, changes: [{ field: 'messages', value }] }],
})

const metadata = (ctx: Context): WebhookMetadata => ({
  display_phone_number: toDisplayPhoneNumber(ctx.displayPhoneNumber),
  phone_number_id: ctx.phoneNumberId,
})

/** The type-specific content of an inbound message, minus the envelope fields. */
export type InboundContent = { type: string } & Record<string, unknown>

/** Envelope fields the mock owns; message content may never set them. */
const RESERVED_MESSAGE_KEYS = new Set(['from', 'id', 'timestamp', 'type'])

const stripReserved = (content: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(content).filter(([key]) => !RESERVED_MESSAGE_KEYS.has(key)))

export interface InboundOptions extends Context {
  /** Customer number in any format; normalized to `wa_id` form. */
  from: string
  contactName?: string
  messageId: string
  timestampMs: number
  message: InboundContent
}

export function buildInboundPayload(options: InboundOptions): WebhookPayload {
  const waId = normalizeWaId(options.from) ?? options.from.replace(/\D/g, '')
  const { type, ...content } = options.message

  return envelope(options.wabaId, {
    messaging_product: 'whatsapp',
    metadata: metadata(options),
    contacts: [
      {
        ...(options.contactName !== undefined ? { profile: { name: options.contactName } } : {}),
        wa_id: waId,
      },
    ],
    messages: [
      {
        from: waId,
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

export interface StatusOptions extends Context {
  messageId: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  recipientId: string
  timestampMs: number
  /** Present only on `failed`. Resolved to Meta's title/message text. */
  errorCode?: number
  conversation?: Record<string, unknown>
  pricing?: Record<string, unknown>
}

export function buildStatusPayload(options: StatusOptions): WebhookPayload {
  const recipient = normalizeWaId(options.recipientId) ?? options.recipientId.replace(/\D/g, '')

  const status: StatusBody = {
    id: options.messageId,
    status: options.status,
    timestamp: toMetaTimestamp(options.timestampMs),
    recipient_id: recipient,
    ...(options.conversation ? { conversation: options.conversation } : {}),
    ...(options.pricing ? { pricing: options.pricing } : {}),
    ...(options.errorCode !== undefined ? { errors: [statusError(options.errorCode)] } : {}),
  }

  // No `messages` key. Not an empty array — absent, exactly like Meta.
  return envelope(options.wabaId, {
    messaging_product: 'whatsapp',
    metadata: metadata(options),
    statuses: [status],
  })
}

/**
 * Status errors use a short `title` rather than the full Graph envelope. Kept
 * local to the webhook layer since the wording differs from the send-time
 * error catalogue.
 */
const STATUS_ERROR_TITLES: Record<number, string> = {
  131026: 'Message undeliverable',
  131047: 'Re-engagement message',
  131048: 'Spam rate limit hit',
  131049: 'This message was not delivered to maintain healthy ecosystem engagement.',
  130429: 'Rate limit hit',
  132015: 'Template is paused',
  131000: 'Something went wrong',
}

function statusError(code: number): { code: number; title: string; message: string } {
  const title = STATUS_ERROR_TITLES[code] ?? 'Message failed to send'
  return { code, title, message: title }
}
