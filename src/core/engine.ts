import { MediaService } from '../graph/media-service.js'
import { CoexistenceService } from '../graph/coexistence-service.js'
import type { CoexistenceSeed } from '../graph/coexistence-service.js'
import { MessagingService } from '../graph/messaging-service.js'
import type { SendMessageResponse, SimulateInboundOptions } from '../graph/messaging-service.js'
import { TechProviderService } from '../graph/tech-provider-service.js'
import { ERROR_CODES, GraphError, unsupportedRequest } from '../errors/graph-error.js'
import type { PhoneNumberListOptions } from '../graph/tech-provider-service.js'
import { TemplateService } from '../graph/template-service.js'
import type { TemplateCreateResponse, TemplateListOptions } from '../graph/template-service.js'
import { WebhookDeliverer } from '../webhooks/delivery.js'
import { WebhookDispatcher } from '../webhooks/dispatcher.js'
import type { MessageStatus } from '../webhooks/payloads.js'
import { nullTransport } from '../webhooks/transport.js'
import type { WebhookTransport } from '../webhooks/transport.js'
import { VirtualClock } from './clock.js'
import type { MockContext } from './context.js'
import { assertToken, requireWaba } from './guards.js'
import { Pricing } from './pricing.js'
import { Users } from './users.js'
import { makeFbtraceId } from './ids.js'
import { MessagingLimits } from './limits.js'
import { ScenarioController } from './scenario.js'
import { MockState } from './state.js'
import type { Template, TemplateCategory, TemplateStatus, TemplateView } from './templates.js'
import type { DebugTokenData, TokenKind } from './tokens.js'
import { TokenStore } from './tokens.js'
import type { MessagingTier, QualityRating } from './types.js'
import { ServiceWindows } from './window.js'

/**
 * The mock, assembled.
 *
 * This class does two jobs and no others:
 *
 * 1. **Composition root.** It builds the collaborators — clock, state, webhook
 *    queue, scenario — wires them into a `MockContext`, and hands that context
 *    to the services. Nothing else knows how the pieces fit together.
 * 2. **Facade.** It is the one stable API for the three entry points (HTTP
 *    server, library mode, CLI), so they cannot drift apart.
 *
 * The behaviour lives in the services, one responsibility each:
 * `MessagingService`, `TemplateService`, `MediaService`, `TechProviderService`.
 * The delegating methods below are intentionally thin — when something needs
 * changing, change the service, not this file.
 */

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
  /** Cap on retained outbound messages before oldest-first eviction. */
  maxRecordedMessages?: number
}

export type { SendMessageResponse } from '../graph/messaging-service.js'
export type { TemplateCreateResponse } from '../graph/template-service.js'

/**
 * Long enough that any reasonable receiver finishes, short enough that a stuck
 * one does not look like a frozen test suite.
 */
export const DEFAULT_SETTLE_TIMEOUT_MS = 5_000

/**
 * Bound on `flush()`'s rounds. Each round only repeats because the previous one
 * delivered something, so reaching this means a receiver answers every webhook
 * with another one — an infinite loop that would otherwise hang forever.
 */
const MAX_FLUSH_ROUNDS = 100

export class WamockEngine {
  readonly clock: VirtualClock
  readonly state: MockState
  readonly deliverer: WebhookDeliverer
  readonly windows: ServiceWindows
  readonly scenario = new ScenarioController()
  readonly pricing = new Pricing()
  readonly users = new Users()
  readonly tokens = new TokenStore()
  readonly limits = new MessagingLimits()
  readonly dispatcher: WebhookDispatcher

  readonly #messaging: MessagingService
  readonly #templates: TemplateService
  readonly #media: MediaService
  readonly #techProvider: TechProviderService
  readonly #coexistence: CoexistenceService
  /** What every service is built from; the engine's own Graph checks use it too. */
  readonly #context: MockContext
  /** Whether a flush is running its rounds; see `flush()`. */
  #flushing = false
  /** Bumped by `reset()`, so a request that awaited across one can tell. */
  #epoch = 0
  /** Set while `flush()` runs, so a re-entrant call cannot deadlock on itself. */

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
      ...(options.maxRecordedMessages !== undefined
        ? { maxRecordedMessages: options.maxRecordedMessages }
        : {}),
    })
    this.deliverer = new WebhookDeliverer({
      clock: this.clock,
      transport: options.transport ?? nullTransport,
    })
    this.windows = new ServiceWindows(
      options.windowMs !== undefined ? { windowMs: options.windowMs } : {},
    )
    this.dispatcher = new WebhookDispatcher(this.state, this.deliverer, this.scenario)

    const context: MockContext = {
      clock: this.clock,
      state: this.state,
      scenario: this.scenario,
      windows: this.windows,
      pricing: this.pricing,
      users: this.users,
      tokens: this.tokens,
      limits: this.limits,
      dispatcher: this.dispatcher,
    }
    this.#context = context

    this.#templates = new TemplateService(context)
    // Messaging needs template lookups on the send path; the two collaborate
    // through a narrow interface rather than merging into one service.
    this.#coexistence = new CoexistenceService(context)
    this.#media = new MediaService(context)
    this.#messaging = new MessagingService(context, this.#templates, this.#coexistence, this.#media)
    this.#techProvider = new TechProviderService(context, this.#coexistence)
  }

  /** A deterministic `fbtrace_id` for the next error. */
  nextFbtraceId(): string {
    return makeFbtraceId(this.state.nextSeq())
  }

  /**
   * Await webhook deliveries in flight: all of them, or, with `from` (a
   * `deliverer.nextAttempt()` taken earlier), those that started since.
   */
  async settle(from = 0): Promise<void> {
    await this.deliverer.settle(from)
  }

  /**
   * `settle()`, but never longer than `timeoutMs`.
   *
   * Settling waits on the caller's own receiver, and a hung one must not be
   * able to freeze a test suite or hold an HTTP request open. The timer is
   * unref'd so this can never be the reason a process stays alive.
   */
  async settleWithin(timeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS, from = 0): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    })

    try {
      await Promise.race([this.settle(from), expiry])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Deliver everything already due, then wait for the receiver to take it.
   *
   * Webhooks with no delay of their own — an inbound message, a limit change,
   * a template transition — are scheduled at the current instant, and a frozen
   * clock never reaches an instant on its own. Without this they sat there
   * until something moved time, which made a control call look like it had
   * failed to announce anything (#4). Both front doors call it, so the
   * library and the control API cannot answer differently.
   *
   * When frozen, rounds repeat while deliveries keep happening, so a handler
   * that replies to a webhook has its reply delivered here too rather than in
   * some later `advance()`.
   *
   * A live clock takes exactly one round. Its background tick already fires
   * everything that comes due, so repeating would not be catching work nobody
   * else will do — it would be counting unrelated concurrent deliveries as
   * progress, and under steady traffic the loop never converges. Measured, not
   * guessed: it hit the round cap and answered a valid control call with a 400.
   */
  async flush(timeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS, from?: number): Promise<void> {
    // What this call set off: attempts starting from here, or from `from` when
    // the caller set things off just before (an advance, a control request).
    const since = from ?? this.deliverer.nextAttempt()

    // Only one flush runs the rounds. Another call made meanwhile — from a
    // handler, in-process or over HTTP, or from elsewhere — waits for the
    // deliveries it set off and leaves the rest to the running flush. Its
    // wait points forward only (attempts from `since` on), so it never waits
    // on the delivery it may be running inside of. Letting it run rounds of
    // its own instead made a receiver that answers every webhook through a
    // helper nest flushes without bound: measured, it ran out of memory.
    if (this.#flushing) return this.settleWithin(timeoutMs, since)
    this.#flushing = true
    try {
      const maxRounds = this.clock.frozen ? MAX_FLUSH_ROUNDS : 1
      for (let round = 0; round < maxRounds; round++) {
        // Progress: one of this call's attempts started or finished, or a
        // reset left new work in a fresh generation. Any of those may have
        // made more due now; nothing else is this call's to wait for.
        const before = this.deliverer.progressSince(since)
        this.clock.advance(0)
        await this.settleWithin(timeoutMs, since)
        if (this.deliverer.progressSince(since) === before) return
      }
      if (this.clock.frozen) {
        throw new Error(
          `Webhook flush exceeded ${MAX_FLUSH_ROUNDS} rounds — a receiver is very likely answering every webhook with another one, or a WABA's callback keeps changing while its webhooks are delivered`,
        )
      }
    } finally {
      this.#flushing = false
    }
  }

  /**
   * Move the clock and wait for what that set off — `mock.time.advance()`.
   *
   * A flush from before the advance, so it covers what the advance fired and
   * what that led to (replies, reroutes, retries that came due). It waits
   * only for attempts that start from here on, so a handler calling it never
   * waits for its own delivery or a sibling's.
   */
  async advanceAndSettle(ms: number, timeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS): Promise<void> {
    const since = this.deliverer.nextAttempt()
    this.clock.advance(ms)
    return this.flush(timeoutMs, since)
  }

  reset(): void {
    this.#epoch++
    this.#media.clear()
    this.#templates.clear()
    this.#coexistence.clear()
    this.#techProvider.clear()
    this.deliverer.clear()
    this.state.reset()
    this.windows.clear()
    this.scenario.reset()
    this.pricing.clear()
    this.users.clear()
    this.tokens.clear()
    this.limits.clear()
  }

  // --- messaging -----------------------------------------------------------

  /**
   * `POST /{version}/{phone_number_id}/messages`, whatever the body asks for.
   * The same route sends a message and marks one as read; Meta tells them
   * apart by `status: "read"`, and so does wamock.
   */
  postMessages(
    phoneNumberId: string,
    body: Record<string, unknown>,
    accessToken?: string,
  ): SendMessageResponse | { success: true } {
    return body['status'] === 'read'
      ? this.#messaging.markRead(phoneNumberId, body, accessToken)
      : this.#messaging.send(phoneNumberId, body, accessToken)
  }

  sendMessage(
    phoneNumberId: string,
    body: Record<string, unknown>,
    accessToken?: string,
  ): SendMessageResponse {
    return this.#messaging.send(phoneNumberId, body, accessToken)
  }

  simulateInbound(options: SimulateInboundOptions): { messageId: string } {
    return this.#messaging.simulateInbound(options)
  }

  setUserPreference(options: { from: string; value: 'stop' | 'resume'; phoneNumberId?: string }): {
    success: true
  } {
    return this.#messaging.setUserPreference(options)
  }

  changeUserNumber(options: { from: string; to: string; phoneNumberId?: string }): { success: true } {
    return this.#messaging.changeUserNumber(options)
  }

  forceStatus(
    messageId: string,
    status: MessageStatus,
    errorCode?: number,
  ): { success: true } {
    return this.#messaging.forceStatus(messageId, status, errorCode)
  }

  // --- templates -----------------------------------------------------------

  createTemplate(wabaId: string, body: Record<string, unknown>): TemplateCreateResponse {
    return this.#templates.create(wabaId, body)
  }

  listTemplates(wabaId: string, options: TemplateListOptions = {}): { data: TemplateView[]; paging?: Record<string, unknown> } {
    return this.#templates.list(wabaId, options)
  }

  deleteTemplate(wabaId: string, name: string): { success: true } {
    return this.#templates.delete(wabaId, name)
  }

  recategorizeTemplate(
    wabaId: string,
    name: string,
    language: string,
    options: { to: TemplateCategory; notice?: boolean },
  ): { success: true } {
    return this.#templates.recategorize(wabaId, name, language, options)
  }

  template(wabaId: string, name: string, language: string): Template | undefined {
    return this.#templates.find(wabaId, name, language)
  }

  transitionTemplate(
    wabaId: string,
    name: string,
    language: string,
    to: TemplateStatus,
  ): { success: true; status: TemplateStatus } {
    return this.#templates.transition(wabaId, name, language, to)
  }

  // --- media ---------------------------------------------------------------

  uploadMedia(phoneNumberId: string, body: Record<string, unknown>): { id: string } {
    return this.#media.upload(phoneNumberId, body)
  }

  getMedia(mediaId: string, options: { phoneNumberId?: string; baseUrl?: string } = {}): Record<string, unknown> {
    return this.#media.get(mediaId, options)
  }

  deleteMedia(mediaId: string, options: { phoneNumberId?: string } = {}): { success: true } {
    return this.#media.delete(mediaId, options)
  }

  /** The bytes behind a media URL this mock issued, or undefined (a 404). */
  downloadMedia(query: { mid?: string; ext?: string; hash?: string }): { bytes: Buffer; mimeType: string } | undefined {
    return this.#media.download(query)
  }

  // --- tech provider -------------------------------------------------------

  createSignup(
    options: { subscribed?: boolean; businessId?: string; coexistence?: boolean } & CoexistenceSeed = {},
  ): {
    code: string
    phone_number_id: string
    waba_id: string
  } {
    return this.#techProvider.createSignup(options)
  }

  // --- coexistence -------------------------------------------------------

  syncBusinessAppData(
    phoneNumberId: string,
    body: Record<string, unknown>,
  ): { messaging_product: 'whatsapp'; request_id: string } {
    return this.#coexistence.sync(phoneNumberId, body)
  }

  businessAppSend(options: { phoneNumberId: string; to: string; text: string }): { success: true } {
    return this.#coexistence.appSend(options)
  }

  businessAppContact(options: {
    phoneNumberId: string
    phone: string
    full_name?: string
    first_name?: string
    action?: 'add' | 'remove'
  }): { success: true } {
    return this.#coexistence.appContact(options)
  }

  businessAppOffboard(options: { phoneNumberId: string; reconnect?: boolean }): { success: true } {
    return this.#coexistence.appOffboard(options)
  }

  exchangeCode(
    clientId: string,
    clientSecret: string,
    code: string,
  ): { access_token: string; token_type: string } {
    return this.#techProvider.exchangeCode(clientId, clientSecret, code)
  }

  issueToken(options: { kind?: TokenKind; scopes?: string[] } = {}): { access_token: string } {
    return this.#techProvider.issueToken(options)
  }

  debugToken(inputToken: string, appAccessToken: string): { data: DebugTokenData } {
    return this.#techProvider.debugToken(inputToken, appAccessToken)
  }

  /** `body` may carry `override_callback_uri` with its `verify_token`. */
  subscribeApp(wabaId: string, body: Record<string, unknown> = {}): { success: true } {
    return this.#techProvider.subscribeApp(wabaId, body)
  }

  /**
   * `POST /{waba_id}/subscribed_apps` as the Graph route runs it: an override
   * callback must pass the verification handshake before the subscription is
   * accepted, as Meta verifies it. Without an HTTP transport there is no URL
   * to call, and the override is taken as given.
   */
  async subscribeAppVerified(wabaId: string, body: Record<string, unknown> = {}): Promise<{ success: true }> {
    requireWaba(this.#context, wabaId)
    const override = this.#techProvider.callbackOverrideOf(body)
    if (override) await this.#verifyOverride(override, wabaId)
    return this.subscribeApp(wabaId, body)
  }

  /**
   * `POST /{phone_number_id}` with `webhook_configuration`: a number's own
   * override, verified like a WABA's before it is stored. An empty
   * `override_callback_uri` removes it, with nothing to verify.
   */
  async configurePhoneNumber(phoneNumberId: string, body: Record<string, unknown>): Promise<{ success: true }> {
    const override = this.#techProvider.phoneCallbackOverrideOf(phoneNumberId, body)
    if (override) await this.#verifyOverride(override, phoneNumberId)
    return this.#techProvider.setPhoneCallbackOverride(phoneNumberId, override)
  }

  /**
   * The handshake Meta runs on an override before accepting it. The 422 and
   * its wording are the Subscribed Apps reference's; the phone number
   * reference documents the same check without an example, so a number's
   * override fails the same way.
   */
  async #verifyOverride(override: { url: string; verifyToken: string }, objectId: string): Promise<void> {
    const epoch = this.#epoch
    const result = await this.deliverer.verifyCallback(override.url, override.verifyToken)
    // A reset while the handshake ran removed the object this request named,
    // even if a new one now has the same id.
    if (epoch !== this.#epoch) throw unsupportedRequest('post', objectId)
    if (!result.ok) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        message: 'Webhook callback URL is not reachable or invalid',
        shape: { type: 'GraphMethodException', errorData: false, codePrefix: false, httpStatus: 422 },
      })
    }
  }

  unsubscribeApp(wabaId: string): { success: true } {
    return this.#techProvider.unsubscribeApp(wabaId)
  }

  listSubscribedApps(wabaId: string): { data: unknown[] } {
    return this.#techProvider.listSubscribedApps(wabaId)
  }

  listPhoneNumbers(
    wabaId: string,
    options: PhoneNumberListOptions = {},
  ): { data: Array<Record<string, unknown>>; paging?: Record<string, unknown> } {
    return this.#techProvider.listPhoneNumbers(wabaId, options)
  }

  /**
   * Validate the token a Graph call carries. Only tokens wamock issued are
   * checked; none at all, or one from elsewhere, passes. See core/guards.ts.
   *
   * - `scope`: the permission the endpoint needs.
   * - `objectId` and `method`: the object the call reads or writes. A business
   *   token from Embedded Signup is granted on its customer's WABA alone, so
   *   any other WABA, number or media is, to it, an object that "cannot be
   *   loaded due to missing permissions": Graph's unsupported-request error.
   */
  assertAccessToken(
    accessToken: string | undefined,
    access: { objectId?: string; edge?: string; method?: 'get' | 'post' | 'delete' } = {},
  ): void {
    assertToken(this.#context, accessToken, this.#scopeFor(access.objectId, access.edge))
    if (accessToken === undefined || access.objectId === undefined) return
    const grantedWaba = this.tokens.record(accessToken)?.wabaId
    if (grantedWaba === undefined) return
    const owner = this.#ownerWaba(access.objectId)
    if (owner !== undefined && owner !== grantedWaba) {
      throw unsupportedRequest(access.method ?? 'get', access.objectId)
    }
  }

  /**
   * The permission a Graph call needs: whatsapp_business_messaging to send and
   * handle media, whatsapp_business_management to manage templates, numbers
   * and subscriptions. Calls outside both are not checked: `smb_app_data`,
   * the coexistence sync, is the one left, and Meta's pages do not say which
   * permission it needs. Ownership is still checked for it.
   */
  #scopeFor(objectId: string | undefined, edge: string | undefined): string | undefined {
    if (edge === 'messages' || edge === 'media') return 'whatsapp_business_messaging'
    if (edge === 'message_templates' || edge === 'phone_numbers' || edge === 'subscribed_apps') {
      return 'whatsapp_business_management'
    }
    if (edge !== undefined || objectId === undefined) return undefined
    if (this.#media.ownerOf(objectId) !== undefined) return 'whatsapp_business_messaging'
    if (this.state.phoneNumber(objectId) || this.state.waba(objectId)) return 'whatsapp_business_management'
    return undefined
  }

  /** The WABA an object belongs to: itself, its number's, or its media's. */
  #ownerWaba(objectId: string): string | undefined {
    if (this.state.waba(objectId)) return objectId
    const numberId = this.state.phoneNumber(objectId) ? objectId : this.#media.ownerOf(objectId)
    return numberId === undefined ? undefined : this.state.phoneNumber(numberId)?.wabaId
  }

  getPhoneNumberFields(phoneNumberId: string, fields: string[]): Record<string, unknown> {
    return this.#techProvider.getPhoneNumberFields(phoneNumberId, fields)
  }

  setQuality(phoneNumberId: string, quality: QualityRating): { success: true } {
    return this.#techProvider.setQuality(phoneNumberId, quality)
  }

  setTier(phoneNumberId: string, tier: MessagingTier): { success: true } {
    return this.#techProvider.setTier(phoneNumberId, tier)
  }
}
