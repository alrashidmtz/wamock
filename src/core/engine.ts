import { MediaService } from '../graph/media-service.js'
import { BlockService } from '../graph/block-service.js'
import { RegistrationService } from '../graph/registration-service.js'
import type { BlockListOptions } from '../graph/block-service.js'
import { CoexistenceService } from '../graph/coexistence-service.js'
import type { CoexistenceSeed } from '../graph/coexistence-service.js'
import { MessagingService } from '../graph/messaging-service.js'
import type { SendMessageResponse, SimulateInboundOptions } from '../graph/messaging-service.js'
import { TechProviderService, isInMaintenance } from '../graph/tech-provider-service.js'
import { ERROR_CODES, GraphError, unsupportedRequest } from '../errors/graph-error.js'
import type { PhoneNumberListOptions, SignupOptions } from '../graph/tech-provider-service.js'
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
import type { ConnectionStatus, MessagingTier, QualityRating } from './types.js'
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

/**
 * A wait that expires after `timeoutMs` of real time. The timer is unref'd so
 * it can never be the reason a process stays alive.
 */
function startBudget(timeoutMs: number): { expired: Promise<void>; isExpired(): boolean; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      expired = true
      resolve()
    }, timeoutMs)
    timer.unref?.()
  })
  return {
    expired: expiry,
    isExpired: () => expired,
    cancel: () => {
      if (timer) clearTimeout(timer)
    },
  }
}

const MESSAGING = 'whatsapp_business_messaging'
const MANAGEMENT = 'whatsapp_business_management'

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
  readonly #blocks: BlockService
  readonly #registration: RegistrationService
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
    this.#blocks = new BlockService(context)
    this.#registration = new RegistrationService(context)
    this.#messaging = new MessagingService(context, this.#templates, this.#coexistence, this.#media, this.#blocks)
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
    const budget = startBudget(timeoutMs)
    try {
      await Promise.race([this.settle(from), budget.expired])
    } finally {
      budget.cancel()
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
    // One budget for the whole flush, not one per round: a round that only
    // saw a stuck delivery start would otherwise buy another full wait, and a
    // receiver hanging on every reply could hold the call for 100 of them.
    const budget = startBudget(timeoutMs)
    try {
      const maxRounds = this.clock.frozen ? MAX_FLUSH_ROUNDS : 1
      for (let round = 0; round < maxRounds; round++) {
        // Progress: one of this call's attempts started or finished, or a
        // reset left new work in a fresh generation. Any of those may have
        // made more due now; nothing else is this call's to wait for.
        const before = this.deliverer.progressSince(since)
        this.clock.advance(0)
        await Promise.race([this.deliverer.settle(since), budget.expired])
        if (budget.isExpired()) return
        if (this.deliverer.progressSince(since) === before) return
      }
      if (this.clock.frozen) {
        throw new Error(
          `Webhook flush exceeded ${MAX_FLUSH_ROUNDS} rounds — a receiver is very likely answering every webhook with another one, or a WABA's callback keeps changing while its webhooks are delivered`,
        )
      }
    } finally {
      budget.cancel()
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
    this.#blocks.clear()
    this.#registration.clear()
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

  /**
   * A customer finishing Embedded Signup. With a number (the default, or
   * `phone: 'unverified'`) the result names it; with `phone: 'none'` there is
   * none to name.
   */
  createSignup(options: SignupOptions & { phone: 'none' } & CoexistenceSeed): { code: string; waba_id: string }
  createSignup(
    options?: SignupOptions & { phone?: 'verified' | 'unverified' } & CoexistenceSeed,
  ): { code: string; phone_number_id: string; waba_id: string }
  // For a `phone` known only at run time, as the control API has it.
  createSignup(options: SignupOptions & CoexistenceSeed): { code: string; phone_number_id?: string; waba_id: string }
  createSignup(options: SignupOptions & CoexistenceSeed = {}): { code: string; phone_number_id?: string; waba_id: string } {
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

  /** `POST /{waba_id}/phone_numbers`: a new, unverified number. */
  createPhoneNumber(wabaId: string, body: Record<string, unknown>): { id: string } {
    return this.#registration.create(wabaId, body)
  }

  /** `POST /{phone_number_id}/request_code`. */
  requestVerificationCode(phoneNumberId: string, params: Record<string, unknown>): { success: true } {
    return this.#registration.requestCode(phoneNumberId, params)
  }

  /** The code `request_code` last "sent" to a number, as its SMS would read it. */
  verificationCode(phoneNumberId: string): string | undefined {
    return this.#registration.verificationCode(phoneNumberId)
  }

  /** `POST /{phone_number_id}/verify_code`. */
  verifyCode(phoneNumberId: string, params: Record<string, unknown>): { success: true } {
    return this.#registration.verifyCode(phoneNumberId, params)
  }

  /** `POST /{phone_number_id}/register`. */
  registerPhoneNumber(phoneNumberId: string, body: Record<string, unknown>): { success: true } {
    return this.#registration.register(phoneNumberId, body)
  }

  /**
   * `POST /{phone_number_id}/deregister`. Meta: "You cannot use this endpoint
   * to deregister a business phone number that is in use with both Cloud API
   * and the WhatsApp Business app."
   */
  deregisterPhoneNumber(phoneNumberId: string): { success: true } {
    if (this.#coexistence.isOnBizApp(phoneNumberId)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: 'A number in use with both Cloud API and the WhatsApp Business app cannot be deregistered',
      })
    }
    return this.#registration.deregister(phoneNumberId)
  }

  /** `POST /{phone_number_id}/block_users`. */
  blockUsers(phoneNumberId: string, body: Record<string, unknown>): Record<string, unknown> {
    return this.#blocks.block(phoneNumberId, body)
  }

  /** `DELETE /{phone_number_id}/block_users`. */
  unblockUsers(phoneNumberId: string, body: Record<string, unknown>): Record<string, unknown> {
    return this.#blocks.unblock(phoneNumberId, body)
  }

  /** `GET /{phone_number_id}/block_users`. */
  listBlockedUsers(phoneNumberId: string, options: BlockListOptions = {}): { data: unknown[]; paging?: Record<string, unknown> } {
    return this.#blocks.list(phoneNumberId, options)
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
    assertToken(this.#context, accessToken, this.#scopesFor(access.objectId, access.edge))
    if (accessToken === undefined || access.objectId === undefined) return
    const grantedWaba = this.tokens.record(accessToken)?.wabaId
    if (grantedWaba === undefined) return
    const owner = this.#ownerWaba(access.objectId)
    if (owner !== undefined && owner !== grantedWaba) {
      throw unsupportedRequest(access.method ?? 'get', access.objectId)
    }
  }

  /**
   * Meta's throughput page: while a number is upgraded, "the number will not
   * be usable on our platform. If used in an API request, the API will return
   * error code 131057". The Graph door calls this for every request on a
   * number, after its token passed; the control API, which plays Meta, is not
   * held up.
   */
  assertNumberUsable(objectId: string): void {
    const phoneNumber = this.state.phoneNumber(objectId)
    if (phoneNumber && isInMaintenance(phoneNumber, this.clock.now())) throw new GraphError(ERROR_CODES.MAINTENANCE_MODE)
  }

  /**
   * The permissions a Graph call needs: whatsapp_business_messaging to send
   * and handle media, whatsapp_business_management to manage templates,
   * numbers and subscriptions, both to register a number. Calls outside them
   * are not checked: `smb_app_data`
   * (the coexistence sync) and `block_users`, for which Meta's pages name the
   * token kinds but not the permission. Ownership is still checked for them.
   */
  #scopesFor(objectId: string | undefined, edge: string | undefined): readonly string[] {
    // Registering and deregistering need both, per Meta's registration page.
    if (edge === 'register' || edge === 'deregister') return [MANAGEMENT, MESSAGING]
    if (edge === 'messages' || edge === 'media') return [MESSAGING]
    if (
      edge === 'message_templates' ||
      edge === 'phone_numbers' ||
      edge === 'subscribed_apps' ||
      edge === 'request_code' ||
      edge === 'verify_code'
    ) {
      return [MANAGEMENT]
    }
    if (edge !== undefined || objectId === undefined) return []
    if (this.#media.ownerOf(objectId) !== undefined) return [MESSAGING]
    if (this.state.phoneNumber(objectId) || this.state.waba(objectId)) return [MANAGEMENT]
    return []
  }

  /** The WABA an object belongs to: itself, its number's, or its media's. */
  #ownerWaba(objectId: string): string | undefined {
    if (this.state.waba(objectId)) return objectId
    const numberId = this.state.phoneNumber(objectId) ? objectId : this.#media.ownerOf(objectId)
    return numberId === undefined ? undefined : this.state.phoneNumber(numberId)?.wabaId
  }

  /** Control API: a portfolio deemed eligible for authentication-international rates. */
  setAuthInternational(
    businessId: string,
    options: { startTime?: number; exceptions?: Array<{ country: string; startTime: number }>; primaryLocation?: string } = {},
  ): { success: true } {
    return this.#techProvider.setAuthInternational(businessId, options)
  }

  getWabaFields(wabaId: string, fields: string[]): Record<string, unknown> {
    return this.#techProvider.getWabaFields(wabaId, fields)
  }

  getPhoneNumberFields(phoneNumberId: string, fields: string[]): Record<string, unknown> {
    return this.#techProvider.getPhoneNumberFields(phoneNumberId, fields)
  }

  /** Control API: Meta upgrades a number to higher throughput. */
  upgradeThroughput(phoneNumberId: string): { success: true } {
    return this.#techProvider.upgradeThroughput(phoneNumberId)
  }

  /** Control API: Meta changes the number's `status`. */
  setPhoneStatus(phoneNumberId: string, status: ConnectionStatus): { success: true } {
    return this.#techProvider.setPhoneStatus(phoneNumberId, status)
  }

  setQuality(phoneNumberId: string, quality: QualityRating): { success: true } {
    return this.#techProvider.setQuality(phoneNumberId, quality)
  }

  setTier(phoneNumberId: string, tier: MessagingTier): { success: true } {
    return this.#techProvider.setTier(phoneNumberId, tier)
  }
}
