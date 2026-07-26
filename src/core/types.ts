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
}

/** A business phone number. Belongs to exactly one WABA. */
export interface PhoneNumber {
  phoneNumberId: string
  wabaId: string
  /** Digits only. Rendered with a `+` when it appears as `display_phone_number`. */
  displayPhoneNumber: string
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
