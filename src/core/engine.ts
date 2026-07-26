import { ERROR_CODES, GraphError } from '../errors/graph-error.js'
import { validateInteractive } from '../graph/interactive.js'
import { WebhookDeliverer } from '../webhooks/delivery.js'
import { buildInboundPayload, buildStatusPayload } from '../webhooks/payloads.js'
import type { InboundContent } from '../webhooks/payloads.js'
import { nullTransport } from '../webhooks/transport.js'
import type { WebhookTransport } from '../webhooks/transport.js'
import { VirtualClock } from './clock.js'
import { createHash, randomBytes } from 'node:crypto'

import { buildQualityUpdatePayload, buildTemplateStatusPayload } from '../webhooks/tech-payloads.js'
import { makeFbtraceId, makeMediaId, makeWamid } from './ids.js'
import { MessagingLimits, TIER_CAPS } from './limits.js'
import { normalizeWaId, toDisplayPhoneNumber } from './phone.js'
import { TokenStore } from './tokens.js'
import type { DebugTokenData } from './tokens.js'
import type { MessagingTier, QualityRating } from './types.js'
import { Conversations } from './conversations.js'
import type { ConversationCategory } from './conversations.js'
import { ScenarioController } from './scenario.js'
import { MockState } from './state.js'
import { ServiceWindows } from './window.js'
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_NAME_PATTERN,
  TEMPLATE_STATUSES,
} from './templates.js'
import type { Template, TemplateCategory, TemplateStatus } from './templates.js'

/**
 * The mock's brain: state + clock + webhook queue, with the Graph API
 * behaviours on top. Every entry point (HTTP server, library mode, CLI) is a
 * thin shell over this, so the three modes cannot drift apart.
 */

/** How long after acceptance each delivery status fires, in virtual ms. */
const STATUS_DELAYS = {
  sent: 50,
  delivered: 500,
} as const

/** Message types accepted in v1. `reaction`/`image` are stubbed in later phases. */
const SUPPORTED_TYPES = new Set(['text', 'template', 'interactive'])

/**
 * Types that require an open 24h service window. Templates are exempt — being
 * the only way out of a closed window is what templates are for.
 */
const REQUIRES_OPEN_WINDOW = new Set(['text', 'interactive'])

/** Meta's media download URLs are valid for roughly five minutes. */
const MEDIA_URL_TTL_MS = 5 * 60 * 1000

interface MediaRecord {
  id: string
  mimeType: string
  uploadedAt: number
}

export interface WamockEngineOptions {
  appSecret: string
  /** `frozen` for tests (time only moves via advance), `live` for the server. */
  mode?: 'frozen' | 'live'
  start?: number
  transport?: WebhookTransport
  /** Override the 24h service window length — useful for cheap expiry tests. */
  windowMs?: number
  phoneNumberId?: string
  wabaId?: string
  displayPhoneNumber?: string
}

export interface TemplateCreateResponse {
  id: string
  status: TemplateStatus
  category: TemplateCategory
}

const isTemplateCategory = (value: unknown): value is TemplateCategory =>
  typeof value === 'string' && (TEMPLATE_CATEGORIES as readonly string[]).includes(value)

/**
 * The `reason` Meta attaches to a template status webhook. `NONE` on a clean
 * approval — the field is always present, so a receiver reading it never gets
 * undefined.
 */
const TRANSITION_REASONS: Record<TemplateStatus, string> = {
  APPROVED: 'NONE',
  PENDING: 'NONE',
  REJECTED: 'INVALID_FORMAT',
  PAUSED: 'PAIRWISE_QUALITY_SIGNAL',
  DISABLED: 'ABUSIVE_CONTENT',
}

/** Meta names conversation categories after template categories, lowercased. */
const templateCategoryToConversation = (category: TemplateCategory): ConversationCategory =>
  category.toLowerCase() as ConversationCategory

export interface SendMessageResponse {
  messaging_product: 'whatsapp'
  contacts: Array<{ input: string; wa_id: string }>
  messages: Array<{ id: string; message_status: string }>
}

export class WamockEngine {
  readonly clock: VirtualClock
  readonly state: MockState
  readonly deliverer: WebhookDeliverer
  readonly windows: ServiceWindows
  readonly scenario = new ScenarioController()
  readonly conversations = new Conversations()
  readonly tokens = new TokenStore()
  readonly limits = new MessagingLimits()
  readonly #media = new Map<string, MediaRecord>()
  readonly #signupCodes = new Map<
    string,
    { wabaId: string; phoneNumberId: string; used: boolean }
  >()

  constructor(options: WamockEngineOptions) {
    this.clock = new VirtualClock({
      mode: options.mode ?? 'live',
      ...(options.start !== undefined ? { start: options.start } : {}),
    })
    this.state = new MockState({
      appSecret: options.appSecret,
      ...(options.phoneNumberId !== undefined ? { phoneNumberId: options.phoneNumberId } : {}),
      ...(options.wabaId !== undefined ? { wabaId: options.wabaId } : {}),
      ...(options.displayPhoneNumber !== undefined
        ? { displayPhoneNumber: options.displayPhoneNumber }
        : {}),
    })
    this.deliverer = new WebhookDeliverer({
      clock: this.clock,
      transport: options.transport ?? nullTransport,
    })
    this.windows = new ServiceWindows(
      options.windowMs !== undefined ? { windowMs: options.windowMs } : {},
    )
  }

  /** A deterministic `fbtrace_id` for the next error. */
  nextFbtraceId(): string {
    return makeFbtraceId(this.state.nextSeq())
  }

  /** Await any webhook deliveries the last `advance()` kicked off. */
  async settle(): Promise<void> {
    await this.deliverer.settle()
  }

  // --- POST /{version}/{phone_number_id}/messages -------------------------

  sendMessage(
    phoneNumberId: string,
    body: Record<string, unknown>,
    accessToken?: string,
  ): SendMessageResponse {
    // Unauthenticated sends are allowed on purpose: most users never touch
    // tokens, and requiring one would add three steps to the quickstart for no
    // benefit. But a token that IS supplied must actually be valid — that is
    // how the "expires between connect and first send" scenario reproduces.
    if (accessToken !== undefined && !this.tokens.isValid(accessToken, this.clock.now())) {
      throw new GraphError(ERROR_CODES.TOKEN_EXPIRED)
    }

    const phoneNumber = this.state.phoneNumber(phoneNumberId)
    if (!phoneNumber) {
      // Meta's wording for an object id it does not recognize.
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        message: 'Unsupported post request',
        details: `Object with ID '${phoneNumberId}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
      })
    }

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

    this.#assertTypePayload(type, body)

    // A well-formed request to an unreachable number is 131026, NOT 100. The
    // distinction is what tells an integration "fix your code" from "drop this
    // contact", and integrations really do branch on it.
    const waId = normalizeWaId(rawTo)
    if (!waId) {
      throw new GraphError(ERROR_CODES.UNDELIVERABLE)
    }

    if (REQUIRES_OPEN_WINDOW.has(type) && !this.windows.isOpen(phoneNumberId, waId, this.clock.now())) {
      throw new GraphError(ERROR_CODES.REENGAGEMENT)
    }

    // Category has to be resolved before the send can fail, because it comes
    // from the template being sent.
    let category: ConversationCategory = 'service'
    if (type === 'template') {
      const spec = body['template'] as Record<string, unknown>
      this.#assertTemplateSendable(phoneNumber.wabaId, spec)
      category = templateCategoryToConversation(
        this.state.template(
          phoneNumber.wabaId,
          spec['name'] as string,
          (spec['language'] as { code: string }).code,
        )!.category,
      )
    }

    // A deliberately forced error wins over the random rate: a scenario you
    // asked for must not be overridden by chance.
    // Tiers cap UNIQUE recipients per 24h, not messages: a business can send
    // thousands to known contacts and still be blocked by one new one.
    const tier = phoneNumber.messagingTier ?? 'TIER_UNLIMITED'
    if (!this.limits.allows(phoneNumberId, waId, tier, this.clock.now())) {
      throw new GraphError(ERROR_CODES.SPAM_RATE_LIMIT, {
        details: `This phone number has reached its messaging limit of ${TIER_CAPS[tier]} unique recipients in 24 hours (${tier}).`,
      })
    }

    const forced = this.scenario.takeForcedError()
    if (forced !== undefined) throw new GraphError(forced)
    if (this.scenario.shouldFailSend()) throw new GraphError(ERROR_CODES.INTERNAL)

    this.limits.record(phoneNumberId, waId, this.clock.now())

    const wamid = makeWamid(phoneNumberId, this.state.nextSeq())
    const { messaging_product: _mp, to: _to, type: _t, ...rest } = body

    this.state.recordOutbound({
      id: wamid,
      phoneNumberId,
      to: waId,
      type,
      payload: rest,
      sentAt: this.clock.now(),
    })

    // The other failure axis: the send is accepted and the app is told so, but
    // the webhooks never arrive. Silent, and the expensive one in production.
    if (!this.scenario.shouldDropWebhook()) {
      this.#scheduleStatuses(phoneNumberId, wamid, waId, category)
    }

    return {
      messaging_product: 'whatsapp',
      contacts: [{ input: rawTo, wa_id: waId }],
      messages: [{ id: wamid, message_status: 'accepted' }],
    }
  }

  // --- control: simulate a customer writing in ----------------------------

  /**
   * Deliver an inbound message webhook, as if a customer had written. Returns
   * the generated wamid so callers can correlate.
   */
  simulateInbound(options: {
    from: string
    phoneNumberId?: string
    contactName?: string
    message: InboundContent
  }): { messageId: string } {
    const phoneNumberId = options.phoneNumberId ?? this.state.defaultPhoneNumberId
    const phoneNumber = this.state.phoneNumber(phoneNumberId)
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
    this.windows.recordInbound(phoneNumberId, waId, this.clock.now())

    const messageId = makeWamid(phoneNumberId, this.state.nextSeq())
    const payload = buildInboundPayload({
      wabaId: phoneNumber.wabaId,
      phoneNumberId,
      displayPhoneNumber: phoneNumber.displayPhoneNumber,
      from: waId,
      ...(options.contactName !== undefined ? { contactName: options.contactName } : {}),
      messageId,
      timestampMs: this.clock.now(),
      message: options.message,
    })

    this.#enqueue(phoneNumberId, payload)
    return { messageId }
  }

  // --- templates (spec §5.3) ----------------------------------------------

  /** `POST /{waba_id}/message_templates`. New templates land PENDING. */
  createTemplate(wabaId: string, body: Record<string, unknown>): TemplateCreateResponse {
    this.#assertWaba(wabaId)

    const name = body['name']
    if (typeof name !== 'string' || !TEMPLATE_NAME_PATTERN.test(name)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: 'Param name must contain only lowercase letters, digits and underscores',
      })
    }

    const language = body['language']
    if (typeof language !== 'string' || language === '') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param language is required' })
    }

    const category = body['category']
    if (!isTemplateCategory(category)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Param category must be one of {${TEMPLATE_CATEGORIES.join(', ')}}`,
      })
    }

    // Meta answers a duplicate with an ERROR body whose text says "already
    // exists" — and every real integration treats that as success. Emitting the
    // error is what lets an integration test its own idempotent handling.
    if (this.state.template(wabaId, name, language)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        message: `Template name (${name}) already exists in ${language}`,
        details: `Template with name (${name}) already exists in language (${language}).`,
      })
    }

    const template: Template = {
      id: String(this.state.nextSeq() + 1_000_000_000_000_000),
      wabaId,
      name,
      language,
      category,
      status: 'PENDING',
      components: Array.isArray(body['components']) ? body['components'] : [],
    }
    this.state.putTemplate(template)

    return { id: template.id, status: template.status, category: template.category }
  }

  /** `GET /{waba_id}/message_templates`. */
  listTemplates(wabaId: string): { data: Template[] } {
    this.#assertWaba(wabaId)
    return { data: this.state.templatesForWaba(wabaId) }
  }

  /** `DELETE /{waba_id}/message_templates?name=…` — removes every language. */
  deleteTemplate(wabaId: string, name: string): { success: true } {
    this.#assertWaba(wabaId)
    if (this.state.deleteTemplatesByName(wabaId, name) === 0) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `No template named (${name}) exists on this WhatsApp Business Account`,
      })
    }
    return { success: true }
  }

  template(wabaId: string, name: string, language: string): Template | undefined {
    return this.state.template(wabaId, name, language)
  }

  /**
   * Control-API transition (spec §6.4) — what Meta's reviewers would do,
   * on demand. Scoped to one language on purpose.
   */
  transitionTemplate(
    wabaId: string,
    name: string,
    language: string,
    to: TemplateStatus,
  ): { success: true; status: TemplateStatus } {
    if (!TEMPLATE_STATUSES.includes(to)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Param to must be one of {${TEMPLATE_STATUSES.join(', ')}}`,
      })
    }

    const template = this.state.template(wabaId, name, language)
    if (!template) {
      throw new GraphError(ERROR_CODES.TEMPLATE_NOT_FOUND, {
        details: `template name (${name}) does not exist in ${language}`,
      })
    }

    this.state.putTemplate({ ...template, status: to })

    // Meta announces the outcome asynchronously — hours after submission, as a
    // webhook, never as a response to your API call. Integrations that only
    // react to their own calls never learn a template was approved or paused,
    // and find out when sends start failing.
    const anyNumber = this.state
      .phoneNumbers()
      .find((phoneNumber) => phoneNumber.wabaId === wabaId)
    if (anyNumber) {
      this.#enqueue(
        anyNumber.phoneNumberId,
        buildTemplateStatusPayload({
          wabaId,
          templateId: template.id,
          name,
          language,
          event: to,
          reason: TRANSITION_REASONS[to],
        }),
      )
    }

    return { success: true, status: to }
  }

  // --- tech provider mode (spec §9) ---------------------------------------

  /**
   * Control API: mint an Embedded Signup code plus the `phone_number_id` and
   * `waba_id` the real signup event carries alongside it, which the frontend
   * forwards to your backend.
   *
   * `subscribed: false` creates the tenant WITHOUT subscribing your app — the
   * state that makes inbound messages vanish silently (spec §9.3).
   */
  createSignup(options: { subscribed?: boolean } = {}): {
    code: string
    phone_number_id: string
    waba_id: string
  } {
    const seq = this.state.nextSeq()
    const wabaId = `WABA_TENANT_${seq}`
    const phoneNumberId = `PNID_TENANT_${seq}`

    this.state.registerWaba({
      wabaId,
      appId: this.state.defaultAppId,
      subscribedApps: options.subscribed === false ? new Set() : new Set([this.state.defaultAppId]),
    })
    this.state.registerPhoneNumber({
      phoneNumberId,
      wabaId,
      displayPhoneNumber: `1555000${String(seq).padStart(4, '0')}`,
    })

    const code = `AQD${randomBytes(16).toString('base64url')}`
    this.#signupCodes.set(code, { wabaId, phoneNumberId, used: false })
    return { code, phone_number_id: phoneNumberId, waba_id: wabaId }
  }

  /** `GET /{version}/oauth/access_token` — trade a signup code for a token. */
  exchangeCode(clientId: string, clientSecret: string, code: string): { access_token: string; token_type: string } {
    const app = this.state.app(clientId)
    if (!app || app.appSecret !== clientSecret) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        message: 'Invalid OAuth access token',
        details: 'The client_id or client_secret does not match a configured app.',
      })
    }

    const signup = this.#signupCodes.get(code)
    // Single-use. A retry that "works" would hide a double-connect, which in
    // production means two accounts pointed at one number.
    if (!signup || signup.used) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: 'This authorization code has been used or has expired.',
      })
    }
    signup.used = true

    const token = this.tokens.issue(
      { appId: clientId, kind: 'permanent', wabaId: signup.wabaId },
      this.clock.now(),
    )
    return { access_token: token, token_type: 'bearer' }
  }

  /** Control API: mint a token of a chosen kind, to exercise expiry and scopes. */
  issueToken(options: { kind?: 'permanent' | 'short' | 'long'; scopes?: string[] } = {}): {
    access_token: string
  } {
    return {
      access_token: this.tokens.issue(
        {
          appId: this.state.defaultAppId,
          kind: options.kind ?? 'permanent',
          ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
        },
        this.clock.now(),
      ),
    }
  }

  /** `GET /{version}/debug_token`. */
  debugToken(inputToken: string, appAccessToken: string): { data: DebugTokenData } {
    // Meta's app access token is literally `{app_id}|{app_secret}`.
    const [appId, appSecret] = appAccessToken.split('|')
    const app = appId ? this.state.app(appId) : undefined
    if (!app || app.appSecret !== appSecret) {
      throw new GraphError(ERROR_CODES.TOKEN_INVALID, {
        details: 'The access_token must be a valid app access token: {app-id}|{app-secret}',
      })
    }
    return { data: this.tokens.debug(inputToken, this.clock.now()) }
  }

  /** `POST /{waba_id}/subscribed_apps`. Without this, webhooks never arrive. */
  subscribeApp(wabaId: string, accessToken?: string): { success: true } {
    this.#assertWaba(wabaId)
    this.#assertScope(accessToken, 'whatsapp_business_management')

    const waba = this.state.waba(wabaId)!
    this.state.subscribeApp(wabaId, waba.appId)
    return { success: true }
  }

  listSubscribedApps(wabaId: string): { data: unknown[] } {
    this.#assertWaba(wabaId)
    const waba = this.state.waba(wabaId)!
    return {
      data: [...waba.subscribedApps].map((appId) => ({
        whatsapp_business_api_data: { id: appId, name: appId, link: `https://wamock.invalid/${appId}` },
      })),
    }
  }

  /** `GET /{version}/{phone_number_id}?fields=…`. Only requested fields come back. */
  getPhoneNumberFields(phoneNumberId: string, fields: string[]): Record<string, unknown> {
    const phoneNumber = this.state.phoneNumber(phoneNumberId)
    if (!phoneNumber) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Object with ID '${phoneNumberId}' does not exist`,
      })
    }

    const available: Record<string, unknown> = {
      display_phone_number: toDisplayPhoneNumber(phoneNumber.displayPhoneNumber),
      verified_name: 'wamock Test Business',
      quality_rating: phoneNumber.qualityRating ?? 'GREEN',
      messaging_limit_tier: phoneNumber.messagingTier ?? 'TIER_UNLIMITED',
      code_verification_status: 'VERIFIED',
      platform_type: 'CLOUD_API',
    }

    const requested = fields.length > 0 ? fields : Object.keys(available)
    const result: Record<string, unknown> = { id: phoneNumberId }
    for (const field of requested) {
      if (field in available) result[field] = available[field]
    }
    return result
  }

  /** Control API: change a number's quality rating and announce it. */
  setQuality(phoneNumberId: string, quality: QualityRating): { success: true } {
    const phoneNumber = this.state.phoneNumber(phoneNumberId)
    if (!phoneNumber) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Object with ID '${phoneNumberId}' does not exist`,
      })
    }

    this.state.updatePhoneNumber(phoneNumberId, { qualityRating: quality })
    this.#enqueue(
      phoneNumberId,
      buildQualityUpdatePayload({
        wabaId: phoneNumber.wabaId,
        displayPhoneNumber: toDisplayPhoneNumber(phoneNumber.displayPhoneNumber),
        quality,
        currentLimit: phoneNumber.messagingTier ?? 'TIER_UNLIMITED',
      }),
    )
    return { success: true }
  }

  /** Control API: set a number's messaging tier. */
  setTier(phoneNumberId: string, tier: MessagingTier): { success: true } {
    if (!this.state.phoneNumber(phoneNumberId)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Object with ID '${phoneNumberId}' does not exist`,
      })
    }
    this.state.updatePhoneNumber(phoneNumberId, { messagingTier: tier })
    return { success: true }
  }

  // --- media (spec §5.5, a stub by design) --------------------------------

  /**
   * `POST /{phone_number_id}/media`. No bytes are stored — the point is a
   * valid-looking id whose URL expires the way Meta's does.
   */
  uploadMedia(phoneNumberId: string, body: Record<string, unknown>): { id: string } {
    if (!this.state.phoneNumber(phoneNumberId)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Object with ID '${phoneNumberId}' does not exist`,
      })
    }
    const mimeType = body['type'] ?? body['mime_type']
    if (typeof mimeType !== 'string' || mimeType === '') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param type is required' })
    }

    const id = makeMediaId(this.state.nextSeq())
    this.#media.set(id, { id, mimeType, uploadedAt: this.clock.now() })
    return { id }
  }

  /**
   * `GET /{media_id}`. Meta's download URLs live about five minutes; an
   * integration that caches one and fetches it later gets a failure it never
   * saw in testing, so the expiry is reproduced rather than ignored.
   */
  getMedia(mediaId: string): Record<string, unknown> {
    const media = this.#media.get(mediaId)
    if (!media) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Object with ID '${mediaId}' does not exist`,
      })
    }
    if (this.clock.now() - media.uploadedAt >= MEDIA_URL_TTL_MS) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Media ID '${mediaId}' has expired. Media download URLs are valid for a limited time.`,
      })
    }

    return {
      messaging_product: 'whatsapp',
      id: media.id,
      mime_type: media.mimeType,
      url: `https://wamock.invalid/media/${media.id}`,
      sha256: createHash('sha256').update(media.id).digest('hex'),
      file_size: 1024,
    }
  }

  reset(): void {
    this.#media.clear()
    this.#signupCodes.clear()
    this.deliverer.clear()
    this.state.reset()
    this.windows.clear()
    this.scenario.reset()
    this.conversations.clear()
    this.tokens.clear()
    this.limits.clear()
  }

  // --- internals ----------------------------------------------------------

  #assertWaba(wabaId: string): void {
    if (!this.state.waba(wabaId)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        message: 'Unsupported post request',
        details: `Object with ID '${wabaId}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
      })
    }
  }

  #assertTypePayload(type: string, body: Record<string, unknown>): void {
    if (type === 'text') {
      const text = body['text'] as { body?: unknown } | undefined
      if (typeof text?.body !== 'string' || text.body === '') {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: 'Param text[body] is required for type text',
        })
      }
    }

    if (type === 'interactive') {
      validateInteractive(body['interactive'])
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
   * Resolve a template by the exact `name` + `language` pair and check it is
   * usable. Two distinct failures, because integrations treat them differently:
   *
   * - **132001** — no such template in that translation. Permanent; the fix is
   *   to submit and get it approved. Also what you get for a PENDING or
   *   REJECTED one: it exists in your dashboard but not for sending.
   * - **132015** — it was approved and Meta paused it for quality. Recoverable
   *   without a resubmission, so it deserves a different alert.
   */
  #assertTemplateSendable(wabaId: string, spec: Record<string, unknown>): void {
    const name = spec['name'] as string
    const language = (spec['language'] as { code: string }).code

    const template = this.state.template(wabaId, name, language)
    if (!template || template.status === 'PENDING' || template.status === 'REJECTED') {
      throw new GraphError(ERROR_CODES.TEMPLATE_NOT_FOUND, {
        details: `template name (${name}) does not exist in ${language}`,
      })
    }

    if (template.status === 'PAUSED' || template.status === 'DISABLED') {
      throw new GraphError(ERROR_CODES.TEMPLATE_PAUSED, {
        details: `template name (${name}) in ${language} is ${template.status}`,
      })
    }
  }

  #scheduleStatuses(
    phoneNumberId: string,
    wamid: string,
    recipientId: string,
    category: ConversationCategory,
  ): void {
    const conversation = this.conversations.open(
      phoneNumberId,
      recipientId,
      { category },
      this.clock.now(),
    )

    // Out-of-order means swapping the DELIVERY times, not relabelling the
    // statuses: `delivered` genuinely arrives first, which is what a receiver
    // sees in production and what breaks monotonic state machines.
    const order = this.scenario.config.outOfOrderStatuses
      ? ([
          ['sent', STATUS_DELAYS.delivered],
          ['delivered', STATUS_DELAYS.sent],
        ] as const)
      : ([
          ['sent', STATUS_DELAYS.sent],
          ['delivered', STATUS_DELAYS.delivered],
        ] as const)

    for (const [status, delay] of order) {
      const at = this.clock.now() + delay + this.scenario.latency()
      this.#enqueueStatus(phoneNumberId, {
        messageId: wamid,
        status,
        recipientId,
        timestampMs: at,
        conversation: this.conversations.toWebhookConversation(conversation),
        pricing: this.conversations.toWebhookPricing(conversation),
        atMs: at,
      })
    }
  }

  /**
   * Deliver a status webhook now (or at `atMs`), honouring the duplication
   * scenario. Meta is at-least-once; a receiver that assumes exactly-once
   * double-books, double-charges or double-replies.
   */
  #enqueueStatus(
    phoneNumberId: string,
    options: {
      messageId: string
      status: 'sent' | 'delivered' | 'read' | 'failed'
      recipientId: string
      timestampMs: number
      errorCode?: number
      conversation?: Record<string, unknown>
      pricing?: Record<string, unknown>
      atMs?: number
    },
  ): void {
    const phoneNumber = this.state.phoneNumber(phoneNumberId)!
    const payload = buildStatusPayload({
      wabaId: phoneNumber.wabaId,
      phoneNumberId,
      displayPhoneNumber: phoneNumber.displayPhoneNumber,
      messageId: options.messageId,
      status: options.status,
      recipientId: options.recipientId,
      timestampMs: options.timestampMs,
      ...(options.errorCode !== undefined ? { errorCode: options.errorCode } : {}),
      ...(options.conversation ? { conversation: options.conversation } : {}),
      ...(options.pricing ? { pricing: options.pricing } : {}),
    })

    const copies = this.scenario.config.duplicateWebhooks ? 2 : 1
    for (let i = 0; i < copies; i++) {
      this.#enqueue(phoneNumberId, payload, options.atMs)
    }
  }

  /**
   * Control API: drive a message to a specific status on demand (spec §6.2) —
   * the only way to test a `read` receipt or a delivery failure, since neither
   * happens on its own.
   */
  forceStatus(
    messageId: string,
    status: 'sent' | 'delivered' | 'read' | 'failed',
    errorCode?: number,
  ): { success: true } {
    const message = this.state.outbound().find((m) => m.id === messageId)
    if (!message) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `No message with id '${messageId}' was sent through this mock`,
      })
    }

    this.#enqueueStatus(message.phoneNumberId, {
      messageId,
      status,
      recipientId: message.to,
      timestampMs: this.clock.now(),
      ...(errorCode !== undefined ? { errorCode } : {}),
    })
    return { success: true }
  }

  #enqueue(
    phoneNumberId: string,
    payload: ReturnType<typeof buildStatusPayload>,
    atMs?: number,
  ): void {
    const phoneNumber = this.state.phoneNumber(phoneNumberId)
    if (!phoneNumber) return

    // Not subscribed → Meta delivers NOTHING for this WABA. No error, no
    // warning, just silence — which is exactly the diagnosis problem this
    // reproduces (spec §9.3). Emitting an error here would make the mock
    // easier and less useful.
    if (!this.state.isSubscribed(phoneNumber.wabaId)) return

    const appSecret = this.state.appSecretForPhoneNumber(phoneNumberId)
    // Unknown number → no secret → nothing to sign with. Callers validate the
    // number first, so reaching here means a bug, not a user error.
    if (!appSecret) return
    this.deliverer.enqueue(payload, {
      appSecret,
      ...(atMs !== undefined ? { atMs } : {}),
    })
  }

  #assertScope(accessToken: string | undefined, scope: string): void {
    // No token supplied → no scope check. Same reasoning as sendMessage: the
    // simple path must not require authentication it does not need.
    if (accessToken === undefined) return
    if (!this.tokens.isValid(accessToken, this.clock.now())) {
      throw new GraphError(ERROR_CODES.TOKEN_EXPIRED)
    }
    if (!this.tokens.hasScope(accessToken, scope)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        message: 'Permissions error',
        details: `The access token does not have the required permission: ${scope}`,
      })
    }
  }
}
