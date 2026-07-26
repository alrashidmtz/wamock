import type { MockContext } from '../core/context.js'
import type { ConversationCategory } from '../core/conversations.js'
import { assertToken, requirePhoneNumber } from '../core/guards.js'
import { makeWamid } from '../core/ids.js'
import { TIER_CAPS } from '../core/limits.js'
import { normalizeWaId } from '../core/phone.js'
import { ERROR_CODES, GraphError } from '../errors/graph-error.js'
import { buildInboundPayload } from '../webhooks/payloads.js'
import type { InboundContent } from '../webhooks/payloads.js'
import { validateInteractive } from './interactive.js'
import type { TemplateService } from './template-service.js'

/**
 * Sending messages, simulating inbound ones, and the delivery statuses that
 * follow — the core of what wamock emulates.
 */

/** How long after acceptance each delivery status fires, in virtual ms. */
const STATUS_DELAYS = { sent: 50, delivered: 500 } as const

/** Message types accepted in v1. */
const SUPPORTED_TYPES = new Set(['text', 'template', 'interactive'])

/**
 * Types that require an open 24h service window. Templates are exempt — being
 * the only way out of a closed window is what templates are for.
 */
const REQUIRES_OPEN_WINDOW = new Set(['text', 'interactive'])

export interface SendMessageResponse {
  messaging_product: 'whatsapp'
  contacts: Array<{ input: string; wa_id: string }>
  messages: Array<{ id: string; message_status: string }>
}

export interface SimulateInboundOptions {
  from: string
  phoneNumberId?: string
  contactName?: string
  message: InboundContent
}

export class MessagingService {
  readonly #context: MockContext
  /** Template lookups on the send path; the two services collaborate, not merge. */
  readonly #templates: TemplateService

  constructor(context: MockContext, templates: TemplateService) {
    this.#context = context
    this.#templates = templates
  }

  /** `POST /{version}/{phone_number_id}/messages`. */
  send(
    phoneNumberId: string,
    body: Record<string, unknown>,
    accessToken?: string,
  ): SendMessageResponse {
    const { clock, state, scenario, windows, limits } = this.#context

    assertToken(this.#context, accessToken)
    const phoneNumber = requirePhoneNumber(this.#context, phoneNumberId)

    const { type, rawTo } = this.#validateEnvelope(body)
    this.#validateTypePayload(type, body)

    // A well-formed request to an unreachable number is 131026, NOT 100. The
    // distinction tells an integration "fix your code" from "drop this
    // contact", and integrations really do branch on it.
    const waId = normalizeWaId(rawTo)
    if (!waId) throw new GraphError(ERROR_CODES.UNDELIVERABLE)

    if (REQUIRES_OPEN_WINDOW.has(type) && !windows.isOpen(phoneNumberId, waId, clock.now())) {
      throw new GraphError(ERROR_CODES.REENGAGEMENT)
    }

    // Resolved before any failure can short-circuit: the category comes from
    // the template being sent, and it decides how the conversation is billed.
    const category: ConversationCategory =
      type === 'template'
        ? this.#templates.assertSendable(
            phoneNumber.wabaId,
            body['template'] as Record<string, unknown>,
          )
        : 'service'

    // Tiers cap UNIQUE recipients per 24h, not messages: a business can send
    // thousands to known contacts and still be blocked by one new one.
    const tier = phoneNumber.messagingTier ?? 'TIER_UNLIMITED'
    if (!limits.allows(phoneNumberId, waId, tier, clock.now())) {
      throw new GraphError(ERROR_CODES.SPAM_RATE_LIMIT, {
        details: `This phone number has reached its messaging limit of ${TIER_CAPS[tier]} unique recipients in 24 hours (${tier}).`,
      })
    }

    // A deliberately forced error wins over the random rate: a scenario you
    // asked for must not be overridden by chance.
    const forced = scenario.takeForcedError()
    if (forced !== undefined) throw new GraphError(forced)
    if (scenario.shouldFailSend()) throw new GraphError(ERROR_CODES.INTERNAL)

    limits.record(phoneNumberId, waId, clock.now())

    const wamid = makeWamid(phoneNumberId, state.nextSeq())
    const { messaging_product: _mp, to: _to, type: _t, ...rest } = body

    state.recordOutbound({
      id: wamid,
      phoneNumberId,
      to: waId,
      type,
      payload: rest,
      sentAt: clock.now(),
    })

    // The other failure axis: the send is accepted and the app is told so, but
    // the webhooks never arrive. Silent, and the expensive one in production.
    if (!scenario.shouldDropWebhook()) {
      this.#scheduleStatuses(phoneNumberId, wamid, waId, category)
    }

    return {
      messaging_product: 'whatsapp',
      contacts: [{ input: rawTo, wa_id: waId }],
      messages: [{ id: wamid, message_status: 'accepted' }],
    }
  }

  /**
   * Deliver an inbound message webhook, as if a customer had written. Returns
   * the generated wamid so callers can correlate.
   */
  simulateInbound(options: SimulateInboundOptions): { messageId: string } {
    const { clock, state, windows, dispatcher } = this.#context

    const phoneNumberId = options.phoneNumberId ?? state.defaultPhoneNumberId
    const phoneNumber = state.phoneNumber(phoneNumberId)
    if (!phoneNumber) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Object with ID '${phoneNumberId}' does not exist`,
      })
    }

    const waId = normalizeWaId(options.from)
    if (!waId) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `'${options.from}' is not a valid phone number`,
      })
    }

    // The customer writing is the ONLY thing that opens or renews the window.
    windows.recordInbound(phoneNumberId, waId, clock.now())

    const messageId = makeWamid(phoneNumberId, state.nextSeq())
    dispatcher.dispatch(
      phoneNumberId,
      buildInboundPayload({
        wabaId: phoneNumber.wabaId,
        phoneNumberId,
        displayPhoneNumber: phoneNumber.displayPhoneNumber,
        from: waId,
        ...(options.contactName !== undefined ? { contactName: options.contactName } : {}),
        messageId,
        timestampMs: clock.now(),
        message: options.message,
      }),
    )

    return { messageId }
  }

  /**
   * Drive a message to a specific status on demand (spec §6.2) — the only way
   * to test a `read` receipt or a delivery failure, since neither happens on
   * its own.
   */
  forceStatus(
    messageId: string,
    status: 'sent' | 'delivered' | 'read' | 'failed',
    errorCode?: number,
  ): { success: true } {
    const { clock, state, dispatcher } = this.#context

    const message = state.outbound().find((candidate) => candidate.id === messageId)
    if (!message) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `No message with id '${messageId}' was sent through this mock`,
      })
    }

    dispatcher.dispatchStatus(message.phoneNumberId, {
      messageId,
      status,
      recipientId: message.to,
      timestampMs: clock.now(),
      ...(errorCode !== undefined ? { errorCode } : {}),
    })
    return { success: true }
  }

  // --- internals ----------------------------------------------------------

  #validateEnvelope(body: Record<string, unknown>): { type: string; rawTo: string } {
    if (body['messaging_product'] !== 'whatsapp') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: "Param messaging_product must be 'whatsapp'",
      })
    }

    const rawTo = body['to']
    if (typeof rawTo !== 'string' || rawTo.trim() === '') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param to is required' })
    }

    const type = typeof body['type'] === 'string' ? body['type'] : 'text'
    if (!SUPPORTED_TYPES.has(type)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Param type must be one of {${[...SUPPORTED_TYPES].join(', ')}}`,
      })
    }

    return { type, rawTo }
  }

  #validateTypePayload(type: string, body: Record<string, unknown>): void {
    if (type === 'text') {
      const text = body['text'] as { body?: unknown } | undefined
      if (typeof text?.body !== 'string' || text.body === '') {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: 'Param text[body] is required for type text',
        })
      }
      return
    }

    if (type === 'interactive') {
      validateInteractive(body['interactive'])
      return
    }

    if (type === 'template') {
      const template = body['template'] as
        | { name?: unknown; language?: { code?: unknown } }
        | undefined
      if (typeof template?.name !== 'string') {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: 'Param template[name] is required for type template',
        })
      }
      if (typeof template.language?.code !== 'string') {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: 'Param template[language][code] is required for type template',
        })
      }
    }
  }

  #scheduleStatuses(
    phoneNumberId: string,
    wamid: string,
    recipientId: string,
    category: ConversationCategory,
  ): void {
    const { clock, scenario, conversations, dispatcher } = this.#context

    const conversation = conversations.open(phoneNumberId, recipientId, { category }, clock.now())

    // Out-of-order swaps the DELIVERY TIMES, not the labels: `delivered`
    // genuinely arrives first, which is what a receiver sees in production and
    // what breaks state machines that assume monotonic progress.
    const order = scenario.config.outOfOrderStatuses
      ? ([
          ['sent', STATUS_DELAYS.delivered],
          ['delivered', STATUS_DELAYS.sent],
        ] as const)
      : ([
          ['sent', STATUS_DELAYS.sent],
          ['delivered', STATUS_DELAYS.delivered],
        ] as const)

    for (const [status, delay] of order) {
      const at = clock.now() + delay + scenario.latency()
      dispatcher.dispatchStatus(phoneNumberId, {
        messageId: wamid,
        status,
        recipientId,
        timestampMs: at,
        conversation: conversations.toWebhookConversation(conversation),
        pricing: conversations.toWebhookPricing(conversation),
        atMs: at,
      })
    }
  }
}
