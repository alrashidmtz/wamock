/**
 * The 24-hour customer service window.
 *
 * Outside it, only an approved template can reach a customer; a free-form text
 * fails with 131047. This is the single most common surprise in WhatsApp
 * integrations, and the reason the virtual clock exists at all — you cannot
 * test window expiry if testing it means waiting a day.
 *
 * ## Renewal policy
 *
 * wamock follows Meta: **any** inbound message from the customer renews the
 * window to a full 24 hours from that message. Not "extends by 24h from the
 * original", not "only certain message types" — any message, full reset.
 *
 * The alternative worth knowing about is a strict mode where the window never
 * renews, only opens once, which makes expiry tests shorter to write. It is
 * deliberately not the default: a mock that is stricter than production teaches
 * integrations to send templates they did not need, which costs real money per
 * conversation. If you want it, pass a shorter `windowMs` instead — that gets
 * you fast expiry without diverging from Meta's semantics.
 *
 * ## Scope
 *
 * A window belongs to a **conversation**: one business number talking to one
 * customer. Two customers on the same number have independent windows, and the
 * same customer reaching two of your numbers has two. Keying this globally is a
 * bug that only appears once a second number exists.
 */

/** 24 hours, in milliseconds. */
export const WINDOW_MS = 24 * 60 * 60 * 1000

export interface ServiceWindowOptions {
  /** Override the window length. Useful for exercising expiry cheaply. */
  windowMs?: number
}

const key = (phoneNumberId: string, waId: string): string => `${phoneNumberId}:${waId}`

export class ServiceWindows {
  readonly #windowMs: number
  #lastInbound = new Map<string, number>()

  constructor(options: ServiceWindowOptions = {}) {
    this.#windowMs = options.windowMs ?? WINDOW_MS
  }

  /** Note that the customer wrote, opening or renewing their window. */
  recordInbound(phoneNumberId: string, waId: string, atMs: number): void {
    this.#lastInbound.set(key(phoneNumberId, waId), atMs)
  }

  /**
   * Whether a free-form message is allowed right now. The boundary is
   * exclusive: at exactly 24h the window is already closed, matching Meta.
   */
  isOpen(phoneNumberId: string, waId: string, nowMs: number): boolean {
    const last = this.#lastInbound.get(key(phoneNumberId, waId))
    if (last === undefined) return false
    return nowMs - last < this.#windowMs
  }

  /** When this conversation's window closes, or undefined if it never opened. */
  expiresAt(phoneNumberId: string, waId: string): number | undefined {
    const last = this.#lastInbound.get(key(phoneNumberId, waId))
    return last === undefined ? undefined : last + this.#windowMs
  }

  clear(): void {
    this.#lastInbound = new Map()
  }
}
