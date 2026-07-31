import { MediaService } from '../graph/media-service.js'
import { MessagingService } from '../graph/messaging-service.js'
import type { SendMessageResponse, SimulateInboundOptions } from '../graph/messaging-service.js'
import { TechProviderService } from '../graph/tech-provider-service.js'
import { TemplateService } from '../graph/template-service.js'
import type { TemplateCreateResponse } from '../graph/template-service.js'
import { WebhookDeliverer } from '../webhooks/delivery.js'
import { WebhookDispatcher } from '../webhooks/dispatcher.js'
import { nullTransport } from '../webhooks/transport.js'
import type { WebhookTransport } from '../webhooks/transport.js'
import { VirtualClock } from './clock.js'
import type { MockContext } from './context.js'
import { Conversations } from './conversations.js'
import { makeFbtraceId } from './ids.js'
import { MessagingLimits } from './limits.js'
import { ScenarioController } from './scenario.js'
import { MockState } from './state.js'
import type { Template, TemplateStatus } from './templates.js'
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
  readonly conversations = new Conversations()
  readonly tokens = new TokenStore()
  readonly limits = new MessagingLimits()
  readonly dispatcher: WebhookDispatcher

  readonly #messaging: MessagingService
  readonly #templates: TemplateService
  readonly #media: MediaService
  readonly #techProvider: TechProviderService
  /** Set while `flush()` runs, so a re-entrant call cannot deadlock on itself. */
  #flushing = false

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
      conversations: this.conversations,
      tokens: this.tokens,
      limits: this.limits,
      dispatcher: this.dispatcher,
    }

    this.#templates = new TemplateService(context)
    // Messaging needs template lookups on the send path; the two collaborate
    // through a narrow interface rather than merging into one service.
    this.#messaging = new MessagingService(context, this.#templates)
    this.#media = new MediaService(context)
    this.#techProvider = new TechProviderService(context)
  }

  /** A deterministic `fbtrace_id` for the next error. */
  nextFbtraceId(): string {
    return makeFbtraceId(this.state.nextSeq())
  }

  /** Await any webhook deliveries the last `advance()` kicked off. */
  async settle(): Promise<void> {
    await this.deliverer.settle()
  }

  /**
   * `settle()`, but never longer than `timeoutMs`.
   *
   * Settling waits on the caller's own receiver, and a hung one must not be
   * able to freeze a test suite or hold an HTTP request open. The timer is
   * unref'd so this can never be the reason a process stays alive.
   */
  async settleWithin(timeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    })

    try {
      await Promise.race([this.settle(), expiry])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Deliver everything already due, then wait for the receiver to take it.
   *
   * Webhooks with no delay of their own — an inbound message, a quality change,
   * a template transition — are scheduled at the current instant, and a frozen
   * clock never reaches an instant on its own. Without this they sat there
   * until something moved time, which made `POST /__mock/quality` look like it
   * had failed to announce anything (#4). Both front doors call it, so the
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
  async flush(timeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS): Promise<void> {
    // A nested flush defers to the one already running. Handlers reply by
    // calling back into the mock, which flushes again from inside the delivery
    // the outer flush is awaiting; waiting here would deadlock both until the
    // timeout. The round loop below picks their work up anyway.
    if (this.#flushing) return
    this.#flushing = true
    try {
      const maxRounds = this.clock.frozen ? MAX_FLUSH_ROUNDS : 1
      for (let round = 0; round < maxRounds; round++) {
        const before = this.deliverer.deliveredCount()
        this.clock.advance(0)
        await this.settleWithin(timeoutMs)
        if (this.deliverer.deliveredCount() === before) return
      }
      if (this.clock.frozen) {
        throw new Error(
          `Webhook flush exceeded ${MAX_FLUSH_ROUNDS} rounds — a receiver is very likely answering every webhook with another one`,
        )
      }
    } finally {
      this.#flushing = false
    }
  }

  reset(): void {
    this.#media.clear()
    this.#techProvider.clear()
    this.deliverer.clear()
    this.state.reset()
    this.windows.clear()
    this.scenario.reset()
    this.conversations.clear()
    this.tokens.clear()
    this.limits.clear()
  }

  // --- messaging -----------------------------------------------------------

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

  forceStatus(
    messageId: string,
    status: 'sent' | 'delivered' | 'read' | 'failed',
    errorCode?: number,
  ): { success: true } {
    return this.#messaging.forceStatus(messageId, status, errorCode)
  }

  // --- templates -----------------------------------------------------------

  createTemplate(wabaId: string, body: Record<string, unknown>): TemplateCreateResponse {
    return this.#templates.create(wabaId, body)
  }

  listTemplates(wabaId: string): { data: Template[] } {
    return this.#templates.list(wabaId)
  }

  deleteTemplate(wabaId: string, name: string): { success: true } {
    return this.#templates.delete(wabaId, name)
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

  getMedia(mediaId: string): Record<string, unknown> {
    return this.#media.get(mediaId)
  }

  // --- tech provider -------------------------------------------------------

  createSignup(options: { subscribed?: boolean } = {}): {
    code: string
    phone_number_id: string
    waba_id: string
  } {
    return this.#techProvider.createSignup(options)
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

  subscribeApp(wabaId: string, accessToken?: string): { success: true } {
    return this.#techProvider.subscribeApp(wabaId, accessToken)
  }

  listSubscribedApps(wabaId: string): { data: unknown[] } {
    return this.#techProvider.listSubscribedApps(wabaId)
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
