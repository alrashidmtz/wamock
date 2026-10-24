import type { Business } from './types.js'

/**
 * Per-message pricing (PMP).
 *
 * WhatsApp bills each delivered **message**, not each conversation. That has
 * been true since 2025-07-01, and the `pricing` object on status webhooks says
 * so with `pricing_model: "PMP"`. Integrations still counting 24-hour
 * conversations under-report cost, and integrations reading
 * `conversation.id` find nothing: from Graph v24.0 the `conversation` object
 * is omitted unless the message went out inside a free entry point window.
 *
 * Since 2026-10-01 service messages are no longer free without limit: each
 * business phone number gets 1,000 free service deliveries per month, and the
 * 1,001st is `type: "regular"`, billable. Utility templates sent inside an open
 * customer service window, free from July 2025, are `regular` too.
 *
 * ## Fidelity note
 *
 * Modeled from Meta's documentation (status webhook reference and pricing
 * page), not captured from production traffic. Two simplifications:
 *
 * - Meta resets the free tier at midnight in the Messaging account's timezone.
 *   wamock has no account timezone and resets at midnight UTC.
 * - Meta counts *delivered* service messages. wamock counts at send time:
 *   every accepted send is delivered unless a test forces otherwise, and the
 *   count must not depend on whether a webhook reached the receiver.
 */

import { createHash } from 'node:crypto'

/** Free 1:1 service deliveries per business phone number per month. */
export const FREE_SERVICE_MESSAGES_PER_MONTH = 1_000

/**
 * Pricing categories wamock produces. `service` is a non-template message;
 * the others are named after the template category that was sent, with
 * `authentication_international` for an authentication template billed at
 * that rate. Meta spells it with an underscore in the pricing page's payload
 * example and in the status reference's conversation categories, and with a
 * hyphen in that reference's list of pricing categories; wamock follows the
 * payload example.
 */
export type PricingCategory = 'service' | 'utility' | 'marketing' | 'authentication' | 'authentication_international'

/**
 * Markets with an authentication-international rate, by ISO country, and
 * the day each launched (Meta's "Authentication-international rates" page;
 * the last nine on October 1, 2026). Kazakhstan shares +7 with Russia, which
 * wamock's calling-code table maps to Russia, so a Kazakh user is not told
 * apart.
 */
export const AUTH_INTERNATIONAL_MARKETS: Readonly<Record<string, number>> = {
  ID: Date.UTC(2024, 5, 1),
  IN: Date.UTC(2024, 6, 1),
  EG: Date.UTC(2025, 1, 1),
  MY: Date.UTC(2025, 1, 1),
  NG: Date.UTC(2025, 1, 1),
  PK: Date.UTC(2025, 1, 1),
  SA: Date.UTC(2025, 1, 1),
  ZA: Date.UTC(2025, 1, 1),
  AE: Date.UTC(2025, 1, 1),
  BD: Date.UTC(2026, 9, 1),
  IQ: Date.UTC(2026, 9, 1),
  KZ: Date.UTC(2026, 9, 1),
  KW: Date.UTC(2026, 9, 1),
  MA: Date.UTC(2026, 9, 1),
  NP: Date.UTC(2026, 9, 1),
  OM: Date.UTC(2026, 9, 1),
  LK: Date.UTC(2026, 9, 1),
  UA: Date.UTC(2026, 9, 1),
}

/**
 * Whether an authentication template to a user in `country` is billed the
 * authentication-international rate: the market has the rate by now, the
 * business is eligible and past its start time for that country, and the
 * user is not in the country the business is based in ("You will always be
 * charged the domestic rate for your primary business location").
 */
export function isAuthInternational(business: Business | undefined, country: string, nowMs: number): boolean {
  const launch = AUTH_INTERNATIONAL_MARKETS[country]
  const eligibility = business?.authInternational
  if (launch === undefined || nowMs < launch || !eligibility || business?.primaryLocation === country) return false
  const start = eligibility.exceptions.find((exception) => exception.country === country)?.startTime ?? eligibility.startTime
  return nowMs >= start
}

/** How long a free entry point window stays open after the reply that opens it. */
export const FREE_ENTRY_POINT_MS = 7 * 24 * 60 * 60 * 1000

/** An open free entry point window, as its `conversation` object needs it. */
export interface EntryPointWindow {
  /** Unique per window, shared by every message in it. */
  id: string
  expiresAt: number
}

/** Calendar month in UTC, e.g. `2026-10`. */
const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7)

export class Pricing {
  #serviceUsed = new Map<string, number>()
  /** When each user last wrote in from a Click-to-WhatsApp ad, per business number. */
  #adEntries = new Map<string, number>()
  #entryPoints = new Map<string, EntryPointWindow>()

  /** A user wrote in from a Click-to-WhatsApp ad: their next reply can open a window. */
  noteAdEntry(phoneNumberId: string, waId: string, atMs: number): void {
    this.#adEntries.set(`${phoneNumberId}:${waId}`, atMs)
  }

  /**
   * The free entry point window this message falls in, opening one if it is
   * the business's reply to an ad inside the service window. Undefined for an
   * ordinary, priced message.
   *
   * Meta opens the window at the reply, not at the user's ad tap, and keeps it
   * for up to 7 days; it is shared by every Messaging account sending on that
   * number. Everything inside it is free, marketing included, and none of it
   * spends the monthly service tier.
   */
  entryPoint(
    phoneNumberId: string,
    waId: string,
    nowMs: number,
    service: { open: boolean; windowMs: number },
  ): { pricing: Record<string, unknown>; window: EntryPointWindow } | undefined {
    const key = `${phoneNumberId}:${waId}`
    const open = this.#entryPoints.get(key)
    if (open && nowMs < open.expiresAt) return { pricing: FREE_ENTRY_POINT, window: { ...open } }

    // Only a reply inside the service window that the ad opened counts.
    const adAt = this.#adEntries.get(key)
    if (adAt === undefined || !service.open || nowMs - adAt >= service.windowMs) return undefined

    this.#adEntries.delete(key)
    const window = {
      id: createHash('sha256').update(`${key}:${nowMs}`).digest('hex').slice(0, 32),
      expiresAt: nowMs + FREE_ENTRY_POINT_MS,
    }
    this.#entryPoints.set(key, window)
    return { pricing: FREE_ENTRY_POINT, window: { ...window } }
  }

  /**
   * Price one message and count it against the number's free tier. Call it
   * exactly once per accepted send: pricing again would spend the tier twice.
   */
  price(phoneNumberId: string, category: PricingCategory, nowMs: number): Record<string, unknown> {
    if (category !== 'service') return pricingObject('regular', category)

    const key = `${phoneNumberId}:${monthOf(nowMs)}`
    const used = this.#serviceUsed.get(key) ?? 0
    this.#serviceUsed.set(key, used + 1)
    return pricingObject(
      used < FREE_SERVICE_MESSAGES_PER_MONTH ? 'free_customer_service' : 'regular',
      category,
    )
  }

  clear(): void {
    this.#serviceUsed = new Map()
    this.#adEntries = new Map()
    this.#entryPoints = new Map()
  }
}

const FREE_ENTRY_POINT = {
  billable: false,
  pricing_model: 'PMP',
  type: 'free_entry_point',
  category: 'referral_conversion',
}

function pricingObject(type: 'regular' | 'free_customer_service', category: PricingCategory) {
  return {
    // Meta marks `billable` for deprecation in favour of `type` + `category`,
    // but still sends it. Receivers that read it must keep working.
    billable: type === 'regular',
    pricing_model: 'PMP',
    type,
    category,
  }
}
