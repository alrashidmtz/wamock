import type { MockContext } from '../core/context.js'
import type { EntryPointWindow, PricingCategory } from '../core/pricing.js'
import { assertToken, requirePhoneNumber } from '../core/guards.js'
import { userIdentity } from '../core/identity.js'
import { makeWamid } from '../core/ids.js'
import { TIER_CAPS } from '../core/limits.js'
import { normalizeWaId } from '../core/phone.js'
import { ERROR_CODES, GraphError } from '../errors/graph-error.js'
import {
  buildInboundPayload,
  buildNumberChangePayload,
  buildUserPreferencePayload,
} from '../webhooks/payloads.js'
import type { InboundContent, UserIdentity } from '../webhooks/payloads.js'
import { validateInteractive } from './interactive.js'
import type { CoexistenceService } from './coexistence-service.js'
import type { TemplateService } from './template-service.js'

/**
 * Sending messages, simulating inbound ones, and the delivery statuses that
 * follow — the core of what wamock emulates.
 */

/** How long after acceptance each delivery status fires, in virtual ms. */
const STATUS_DELAYS = { sent: 50, delivered: 500 } as const

/**
 * The recipient stopped marketing messages from this business. It only ever
 * arrives on a `failed` status, never as a send error, so it has no place in
 * the Graph error catalogue.
 */
const MARKETING_OPTED_OUT = 131050

/** Message types accepted in v1. */
const SUPPORTED_TYPES = new Set(['text', 'template', 'interactive'])

/**
 * Types that require an open 24h service window. Templates are exempt — being
 * the only way out of a closed window is what templates are for.
 */
const REQUIRES_OPEN_WINDOW = new Set(['text', 'interactive'])

export interface SendMessageResponse {
  messaging_product: 'whatsapp'
  /**
   * `wa_id` for a message sent to a phone number, `user_id` for one sent to a
   * BSUID. Never both: a request with both `to` and `recipient` is a
   * phone-number send.
   */
  contacts: Array<{ input: string; wa_id?: string; user_id?: string }>
  messages: Array<{ id: string; message_status: string }>
}

export interface SimulateInboundOptions {
  from: string
  phoneNumberId?: string
  contactName?: string
  /**
   * The user's username. Once set it sticks to the user, and their phone
   * number disappears from webhooks unless recently in contact. `null`
   * removes it.
   */
  username?: string | null
  message: InboundContent
}

export class MessagingService {
  readonly #context: MockContext
  /** Template lookups on the send path; the two services collaborate, not merge. */
  readonly #templates: TemplateService

  /** Coexistence numbers cap throughput and can be disconnected. */
  readonly #coexistence: CoexistenceService

  constructor(context: MockContext, templates: TemplateService, coexistence: CoexistenceService) {
    this.#context = context
    this.#templates = templates
    this.#coexistence = coexistence
  }

  /** `POST /{version}/{phone_number_id}/messages`. */
  send(
    phoneNumberId: string,
    body: Record<string, unknown>,
    accessToken?: string,
  ): SendMessageResponse {
    const { clock, state, scenario, windows, limits, users, dispatcher } = this.#context

    assertToken(this.#context, accessToken)
    const phoneNumber = requirePhoneNumber(this.#context, phoneNumberId)

    const { type, rawTo, recipient } = this.#validateEnvelope(body)
    this.#validateTypePayload(type, body)

    const businessId = state.businessIdOf(phoneNumberId) ?? state.defaultBusinessId
    const sentTo = rawTo !== undefined ? 'phone' : 'user_id'
    const waId = rawTo !== undefined ? this.#resolvePhone(rawTo) : this.#resolveBsuid(recipient!, businessId)

    const windowOpen = windows.isOpen(phoneNumberId, waId, clock.now())
    if (REQUIRES_OPEN_WINDOW.has(type) && !windowOpen) {
      throw new GraphError(ERROR_CODES.REENGAGEMENT)
    }

    // Resolved before any failure can short-circuit: the category comes from
    // the template being sent, and it decides how the message is priced.
    const category: PricingCategory =
      type === 'template'
        ? this.#templates.assertSendable(
            phoneNumber.wabaId,
            body['template'] as Record<string, unknown>,
          )
        : 'service'

    // One-tap, zero-tap and copy-code buttons need the phone number, and every
    // authentication template has one of them.
    if (sentTo === 'user_id' && category === 'authentication') {
      throw new GraphError(ERROR_CODES.BSUID_NOT_SUPPORTED)
    }

    // The portfolio's limit caps UNIQUE recipients reached outside a service
    // window per 24h, shared by all its numbers. Replies inside an open window
    // are never capped, and never counted.
    const tier = state.business(businessId)?.messagingTier ?? 'TIER_UNLIMITED'
    if (!windowOpen && !limits.allows(businessId, waId, tier, clock.now())) {
      throw new GraphError(ERROR_CODES.SPAM_RATE_LIMIT, {
        details: `This business portfolio has reached its messaging limit of ${TIER_CAPS[tier]} unique recipients outside a customer service window in 24 hours (${tier}).`,
      })
    }

    // A coexistence number that was disconnected or offboarded cannot send,
    // and is held to 20 messages per second when it can.
    this.#coexistence.assertCanSend(phoneNumberId)

    // A deliberately forced error wins over the random rate: a scenario you
    // asked for must not be overridden by chance.
    const forced = scenario.takeForcedError()
    if (forced !== undefined) throw new GraphError(forced)
    if (scenario.shouldFailSend()) throw new GraphError(ERROR_CODES.INTERNAL)

    if (!windowOpen) limits.record(businessId, waId, clock.now())
    this.#coexistence.recordSend(phoneNumberId)

    // Marketing to a user who tapped "Stop" is accepted, then fails on its
    // status with 131050. It is not delivered, so it is not billed.
    const stopped = category === 'marketing' && users.marketingStopped(phoneNumberId, waId)

    // Priced once, at acceptance, whether or not its webhooks get through: a
    // dropped webhook does not refund the message or its free-tier slot.
    const entryPoint = stopped
      ? undefined
      : this.#context.pricing.entryPoint(phoneNumberId, waId, clock.now(), {
          open: windowOpen,
          windowMs: windows.windowMs,
        })
    const pricing = stopped
      ? undefined
      : (entryPoint?.pricing ?? this.#context.pricing.price(phoneNumberId, category, clock.now()))

    const userId = users.bsuid(businessId, waId)
    // Messaging the phone number keeps it disclosed for 30 days; messaging the
    // BSUID does not.
    if (sentTo === 'phone') users.recordPhoneContact(phoneNumberId, waId, clock.now())

    const wamid = makeWamid(phoneNumberId, state.nextSeq())
    const { messaging_product: _mp, to: _to, recipient: _r, type: _t, ...rest } = body

    state.recordOutbound({
      id: wamid,
      phoneNumberId,
      to: waId,
      recipientUserId: userId,
      sentTo,
      type,
      payload: rest,
      sentAt: clock.now(),
    })

    // The other failure axis: the send is accepted and the app is told so, but
    // the webhooks never arrive. Silent, and the expensive one in production.
    if (!scenario.shouldDropWebhook()) {
      const user = this.#identity(phoneNumberId, waId)
      if (pricing) {
        this.#scheduleStatuses(phoneNumberId, wamid, user, sentTo, pricing, entryPoint?.window)
      } else {
        const at = clock.now() + STATUS_DELAYS.sent + scenario.latency()
        dispatcher.dispatchStatus(phoneNumberId, {
          messageId: wamid,
          status: 'failed',
          user,
          sentTo,
          timestampMs: at,
          errorCode: MARKETING_OPTED_OUT,
          atMs: at,
        })
      }
    }

    return {
      messaging_product: 'whatsapp',
      contacts: [
        rawTo !== undefined ? { input: rawTo, wa_id: waId } : { input: recipient!, user_id: userId },
      ],
      messages: [{ id: wamid, message_status: 'accepted' }],
    }
  }

  /**
   * Deliver an inbound message webhook, as if a customer had written. Returns
   * the generated wamid so callers can correlate.
   */
  simulateInbound(options: SimulateInboundOptions): { messageId: string } {
    const { clock, state, windows, dispatcher, users } = this.#context

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

    users.setProfile(waId, {
      ...(options.contactName !== undefined ? { name: options.contactName } : {}),
      ...(options.username !== undefined ? { username: options.username } : {}),
    })
    // Judged before this message counts as contact: a user with a username
    // writing in does not disclose their own number by doing so.
    const user = this.#identity(phoneNumberId, waId)
    if (user.phoneShared) users.recordPhoneContact(phoneNumberId, waId, clock.now())

    // A message from a Click-to-WhatsApp ad carries a referral, and makes the
    // business's reply free.
    if (options.message['referral'] !== undefined) {
      this.#context.pricing.noteAdEntry(phoneNumberId, waId, clock.now())
    }

    const messageId = makeWamid(phoneNumberId, state.nextSeq())
    state.recordInbound({ id: messageId, phoneNumberId, from: waId, receivedAt: clock.now() })
    dispatcher.dispatch(
      phoneNumberId,
      buildInboundPayload({
        wabaId: phoneNumber.wabaId,
        phoneNumberId,
        displayPhoneNumber: phoneNumber.displayPhoneNumber,
        user,
        messageId,
        timestampMs: clock.now(),
        message: options.message,
      }),
    )

    return { messageId }
  }

  /**
   * `POST /{phone_number_id}/messages` with `status: "read"` — mark a received
   * message as read, optionally showing a typing indicator.
   *
   * Same route as a send, different body: no `to`, no `type`. It is not a
   * message, so it needs no open window, is not billed, counts against no
   * limit and produces no statuses. An id the number never received is
   * `131009`, as Meta documents, which includes an outbound wamid.
   */
  markRead(phoneNumberId: string, body: Record<string, unknown>, accessToken?: string): { success: true } {
    const { clock, state } = this.#context

    assertToken(this.#context, accessToken)
    requirePhoneNumber(this.#context, phoneNumberId)

    if (body['messaging_product'] !== 'whatsapp') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: "Param messaging_product must be 'whatsapp'",
      })
    }

    const messageId = body['message_id']
    if (typeof messageId !== 'string' || messageId === '') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param message_id is required' })
    }

    const typing = body['typing_indicator']
    if (typing !== undefined && (typing as { type?: unknown } | null)?.type !== 'text') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: "Param typing_indicator[type] must be 'text'",
      })
    }

    if (state.inbound(messageId)?.phoneNumberId !== phoneNumberId) {
      throw new GraphError(ERROR_CODES.PARAMETER_VALUE_INVALID)
    }

    state.recordReadReceipt({
      messageId,
      phoneNumberId,
      typingIndicator: typing !== undefined,
      at: clock.now(),
    })
    return { success: true }
  }

  /**
   * A user stops or resumes marketing messages from a business number
   * (control API), announced with a `user_preferences` webhook.
   */
  setUserPreference(options: { from: string; value: 'stop' | 'resume'; phoneNumberId?: string }): {
    success: true
  } {
    const { clock, state, dispatcher, users } = this.#context
    const phoneNumberId = options.phoneNumberId ?? state.defaultPhoneNumberId
    const phoneNumber = requirePhoneNumber(this.#context, phoneNumberId)
    const waId = normalizeWaId(options.from)
    if (!waId) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `'${options.from}' is not a valid phone number`,
      })
    }

    users.setMarketing(phoneNumberId, waId, options.value)
    dispatcher.dispatch(
      phoneNumberId,
      buildUserPreferencePayload({
        wabaId: phoneNumber.wabaId,
        phoneNumberId,
        displayPhoneNumber: phoneNumber.displayPhoneNumber,
        user: this.#identity(phoneNumberId, waId),
        value: options.value,
        timestampMs: clock.now(),
      }),
    )
    return { success: true }
  }

  /**
   * A user changed their phone number (control API). Their BSUID changes with
   * it, their profile carries over, and the business number hears about it as
   * a `system` message on `messages`.
   */
  changeUserNumber(options: { from: string; to: string; phoneNumberId?: string }): { success: true } {
    const { clock, state, dispatcher, users } = this.#context

    const phoneNumberId = options.phoneNumberId ?? state.defaultPhoneNumberId
    const phoneNumber = requirePhoneNumber(this.#context, phoneNumberId)
    const from = normalizeWaId(options.from)
    const to = normalizeWaId(options.to)
    if (!from || !to) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `'${!from ? options.from : options.to}' is not a valid phone number`,
      })
    }

    const previous = this.#identity(phoneNumberId, from)
    const profile = users.profile(from)
    users.setProfile(to, {
      ...(profile.name !== undefined ? { name: profile.name } : {}),
      ...(profile.username !== undefined ? { username: profile.username } : {}),
    })
    // The new number has had no contact with this business yet, so a user
    // with a username keeps it hidden: that is the user_changed_user_id case.
    const current = this.#identity(phoneNumberId, to)

    dispatcher.dispatch(
      phoneNumberId,
      buildNumberChangePayload({
        wabaId: phoneNumber.wabaId,
        phoneNumberId,
        displayPhoneNumber: phoneNumber.displayPhoneNumber,
        messageId: makeWamid(phoneNumberId, state.nextSeq()),
        timestampMs: clock.now(),
        previous,
        current,
      }),
    )
    return { success: true }
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
      user: this.#identity(message.phoneNumberId, message.to),
      sentTo: message.sentTo,
      timestampMs: clock.now(),
      ...(errorCode !== undefined ? { errorCode } : {}),
    })
    return { success: true }
  }

  // --- internals ----------------------------------------------------------

  #validateEnvelope(body: Record<string, unknown>): {
    type: string
    rawTo?: string
    recipient?: string
  } {
    if (body['messaging_product'] !== 'whatsapp') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: "Param messaging_product must be 'whatsapp'",
      })
    }

    // `to` (a phone number) or `recipient` (a BSUID). With both, `to` wins.
    const rawTo = typeof body['to'] === 'string' && body['to'].trim() !== '' ? body['to'] : undefined
    const recipient =
      typeof body['recipient'] === 'string' && body['recipient'].trim() !== '' ? body['recipient'] : undefined
    if (rawTo === undefined && recipient === undefined) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param to is required' })
    }

    const type = typeof body['type'] === 'string' ? body['type'] : 'text'
    if (!SUPPORTED_TYPES.has(type)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Param type must be one of {${[...SUPPORTED_TYPES].join(', ')}}`,
      })
    }

    return { type, ...(rawTo !== undefined ? { rawTo } : { recipient: recipient! }) }
  }

  /**
   * A well-formed request to an unreachable number is 131026, NOT 100. The
   * distinction tells an integration "fix your code" from "drop this
   * contact", and integrations really do branch on it.
   */
  #resolvePhone(rawTo: string): string {
    const waId = normalizeWaId(rawTo)
    if (!waId) throw new GraphError(ERROR_CODES.UNDELIVERABLE)
    return waId
  }

  /**
   * A BSUID only works from a number in the portfolio it is scoped to. Meta
   * says such a send fails without naming the code; wamock answers 131009,
   * "Parameter value is not valid", which is what the value is.
   */
  #resolveBsuid(recipient: string, businessId: string): string {
    const issued = this.#context.users.resolve(recipient)
    if (!issued || issued.businessId !== businessId) {
      throw new GraphError(ERROR_CODES.PARAMETER_VALUE_INVALID, {
        details: `Recipient ${recipient} is not a business-scoped user ID of this business portfolio`,
      })
    }
    return issued.waId
  }

  /** Everything a webhook needs to know about a user, right now. */
  #identity(phoneNumberId: string, waId: string): UserIdentity {
    return userIdentity(this.#context, phoneNumberId, waId)
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
    user: UserIdentity,
    sentTo: 'phone' | 'user_id',
    pricing: Record<string, unknown>,
    entryPoint?: EntryPointWindow,
  ): void {
    const { clock, scenario, dispatcher } = this.#context

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
        user,
        sentTo,
        timestampMs: at,
        // Meta attaches `pricing` to ONE status per message — `sent`, or one of
        // `delivered`/`read` — never to each. wamock puts it on `delivered`,
        // as in Meta's v24.0 example; a receiver must not assume which. No
        // `conversation` object: v24.0+ omits it outside free entry point
        // windows, which wamock does not open.
        ...(status === 'delivered' ? { pricing } : {}),
        // Inside a free entry point window the conversation object is back,
        // on `sent` and on `delivered`; its expiration rides on `sent` only.
        ...(entryPoint
          ? {
              conversation: {
                id: entryPoint.id,
                ...(status === 'sent'
                  ? { expiration_timestamp: String(Math.floor(entryPoint.expiresAt / 1000)) }
                  : {}),
                origin: { type: 'referral_conversion' },
              },
            }
          : {}),
        atMs: at,
      })
    }
  }
}
