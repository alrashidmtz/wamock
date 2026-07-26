/**
 * Conversations and pricing (spec §5.4).
 *
 * WhatsApp bills per **conversation**, not per message: one 24-hour window
 * between a business number and a customer is a single billable unit no matter
 * how many messages cross it. Integrations that count messages over-report
 * their costs — sometimes by an order of magnitude — and they cannot discover
 * that without the `conversation` and `pricing` objects Meta attaches to
 * delivery statuses.
 *
 * ## Fidelity note
 *
 * Unlike the rest of wamock, this is **modeled from Meta's public
 * documentation rather than captured from production traffic**: neither audited
 * integration consumed these fields, so there was no fixture to work from. The
 * shape and field names are faithful; treat the finer points of category
 * assignment as best-effort until corrected against a real capture.
 */

/** 24 hours — a conversation lasts exactly as long as the service window. */
const CONVERSATION_MS = 24 * 60 * 60 * 1000

/**
 * Meta's conversation categories. `service` is customer-initiated; the other
 * three are business-initiated and named after the template category that
 * opened them.
 */
export type ConversationCategory = 'service' | 'utility' | 'marketing' | 'authentication'

export interface Conversation {
  id: string
  category: ConversationCategory
  origin: { type: ConversationCategory }
  startedAt: number
  expiresAt: number
}

export interface OpenOptions {
  category: ConversationCategory
}

const key = (phoneNumberId: string, waId: string): string => `${phoneNumberId}:${waId}`

export class Conversations {
  #open = new Map<string, Conversation>()
  #seq = 0

  /**
   * Get the conversation this message belongs to, opening one only if none is
   * live. Reuse is the point: a new id per message would be exactly the
   * over-counting this data exists to prevent.
   */
  open(
    phoneNumberId: string,
    waId: string,
    options: OpenOptions,
    nowMs: number,
  ): Conversation {
    const mapKey = key(phoneNumberId, waId)
    const existing = this.#open.get(mapKey)
    if (existing && nowMs < existing.expiresAt) {
      // Category is fixed at open time. A conversation that started as utility
      // stays utility even if later messages are free-form.
      return existing
    }

    const conversation: Conversation = {
      id: `CONV_${++this.#seq}`,
      category: options.category,
      origin: { type: options.category },
      startedAt: nowMs,
      expiresAt: nowMs + CONVERSATION_MS,
    }
    this.#open.set(mapKey, conversation)
    return conversation
  }

  /** The `conversation` object as it appears on a status webhook. */
  toWebhookConversation(conversation: Conversation): Record<string, unknown> {
    return {
      id: conversation.id,
      expiration_timestamp: String(Math.floor(conversation.expiresAt / 1000)),
      origin: { type: conversation.origin.type },
    }
  }

  /** The `pricing` object as it appears on a status webhook. */
  toWebhookPricing(conversation: Conversation): Record<string, unknown> {
    return {
      billable: true,
      // Conversation-Based Pricing — what Meta reports for all four categories.
      pricing_model: 'CBP',
      category: conversation.category,
    }
  }

  count(): number {
    return this.#open.size
  }

  clear(): void {
    this.#open = new Map()
    this.#seq = 0
  }
}
