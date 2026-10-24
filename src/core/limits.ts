import type { MessagingTier } from './types.js'

/**
 * Messaging limits.
 *
 * Two details trip people, and both are reproduced here:
 *
 * - A limit caps **unique recipients reached outside a customer service window
 *   per rolling 24 hours**, not messages. A business can send a thousand
 *   messages to fifty people on TIER_250 without issue, then get blocked by the
 *   fifty-first; replies to customers who wrote first never count at all. An
 *   integration that meters message volume sees nothing coming.
 * - Since 2025-10-08 the limit belongs to the **business portfolio** and is
 *   shared by all of its numbers, so one busy number can block its siblings.
 *   Counting per number reports headroom that does not exist.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000

/** Meta's published limits. `TIER_1`/`TIER_2` are wamock additions for cheap tests. */
export const TIER_CAPS: Record<MessagingTier, number> = {
  TIER_1: 1,
  TIER_2: 2,
  TIER_250: 250,
  TIER_2K: 2_000,
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
   * Whether this portfolio may reach `waId` outside a service window right
   * now. A recipient already reached inside the period is always allowed —
   * they are already counted.
   */
  allows(businessId: string, waId: string, tier: MessagingTier, nowMs: number): boolean {
    const recent = this.#recent(businessId, nowMs)
    if (recent.some((contact) => contact.waId === waId)) return true
    return recent.length < TIER_CAPS[tier]
  }

  record(businessId: string, waId: string, nowMs: number): void {
    const recent = this.#recent(businessId, nowMs)
    const existing = recent.find((contact) => contact.waId === waId)
    if (existing) {
      existing.atMs = nowMs
    } else {
      recent.push({ waId, atMs: nowMs })
    }
    this.#contacts.set(businessId, recent)
  }

  /** How many unique recipients this portfolio has reached in the last 24h. */
  used(businessId: string, nowMs: number): number {
    return this.#recent(businessId, nowMs).length
  }

  clear(): void {
    this.#contacts = new Map()
  }

  /** Prune as we read: entries older than the period no longer count. */
  #recent(businessId: string, nowMs: number): Contact[] {
    const all = this.#contacts.get(businessId) ?? []
    const recent = all.filter((contact) => nowMs - contact.atMs < WINDOW_MS)
    this.#contacts.set(businessId, recent)
    return recent
  }
}
