import type { MockContext } from '../core/context.js'
import { isAuthInternational } from '../core/pricing.js'
import type { EntryPointWindow, PricingCategory } from '../core/pricing.js'
import { assertToken, requirePhoneNumber } from '../core/guards.js'
import { userIdentity } from '../core/identity.js'
import { makeWamid } from '../core/ids.js'
import { TIER_CAPS } from '../core/limits.js'
import { countryOf, normalizeWaId, toWebhookDisplayNumber } from '../core/phone.js'
import { isRecord, isWebUrl, textOf } from '../core/values.js'
import { ERROR_CODES, GraphError } from '../errors/graph-error.js'
import {
  buildInboundPayload,
  buildNumberChangePayload,
  buildUserPreferencePayload,
} from '../webhooks/payloads.js'
import type { InboundContent, MessageStatus, UserIdentity } from '../webhooks/payloads.js'
import { validateInteractive } from './interactive.js'
import type { BlockService } from './block-service.js'
import { isRegistered } from './registration-service.js'
import type { CoexistenceService } from './coexistence-service.js'
import { MIME_TYPES_BY_KIND } from './media-service.js'
import type { MediaService } from './media-service.js'
import { MEDIA_TYPES, validateContacts, validateLocation, validateMedia, validateReaction } from './message-content.js'
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

/** A media link Meta could not fetch: this one arrives on the status. */
const MEDIA_UNUSABLE = ERROR_CODES.MEDIA_UPLOAD_ERROR

/** How long after sending a customer can edit a message, and revoke one. */
const EDIT_WINDOW_MS = 15 * 60 * 1000
const REVOKE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000
/** Media whose caption a customer can edit. */
const EDITABLE_MEDIA: ReadonlySet<string> = new Set(['image', 'video', 'document'])

/** Meta's limit on `biz_opaque_callback_data`. */
const OPAQUE_DATA_MAX = 512

/**
 * The MIME type Meta reports for inbound media when the test does not say:
 * the formats WhatsApp clients send. A voice note is Opus in Ogg, written with
 * its codec, as Meta's audio example shows.
 */
function defaultInboundMime(type: string, voice: boolean): string {
  if (type === 'audio') return voice ? 'audio/ogg; codecs=opus' : 'audio/mpeg'
  return { image: 'image/jpeg', video: 'video/mp4', document: 'application/pdf', sticker: 'image/webp' }[type] ?? 'application/octet-stream'
}


/** Meta's text message limit. */
const TEXT_BODY_MAX = 4096

/** Every message type the Messages API accepts. */
const SUPPORTED_TYPES = new Set([
  'text',
  'template',
  'interactive',
  ...Object.keys(MEDIA_TYPES),
  'location',
  'contacts',
  'reaction',
])

/**
 * Only a template may open a conversation: everything else needs an open 24h
 * service window. Being the way out of a closed window is what templates are for.
 */
const requiresOpenWindow = (type: string): boolean => type !== 'template'

/** A reaction can target a message from the last 30 days of the thread. */
const REACTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

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
  /** The wamid the customer is replying to; Meta sends it as `context.id`. */
  contextId?: string
  message: InboundContent
}

export class MessagingService {
  readonly #context: MockContext
  /** Template lookups on the send path; the two services collaborate, not merge. */
  readonly #templates: TemplateService

  /** Coexistence numbers cap throughput and can be disconnected. */
  readonly #coexistence: CoexistenceService
  /** A send by media `id` needs the media to exist. */
  readonly #media: MediaService
  /** A blocked customer neither receives nor reaches the business. */
  readonly #blocks: BlockService

  constructor(
    context: MockContext,
    templates: TemplateService,
    coexistence: CoexistenceService,
    media: MediaService,
    blocks: BlockService,
  ) {
    this.#context = context
    this.#templates = templates
    this.#coexistence = coexistence
    this.#media = media
    this.#blocks = blocks
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
    // Embedded Signup verifies a number but leaves registering it to the
    // partner: until `register`, every send fails, as with Meta.
    if (!isRegistered(phoneNumber)) {
      throw new GraphError(ERROR_CODES.NOT_REGISTERED, {
        details: `Register ${phoneNumberId} (POST /{phone_number_id}/register) before sending from it`,
      })
    }

    const { type, rawTo, recipient } = this.#validateEnvelope(body)
    this.#validateTypePayload(type, body)
    const mediaUnusable = this.#checkMediaReferences(type, body)

    const businessId = state.businessIdOf(phoneNumberId) ?? state.defaultBusinessId
    const sentTo = rawTo !== undefined ? 'phone' : 'user_id'
    const waId = rawTo !== undefined ? this.#resolvePhone(rawTo) : this.#resolveBsuid(recipient!, businessId)

    const windowOpen = windows.isOpen(phoneNumberId, waId, clock.now())
    if (requiresOpenWindow(type) && !windowOpen) {
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
    // Media Meta could not use fails the same way, on the status, with 131053,
    // and so does a message to a customer the business blocked, with 130403
    // (accepted first, as integrators report it; Meta's page says only that
    // it "returns an error").
    const blocked = this.#blocks.isBlocked(phoneNumberId, waId)
    const failureCode = blocked
      ? ERROR_CODES.BLOCKED_USER
      : stopped
        ? MARKETING_OPTED_OUT
        : mediaUnusable
          ? MEDIA_UNUSABLE
          : undefined

    // Priced once, at acceptance, whether or not its webhooks get through: a
    // dropped webhook does not refund the message or its free-tier slot.
    const entryPoint = failureCode !== undefined
      ? undefined
      : this.#context.pricing.entryPoint(phoneNumberId, waId, clock.now(), {
          open: windowOpen,
          windowMs: windows.windowMs,
        })
    // A reaction is never delivered as such (only `sent`), so it is not priced.
    const pricing =
      failureCode !== undefined || type === 'reaction'
        ? undefined
        : (entryPoint?.pricing ?? this.#context.pricing.price(phoneNumberId, category, clock.now()))

    const userId = users.bsuid(businessId, waId)
    // Messaging the phone number keeps it disclosed for 30 days; messaging the
    // BSUID does not.
    if (sentTo === 'phone') users.recordPhoneContact(phoneNumberId, waId, clock.now())

    const wamid = makeWamid(phoneNumberId, state.nextSeq())
    // The token rides in the body of a form post; it is not message content.
    const { messaging_product: _mp, to: _to, recipient: _r, type: _t, access_token: _token, ...rest } = body
    const opaque = body['biz_opaque_callback_data'] as string | undefined

    state.recordOutbound({
      id: wamid,
      phoneNumberId,
      to: waId,
      recipientUserId: userId,
      sentTo,
      type,
      payload: rest,
      sentAt: clock.now(),
      ...(opaque !== undefined ? { bizOpaqueCallbackData: opaque } : {}),
    })

    // The other failure axis: the send is accepted and the app is told so, but
    // the webhooks never arrive. Silent, and the expensive one in production.
    if (!scenario.shouldDropWebhook()) {
      const user = this.#identity(phoneNumberId, waId)
      // A reaction to a blocked customer fails like any other message to one.
      if (type === 'reaction' && failureCode === undefined) {
        this.#scheduleReactionStatus(phoneNumberId, wamid, waId, user, sentTo, body['reaction'], opaque)
      } else if (pricing) {
        this.#scheduleStatuses(phoneNumberId, wamid, user, sentTo, pricing, entryPoint?.window, opaque, businessId)
      } else {
        const at = clock.now() + STATUS_DELAYS.sent + scenario.latency()
        dispatcher.dispatchStatus(phoneNumberId, {
          messageId: wamid,
          status: 'failed',
          user,
          sentTo,
          timestampMs: at,
          errorCode: failureCode ?? MARKETING_OPTED_OUT,
          ...(opaque !== undefined ? { bizOpaqueCallbackData: opaque } : {}),
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

    // A number not on Cloud API has nothing to deliver its messages to.
    if (!isRegistered(phoneNumber)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `${phoneNumberId} is not registered on Cloud API, so no message reaches it there`,
      })
    }

    // "The user cannot contact your business": nothing arrives from a
    // customer the number blocked. Refused rather than dropped, so a test
    // cannot believe it delivered a message Meta never would.
    if (this.#blocks.isBlocked(phoneNumberId, waId)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `${waId} is blocked by ${phoneNumberId}; Meta delivers nothing from a blocked user`,
      })
    }

    // A customer editing or deleting a message they sent is not them writing
    // to you, so it neither opens nor renews the window. An inference: Meta
    // describes the window as opened when the user messages you, and is
    // silent on edits.
    const amendment = options.message.type === 'edit' || options.message.type === 'revoke'

    // The customer writing is the ONLY thing that opens or renews the window.
    if (!amendment) windows.recordInbound(phoneNumberId, waId, clock.now())

    users.setProfile(waId, {
      ...(options.contactName !== undefined ? { name: options.contactName } : {}),
      ...(options.username !== undefined ? { username: options.username } : {}),
    })
    // Judged before this message counts as contact: a user with a username
    // writing in does not disclose their own number by doing so.
    const user = this.#identity(phoneNumberId, waId)
    if (user.phoneShared && !amendment) users.recordPhoneContact(phoneNumberId, waId, clock.now())

    // A message from a Click-to-WhatsApp ad carries a referral, and makes the
    // business's reply free.
    if (options.message['referral'] !== undefined) {
      this.#context.pricing.noteAdEntry(phoneNumberId, waId, clock.now())
    }

    const message = amendment
      ? this.#amendment(phoneNumberId, waId, options.message)
      : this.#inboundContent(phoneNumberId, phoneNumber.displayPhoneNumber, options)
    const messageId = makeWamid(phoneNumberId, state.nextSeq())
    state.recordInbound({
      id: messageId,
      phoneNumberId,
      from: waId,
      receivedAt: clock.now(),
      type: options.message.type,
      content: message,
    })
    dispatcher.dispatch(
      phoneNumberId,
      buildInboundPayload({
        wabaId: phoneNumber.wabaId,
        phoneNumberId,
        displayPhoneNumber: phoneNumber.displayPhoneNumber,
        user,
        messageId,
        timestampMs: clock.now(),
        message,
      }),
    )

    return { messageId }
  }

  /**
   * A customer editing or revoking a message they sent, as Meta reports it to
   * a Coexistence number (the only kind its pages describe these webhooks
   * for): an edit within 15 minutes, of a text or a media caption, carries the
   * whole message as it now reads; a revoke within two days carries only the
   * original's id.
   */
  #amendment(phoneNumberId: string, waId: string, request: InboundContent): InboundContent {
    const { clock, state } = this.#context
    const kind = request.type as 'edit' | 'revoke'
    const fields = isRecord(request[kind]) ? request[kind] : {}
    const refuse = (details: string) => new GraphError(ERROR_CODES.INVALID_PARAMETER, { details })

    if (!this.#coexistence.isOnBizApp(phoneNumberId)) {
      throw refuse(`Meta sends ${kind} webhooks for Coexistence numbers; ${phoneNumberId} was not onboarded from the WhatsApp Business app`)
    }
    const original = typeof fields['message_id'] === 'string' ? state.inbound(fields['message_id']) : undefined
    if (!original || original.phoneNumberId !== phoneNumberId || original.from !== waId || !original.content) {
      throw refuse(`${kind}: no message ${String(fields['message_id'])} from ${waId} on this number`)
    }
    if (original.revoked === true || original.type === 'edit' || original.type === 'revoke') {
      throw refuse(`${kind}: message ${original.id} was revoked, or is itself an edit or a revoke`)
    }
    const age = clock.now() - original.receivedAt

    if (kind === 'revoke') {
      if (age > REVOKE_WINDOW_MS) throw refuse(`revoke: message ${original.id} is more than two days old`)
      state.recordInbound({ ...original, revoked: true })
      return { type: 'revoke', revoke: { original_message_id: original.id } }
    }

    if (age > EDIT_WINDOW_MS) throw refuse(`edit: message ${original.id} is more than 15 minutes old`)
    const { type } = original.content as { type: string }
    const context = isRecord(original.content['context']) ? { context: { id: original.content['context']['id'] } } : {}
    let edited: Record<string, unknown>
    if (type === 'text' && typeof fields['text'] === 'string') {
      edited = { ...context, type, text: { body: fields['text'] } }
    } else if (EDITABLE_MEDIA.has(type) && typeof fields['caption'] === 'string') {
      const { id, mime_type: mimeType, sha256, url } = original.content[type] as Record<string, unknown>
      edited = { ...context, type, [type]: { caption: fields['caption'], mime_type: mimeType, sha256, id, url } }
    } else {
      throw refuse('edit: a text takes `text`, an image, video or document takes `caption`; nothing else can be edited')
    }
    const body = isRecord(edited[type]) ? edited[type] : {}
    state.recordInbound({ ...original, content: { ...original.content, [type]: { ...(original.content[type] as object), ...body } } })
    return { type: 'edit', edit: { original_message_id: original.id, message: edited } }
  }

  /**
   * The message object as Meta delivers it. Media gets a real, downloadable
   * media id (7-day lifetime, like ids from webhooks), its hash and URL; a
   * reply gets `context: {from, id}`, `from` being the business number; an
   * unsupported message carries Meta's 131051 error.
   */
  #inboundContent(phoneNumberId: string, businessNumber: string, options: SimulateInboundOptions): InboundContent {
    const { type } = options.message
    let content: InboundContent = { ...options.message }

    if (MEDIA_TYPES[type]) {
      const media = { ...(content[type] as Record<string, unknown> | undefined) }
      const { bytes, ...fields } = media
      const mimeType =
        typeof fields['mime_type'] === 'string' ? fields['mime_type'] : defaultInboundMime(type, fields['voice'] === true)
      const received = this.#media.receive(
        phoneNumberId,
        mimeType,
        Buffer.isBuffer(bytes) ? bytes : Buffer.from(`wamock ${type}`),
      )
      // `voice` and `animated` are always there, true or false, as in Meta's
      // audio and sticker references.
      const flags =
        type === 'audio' ? { voice: fields['voice'] === true } : type === 'sticker' ? { animated: fields['animated'] === true } : {}
      content = {
        ...content,
        [type]: { ...fields, mime_type: mimeType, sha256: received.sha256, id: received.id, url: received.url, ...flags },
      }
    }

    if (type === 'unsupported') {
      content = {
        errors: [
          {
            code: 131051,
            title: 'Message type unknown',
            message: 'Message type unknown',
            error_data: { details: 'Message type is currently not supported.' },
          },
        ],
        ...content,
      }
    }

    if (options.contextId !== undefined) {
      content = { ...content, context: { from: toWebhookDisplayNumber(businessNumber), id: options.contextId } }
    }
    return content
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
   * to test a `read` receipt, a voice message `played`, or a delivery
   * failure, since none of them happens on its own.
   */
  forceStatus(
    messageId: string,
    status: MessageStatus,
    errorCode?: number,
  ): { success: true } {
    const { clock, state, dispatcher } = this.#context

    const message = state.outbound().find((candidate) => candidate.id === messageId)
    if (!message) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `No message with id '${messageId}' was sent through this mock`,
      })
    }
    // Meta reports a play only for a voice message: `audio` sent with
    // `voice: true`. Forcing it on anything else would let a test expect a
    // webhook that never comes.
    // Meta's `errors` comes with every failed status and with no other.
    if ((errorCode !== undefined) !== (status === 'failed')) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details:
          status === 'failed'
            ? 'Status failed needs an error code: every failed status Meta sends carries errors'
            : `An error code goes only with status failed, not ${status}: Meta reports errors on failed statuses alone`,
      })
    }
    const audio = message.payload['audio']
    const voice = message.type === 'audio' && isRecord(audio) && audio['voice'] === true
    if (status === 'played' && !voice) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Message '${messageId}' is not a voice message; Meta sends played only for audio sent with voice: true`,
      })
    }

    dispatcher.dispatchStatus(message.phoneNumberId, {
      messageId,
      status,
      user: this.#identity(message.phoneNumberId, message.to),
      sentTo: message.sentTo,
      timestampMs: clock.now(),
      ...(message.bizOpaqueCallbackData !== undefined
        ? { bizOpaqueCallbackData: message.bizOpaqueCallbackData }
        : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
    })
    return { success: true }
  }

  // --- internals ----------------------------------------------------------

  /**
   * An authentication template may be billed the authentication-international
   * rate. Meta applies it to messages "delivered on or after" the start time,
   * so it is judged at the instant this one's `delivered` goes out, latency
   * and reordering included. Only the category changes: no counter tracks
   * authentication messages, so nothing is billed twice.
   */
  #billedAt(pricing: Record<string, unknown>, businessId: string | undefined, waId: string, deliveredAt: number): Record<string, unknown> {
    if (pricing['category'] !== 'authentication' || businessId === undefined) return pricing
    const business = this.#context.state.business(businessId)
    return isAuthInternational(business, countryOf(waId), deliveredAt) ? { ...pricing, category: 'authentication_international' } : pricing
  }

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

    // Meta documents `individual` and `group`. Groups are a separate API that
    // wamock does not emulate, so a group send is refused outright rather than
    // quietly treated as a 1:1 message.
    const recipientType = body['recipient_type']
    if (recipientType !== undefined && recipientType !== 'individual') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details:
          recipientType === 'group'
            ? 'recipient_type group is not emulated by wamock (the Groups API is out of scope)'
            : "Param recipient_type must be one of {individual, group}",
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

    // A string of up to 512 characters (Meta raised it from 256, per its
    // changelog). Anything else is refused rather than dropped, so a status
    // never silently lacks the data the app expects echoed.
    const opaque = body['biz_opaque_callback_data']
    if (opaque !== undefined && (typeof opaque !== 'string' || opaque.length > OPAQUE_DATA_MAX)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Param biz_opaque_callback_data must be a string of at most ${OPAQUE_DATA_MAX} characters`,
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


  /**
   * Every media reference a send carries, wherever it sits: the media of a
   * media message, the media header of an interactive message, a media
   * parameter of a template. Checked the same way in all three places:
   *
   * - an `id` this mock does not hold, or one past its lifetime, is refused
   *   at once with 131009;
   * - an `id` whose media is not a type this kind of message carries (a PDF
   *   as an image) is refused at once with 131053: the per-type message
   *   pages say an unsupported format fails the request, with no message id;
   * - a `link` that is not an http(s) URL is accepted, and fails on its
   *   status with 131053, as a link Meta could not fetch does: the error
   *   code reference reports 131053 on the webhook of a message that failed.
   *   An inference: the docs require a public URL but do not say whether a
   *   string that is not one fails the send or the status.
   *
   * Returns whether the send must fail that way, on its status.
   */
  #checkMediaReferences(type: string, body: Record<string, unknown>): boolean {
    const found: Array<{ where: string; kind: string; media: Record<string, unknown> }> = []
    const content = body[type]
    if (MEDIA_TYPES[type] && isRecord(content)) found.push({ where: type, kind: type, media: content })
    if (type === 'interactive' && isRecord(content) && isRecord(content['header'])) {
      const header = content['header']
      const kind = textOf(header['type'])
      if (kind in MEDIA_TYPES && isRecord(header[kind])) {
        found.push({ where: `interactive[header][${kind}]`, kind, media: header[kind] })
      }
    }
    if (type === 'template' && isRecord(content) && Array.isArray(content['components'])) {
      for (const component of content['components'] as unknown[]) {
        if (!isRecord(component) || !Array.isArray(component['parameters'])) continue
        for (const parameter of component['parameters'] as unknown[]) {
          if (!isRecord(parameter)) continue
          const kind = textOf(parameter['type'])
          if (kind in MEDIA_TYPES && isRecord(parameter[kind])) {
            found.push({ where: `template parameter ${kind}`, kind, media: parameter[kind] })
          }
        }
      }
    }

    let unusable = false
    for (const { where, kind, media } of found) {
      const { id, link } = media
      if (typeof id === 'string') {
        const mimeType = this.#media.mimeTypeOf(id)
        if (mimeType === undefined) {
          throw new GraphError(ERROR_CODES.PARAMETER_VALUE_INVALID, {
            details: `${where}[id] ${id} is not an uploaded media id, or it has expired`,
          })
        }
        // By the base type: `audio/ogg; codecs=opus`, as a received voice
        // note is described, is the Ogg audio Meta supports.
        const base = mimeType.split(';')[0]!.trim().toLowerCase()
        if (!MIME_TYPES_BY_KIND[kind]?.has(base)) {
          throw new GraphError(ERROR_CODES.MEDIA_UPLOAD_ERROR, {
            details: `${where}[id] ${id} is ${base}, which is not a supported ${kind} type`,
          })
        }
      }
      if (typeof link === 'string' && !isWebUrl(link)) unusable = true
    }
    return unusable
  }

  #validateTypePayload(type: string, body: Record<string, unknown>): void {
    if (MEDIA_TYPES[type]) return validateMedia(type, body[type])
    if (type === 'location') return validateLocation(body['location'])
    if (type === 'contacts') return validateContacts(body['contacts'])
    if (type === 'reaction') return validateReaction(body['reaction'])

    if (type === 'text') {
      const text = body['text'] as { body?: unknown } | undefined
      if (typeof text?.body !== 'string' || text.body === '') {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: 'Param text[body] is required for type text',
        })
      }
      if (text.body.length > TEXT_BODY_MAX) {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: `Param text[body] exceeds the ${TEXT_BODY_MAX} character limit (got ${text.body.length})`,
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

  /**
   * A reaction gets a `sent` status and nothing more: no `delivered`, so no
   * pricing either. A reaction to a message that is not in this chat, is over
   * 30 days old, or is itself a reaction fails instead, with 131009.
   */
  #scheduleReactionStatus(
    phoneNumberId: string,
    wamid: string,
    waId: string,
    user: UserIdentity,
    sentTo: 'phone' | 'user_id',
    reaction: unknown,
    bizOpaqueCallbackData: string | undefined,
  ): void {
    const { clock, state, scenario, dispatcher } = this.#context
    const targetId = (reaction as { message_id: string }).message_id
    const now = clock.now()

    const inbound = state.inbound(targetId)
    const outbound = state.outbound().find((message) => message.id === targetId)
    const target =
      inbound && inbound.phoneNumberId === phoneNumberId && inbound.from === waId
        ? { at: inbound.receivedAt, reaction: inbound.type === 'reaction' }
        : outbound && outbound.phoneNumberId === phoneNumberId && outbound.to === waId
          ? { at: outbound.sentAt, reaction: outbound.type === 'reaction' }
          : undefined
    const valid = target !== undefined && !target.reaction && now - target.at <= REACTION_WINDOW_MS

    const at = now + STATUS_DELAYS.sent + scenario.latency()
    dispatcher.dispatchStatus(phoneNumberId, {
      messageId: wamid,
      status: valid ? 'sent' : 'failed',
      user,
      sentTo,
      timestampMs: at,
      ...(valid ? {} : { errorCode: ERROR_CODES.PARAMETER_VALUE_INVALID }),
      ...(bizOpaqueCallbackData !== undefined ? { bizOpaqueCallbackData } : {}),
      atMs: at,
    })
  }

  #scheduleStatuses(
    phoneNumberId: string,
    wamid: string,
    user: UserIdentity,
    sentTo: 'phone' | 'user_id',
    pricing: Record<string, unknown>,
    entryPoint?: EntryPointWindow,
    bizOpaqueCallbackData?: string,
    businessId?: string,
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
        ...(status === 'delivered' ? { pricing: this.#billedAt(pricing, businessId, user.waId, at) } : {}),
        ...(bizOpaqueCallbackData !== undefined ? { bizOpaqueCallbackData } : {}),
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
