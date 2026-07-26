import type { MessagingTier } from './types.js'

/**
 * Messaging limits (spec §9.5).
 *
 * The detail that trips people: tiers cap **unique recipients per rolling
 * 24 hours**, not messages. A business can send a thousand messages to fifty
 * people on TIER_250 without issue, then get blocked by the fifty-first
 * contact. An integration that meters message volume sees nothing coming.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000

/** Meta's published tiers. `TIER_1`/`TIER_2` are wamock additions for cheap tests. */
export const TIER_CAPS: Record<MessagingTier, number> = {
  TIER_1: 1,
  TIER_2: 2,
  TIER_250: 250,
  TIER_1K: 1_000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
  TIER_UNLIMITED: Number.POSITIVE_INFINITY,
}

interface Contact {
  waId: string
  atMs: number
}

export class MessagingLimits {
  #contacts = new Map<string, Contact[]>()

  /**
   * Whether this number may start a conversation with `waId` right now.
   * A recipient already contacted inside the window is always allowed —
   * they are already counted.
   */
  allows(phoneNumberId: string, waId: string, tier: MessagingTier, nowMs: number): boolean {
    const recent = this.#recent(phoneNumberId, nowMs)
    if (recent.some((contact) => contact.waId === waId)) return true
    return recent.length < TIER_CAPS[tier]
  }

  record(phoneNumberId: string, waId: string, nowMs: number): void {
    const recent = this.#recent(phoneNumberId, nowMs)
    const existing = recent.find((contact) => contact.waId === waId)
    if (existing) {
      existing.atMs = nowMs
    } else {
      recent.push({ waId, atMs: nowMs })
    }
    this.#contacts.set(phoneNumberId, recent)
  }

  /** How many unique recipients this number has reached in the last 24h. */
  used(phoneNumberId: string, nowMs: number): number {
    return this.#recent(phoneNumberId, nowMs).length
  }

  clear(): void {
    this.#contacts = new Map()
  }

  /** Prune as we read: entries older than the window no longer count. */
  #recent(phoneNumberId: string, nowMs: number): Contact[] {
    const all = this.#contacts.get(phoneNumberId) ?? []
    const recent = all.filter((contact) => nowMs - contact.atMs < WINDOW_MS)
    this.#contacts.set(phoneNumberId, recent)
    return recent
  }
}
