/** Shared domain types. Kept dependency-free so every layer can import them. */

/** A Meta app. Owns WABAs, and its secret signs their webhooks. */
export interface App {
  appId: string
  appSecret: string
}

/**
 * A business portfolio. Messaging limits are set here, not per number: every
 * number in the portfolio draws on one shared cap (since 2025-10-08).
 */
export interface Business {
  businessId: string
  messagingTier: MessagingTier
}

/** A WhatsApp Business Account. Belongs to exactly one app and one business portfolio. */
export interface Waba {
  wabaId: string
  appId: string
  businessId: string
  /**
   * Apps subscribed to this WABA's webhooks. Without a subscription Meta
   * delivers NOTHING for its numbers — no error, no warning, just silence.
   * That is the failure mode this field exists to reproduce (spec §9.3).
   */
  subscribedApps: Set<string>
}

/** Meta's quality ratings, worst to best. */
export type QualityRating = 'RED' | 'YELLOW' | 'GREEN'

/**
 * Messaging limits, counted in UNIQUE recipients reached outside a customer
 * service window per rolling 24h — not messages. `TIER_1` and `TIER_2` are
 * wamock additions so a cap can be hit in two sends.
 */
export const MESSAGING_TIERS = [
  'TIER_1',
  'TIER_2',
  'TIER_250',
  'TIER_2K',
  'TIER_10K',
  'TIER_100K',
  'TIER_UNLIMITED',
] as const

export type MessagingTier = (typeof MESSAGING_TIERS)[number]

/** A business phone number. Belongs to exactly one WABA. */
export interface PhoneNumber {
  phoneNumberId: string
  wabaId: string
  /** Digits only. Rendered with a `+` when it appears as `display_phone_number`. */
  displayPhoneNumber: string
  qualityRating?: QualityRating
}

/** A message a customer sent, kept so it can later be marked as read. */
export interface InboundRecord {
  id: string
  phoneNumberId: string
  /** Customer in `wa_id` form. */
  from: string
  receivedAt: number
}

/** A successful mark-as-read call. Not a message: nothing is sent or billed. */
export interface ReadReceipt {
  messageId: string
  phoneNumberId: string
  /** Whether the call also asked for a typing indicator. */
  typingIndicator: boolean
  at: number
}

/** Everything the app has successfully sent through the mock. */
export interface OutboundMessage {
  /** The wamid handed back to the sender. */
  id: string
  phoneNumberId: string
  /** Recipient in `wa_id` form: digits, no `+`, even when sent to a BSUID. */
  to: string
  /** The recipient's business-scoped user ID, however the message was addressed. */
  recipientUserId: string
  /** Whether the business addressed it with `to` or with `recipient`. */
  sentTo: 'phone' | 'user_id'
  type: string
  /** The type-specific slice of the request body (`text`, `template`, `interactive`, …). */
  payload: Record<string, unknown>
  /** Virtual time of acceptance. */
  sentAt: number
}
