import { createHash } from 'node:crypto'

import { countryOf } from './phone.js'

/**
 * WhatsApp users as a business sees them: a business-scoped user ID (BSUID),
 * an optional username, and a phone number that is not always disclosed.
 *
 * Since April 2026 every `messages` webhook carries the user's BSUID in
 * `user_id`. A user who adopts a username stops disclosing their phone number
 * unless the business number has been in contact with that phone number in
 * the last 30 days, so `wa_id` and `from` can simply be missing. Integrations
 * that key customers on `wa_id` lose them silently; the BSUID is the one
 * identifier that is always there.
 *
 * ## Fidelity notes
 *
 * - Meta's BSUID is opaque. wamock derives one from the portfolio and phone
 *   number with a hash, so the same test produces the same BSUID every run,
 *   and a new phone number produces a new BSUID, as Meta's does.
 * - The country prefix comes from the calling code. `+1` maps to `US`, though
 *   it also covers Canada and the Caribbean. A code not in the table maps to
 *   `ZZ`, ISO's user-assigned "unknown", where Meta would know the country.
 * - Meta also discloses the phone number of a user in the business's contact
 *   book. wamock has no contact book, so only the 30-day contact rule applies.
 */

/** How long contact through a phone number keeps that number disclosed. */
export const PHONE_SHARING_MS = 30 * 24 * 60 * 60 * 1000

export interface UserProfile {
  name?: string
  username?: string
}

export class Users {
  #issued = new Map<string, { businessId: string; waId: string }>()
  #profiles = new Map<string, UserProfile>()
  #phoneContact = new Map<string, number>()
  #marketingStopped = new Set<string>()

  /** The BSUID of `waId` as seen by `businessId`. Deterministic. */
  bsuid(businessId: string, waId: string): string {
    const digest = createHash('sha256').update(`${businessId}:${waId}`).digest('hex')
    const digits = BigInt(`0x${digest}`).toString().slice(0, 20)
    const id = `${countryOf(waId)}.${digits}`
    this.#issued.set(id, { businessId, waId })
    return id
  }

  /** Which portfolio and customer a BSUID belongs to, if wamock issued it. */
  resolve(bsuid: string): { businessId: string; waId: string } | undefined {
    const issued = this.#issued.get(bsuid)
    return issued ? { ...issued } : undefined
  }

  /**
   * Update what the customer shows. An omitted field keeps its value, so a
   * username persists across messages; `null` removes it.
   */
  setProfile(waId: string, patch: { name?: string; username?: string | null }): void {
    const next: UserProfile = { ...this.#profiles.get(waId) }
    if (patch.name !== undefined) next.name = patch.name
    if (patch.username === null) delete next.username
    else if (patch.username !== undefined) next.username = patch.username
    this.#profiles.set(waId, next)
  }

  profile(waId: string): UserProfile {
    return { ...this.#profiles.get(waId) }
  }

  /** Note contact through the phone number itself, which keeps it disclosed. */
  recordPhoneContact(phoneNumberId: string, waId: string, atMs: number): void {
    this.#phoneContact.set(`${phoneNumberId}:${waId}`, atMs)
  }

  /**
   * Whether webhooks for this business number may carry the user's phone
   * number. Always, without a username; with one, only within 30 days of
   * contact through that phone number, judged per business number.
   */
  phoneShareable(phoneNumberId: string, waId: string, nowMs: number): boolean {
    if (this.#profiles.get(waId)?.username === undefined) return true
    const last = this.#phoneContact.get(`${phoneNumberId}:${waId}`)
    return last !== undefined && nowMs - last < PHONE_SHARING_MS
  }

  /**
   * Record a user's marketing preference for one business number. wamock
   * keeps it per number, where the user taps "Stop"; Meta's reference does
   * not say whether a stop reaches the portfolio's other numbers.
   */
  setMarketing(phoneNumberId: string, waId: string, value: 'stop' | 'resume'): void {
    const key = `${phoneNumberId}:${waId}`
    if (value === 'stop') this.#marketingStopped.add(key)
    else this.#marketingStopped.delete(key)
  }

  marketingStopped(phoneNumberId: string, waId: string): boolean {
    return this.#marketingStopped.has(`${phoneNumberId}:${waId}`)
  }

  clear(): void {
    this.#marketingStopped = new Set()
    this.#issued = new Map()
    this.#profiles = new Map()
    this.#phoneContact = new Map()
  }
}
