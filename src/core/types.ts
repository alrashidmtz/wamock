/** Shared domain types. Kept dependency-free so every layer can import them. */

/** A Meta app. Owns WABAs, and its secret signs their webhooks. */
export interface App {
  appId: string
  appSecret: string
}

/** A WhatsApp Business Account. Belongs to exactly one app. */
export interface Waba {
  wabaId: string
  appId: string
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
 * Messaging tiers, counted in UNIQUE recipients per rolling 24h — not
 * messages. Integrations that meter messages under-count and hit the cap
 * without warning.
 */
export type MessagingTier = 'TIER_1' | 'TIER_2' | 'TIER_250' | 'TIER_1K' | 'TIER_10K' | 'TIER_100K' | 'TIER_UNLIMITED'

/** A business phone number. Belongs to exactly one WABA. */
export interface PhoneNumber {
  phoneNumberId: string
  wabaId: string
  /** Digits only. Rendered with a `+` when it appears as `display_phone_number`. */
  displayPhoneNumber: string
  qualityRating?: QualityRating
  messagingTier?: MessagingTier
}

/** Everything the app has successfully sent through the mock. */
export interface OutboundMessage {
  /** The wamid handed back to the sender. */
  id: string
  phoneNumberId: string
  /** Recipient in `wa_id` form: digits, no `+`. */
  to: string
  type: string
  /** The type-specific slice of the request body (`text`, `template`, `interactive`, …). */
  payload: Record<string, unknown>
  /** Virtual time of acceptance. */
  sentAt: number
}
