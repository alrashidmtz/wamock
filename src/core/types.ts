/** Shared domain types. Kept dependency-free so every layer can import them. */

/** A Meta app. Owns WABAs, and its secret signs their webhooks. */
export interface App {
  appId: string
  appSecret: string
  /** What `debug_token` and `subscribed_apps` report as the app's name. */
  name?: string
}

/**
 * A business portfolio. Messaging limits are set here, not per number: every
 * number in the portfolio draws on one shared cap (since 2025-10-08).
 */
export interface Business {
  businessId: string
  messagingTier: MessagingTier
  /**
   * Set once Meta deems the portfolio eligible for authentication-
   * international rates: when they start (ms), and any per-country start.
   */
  authInternational?: { startTime: number; exceptions: Array<{ country: string; startTime: number }> }
  /** The country Meta determined the business is based in (ISO alpha-2). */
  primaryLocation?: string
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
  /**
   * Set by subscribing with `override_callback_uri`: this WABA's webhooks go
   * to that URL, verified with this token, instead of the app's callback.
   */
  callbackOverride?: { url: string; verifyToken: string }
}

/**
 * Meta's quality ratings. Meta contradicts itself on a number not rated yet:
 * the phone-number reference's enum says `NA`, its "Get all phone numbers"
 * example response shows `UNKNOWN`. wamock answers `UNKNOWN`, the spelling of
 * an actual response.
 */
export type QualityRating = 'RED' | 'YELLOW' | 'GREEN' | 'UNKNOWN'

/**
 * A number's `status`. Inferred: Meta's phone-number reference gives this enum
 * (WhatsAppBusinessAccountToNumberStatus) to the `connection_status` of a
 * status update, and lists no values for the `status` a read returns; wamock
 * serves the same values there. Meta does not document what each one does to
 * sends, so wamock only reports it.
 */
export const CONNECTION_STATUSES = [
  'CONNECTED',
  'DISCONNECTED',
  'PENDING',
  'FLAGGED',
  'RESTRICTED',
  'RATE_LIMITED',
  'MESSAGING_LIMIT_TIER_0',
  'MESSAGING_LIMIT_TIER_1',
  'MESSAGING_LIMIT_TIER_2',
  'MESSAGING_LIMIT_TIER_3',
  'MESSAGING_LIMIT_TIER_4',
] as const
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number]

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
  /**
   * Digits only. Webhooks carry it that way; the Graph API formats it
   * (`+1 555-000-1111`). See core/phone.ts.
   */
  displayPhoneNumber: string
  qualityRating?: QualityRating
  /** What `?fields=status` reads; `CONNECTED` when unset. */
  status?: ConnectionStatus
  /** The display name it was created with; wamock's default when unset. */
  verifiedName?: string
  /** `UNVERIFIED` until `verify_code` passes; verified when unset. */
  verification?: 'VERIFIED' | 'UNVERIFIED'
  /** False until `register` (or after `deregister`): it cannot send. Registered when unset. */
  registered?: boolean
  /** The two-step verification PIN the first `register` set. */
  pin?: string
  /**
   * When a throughput upgrade finishes: until then the number answers
   * 131057, and from then on its throughput is the higher one.
   */
  upgradedAt?: number
  /**
   * Set with `POST /{phone_number_id}` and `webhook_configuration`: this
   * number's webhooks go here, ahead of its WABA's override and the app's URL.
   */
  callbackOverride?: { url: string; verifyToken: string }
}

/** A message a customer sent, kept so it can later be marked as read. */
export interface InboundRecord {
  id: string
  phoneNumberId: string
  /** Customer in `wa_id` form. */
  from: string
  receivedAt: number
  /** The message type: a reaction cannot be the target of another one. */
  type?: string
  /** The message as delivered, for an edit to build on. */
  content?: Record<string, unknown>
  /** Revoked by the customer: nothing more can be done to it. */
  revoked?: boolean
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
  /** The send's `biz_opaque_callback_data`, echoed on every status. */
  bizOpaqueCallbackData?: string
  type: string
  /** The type-specific slice of the request body (`text`, `template`, `interactive`, …). */
  payload: Record<string, unknown>
  /** Virtual time of acceptance. */
  sentAt: number
}
