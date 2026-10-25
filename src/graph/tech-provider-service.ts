import { createHash } from 'node:crypto'

import type { MockContext } from '../core/context.js'
import { requirePhoneNumber, requireWaba } from '../core/guards.js'
import { freshNumericId, makeObjectId } from '../core/ids.js'
import { TIER_CAPS } from '../core/limits.js'
import { callingCodeOf, countryOf, toGraphDisplayNumber } from '../core/phone.js'
import type { DebugTokenData, TokenKind } from '../core/tokens.js'
import { isUnrated } from '../core/types.js'
import type { ConnectionStatus, MessagingTier, PhoneNumber, QualityRating } from '../core/types.js'
import { isWebUrl } from '../core/values.js'
import { pageOf } from './paging.js'
import { ERROR_CODES, GraphError, unsupportedRequest } from '../errors/graph-error.js'
import type { CoexistenceSeed, CoexistenceService } from './coexistence-service.js'
import { buildAccountUpdatePayload, buildAuthInternationalPayload } from '../webhooks/coexistence-payloads.js'
import { buildBusinessCapabilityPayload, buildThroughputUpgradePayload } from '../webhooks/tech-payloads.js'

/**
 * Tech Provider mode (spec §9) — onboarding OTHER businesses onto your own
 * Meta app: embedded signup, token lifecycle, WABA subscription, quality and
 * messaging limits.
 *
 * This is the surface no other mock covers, and where the failures are silent
 * rather than loud: a token that expires two hours after connect, a WABA that
 * was never subscribed and therefore delivers nothing at all.
 */

export interface PhoneNumberListOptions {
  fields?: string[]
  ascending?: boolean
  /** The `sort` as the caller wrote it, carried into `next` and `previous`. */
  sort?: string
  limit?: number
  after?: string
  before?: string
  /** Where `paging.next` and `previous` point: the mock's address over HTTP. */
  baseUrl?: string
  version?: string
}

/** "We will set your start times 30 days out" once a portfolio is eligible. */
const ELIGIBILITY_NOTICE_MS = 30 * 24 * 60 * 60 * 1000

/** Meta's limit on `override_callback_uri`, for a WABA and for a number. */
const CALLBACK_URI_MAX = 200


/** How a customer finished Embedded Signup, and what a test skips. */
export interface SignupOptions {
  /** Subscribe the app to the WABA, a step of its own with Meta. */
  subscribed?: boolean
  businessId?: string
  coexistence?: boolean
  /** The number the customer finished with: verified (default), unverified, or none. */
  phone?: 'verified' | 'unverified' | 'none'
  /** Register a verified number, a step of its own with Meta. */
  registered?: boolean
}

interface SignupCode {
  wabaId: string
  phoneNumberId?: string
  used: boolean
}

export class TechProviderService {
  readonly #context: MockContext
  readonly #signupCodes = new Map<string, SignupCode>()
  /** Throughput upgrades still finishing, cancelled by `clear()`. */
  readonly #timers = new Set<number>()
  /** Business app onboarding happens through signup; the rest lives there. */
  readonly #coexistence: CoexistenceService

  constructor(context: MockContext, coexistence: CoexistenceService) {
    this.#context = context
    this.#coexistence = coexistence
  }

  /**
   * Mint an Embedded Signup code plus the `phone_number_id` and `waba_id` the
   * real signup event carries alongside it, which the frontend forwards to
   * your backend.
   *
   * The tenant starts UNsubscribed, as with Meta: subscribing your app to the
   * customer's WABA is a step of its own after signup, and forgetting it makes
   * inbound messages vanish with no error anywhere. `subscribed: true` skips
   * that step for tests that are not about it.
   *
   * Each tenant is its own business portfolio unless `businessId` names one,
   * which puts the new number under that portfolio's shared messaging limit.
   *
   * `coexistence: true` onboards a number already in use on the WhatsApp
   * Business app, with whatever contacts and history the app holds.
   */
  createSignup(
    options: SignupOptions & CoexistenceSeed = {},
  ): {
    code: string
    phone_number_id?: string
    waba_id: string
  } {
    const { state } = this.#context
    // Checked before anything is minted: a refused signup leaves no tenant.
    if (options.coexistence === true && options.phone !== undefined && options.phone !== 'verified') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'A Business app number is already verified: coexistence takes no phone option' })
    }
    if (options.coexistence === true) this.#coexistence.assertSeed(options)
    // Every id settled before anything is inserted, or even counted: one that clashes is
    // refused while the state is still untouched. A portfolio named by the
    // caller may already exist (the signup joins it), but not as something else.
    const requested = options.businessId
    if (requested !== undefined && !state.business(requested) && state.isIdTaken(requested)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: `Id ${requested} belongs to another kind of object` })
    }
    // The tenant's own counter value: its display number and signup code.
    const seq = state.nextSeq()
    const claimed = new Set(requested !== undefined ? [requested] : [])
    const mint = () => {
      const id = freshNumericId(makeObjectId, () => state.nextSeq(), (candidate) => claimed.has(candidate) || state.isIdTaken(candidate))
      claimed.add(id)
      return id
    }
    const wabaId = mint()
    const phoneNumberId = mint()
    const businessId = requested ?? mint()
    if (!state.business(businessId)) state.registerBusiness(businessId)

    state.registerWaba({
      wabaId,
      appId: state.defaultAppId,
      businessId,
      subscribedApps: options.subscribed === true ? new Set([state.defaultAppId]) : new Set(),
    })
    // Since Embedded Signup v3 a customer can finish with a verified number,
    // an unverified one, or none (Meta's changelog). Signup verifies a number
    // but never registers it: that step is the partner's, except for a
    // Business app number, which is already on WhatsApp.
    const phone = options.coexistence === true ? 'verified' : (options.phone ?? 'verified')
    if (phone !== 'none') {
      const verified = phone === 'verified'
      state.registerPhoneNumber({
        phoneNumberId,
        wabaId,
        displayPhoneNumber: `1555000${String(seq).padStart(4, '0')}`,
        ...(verified ? {} : { verification: 'UNVERIFIED' as const }),
        registered: options.coexistence === true || (verified && options.registered === true),
      })
    }

    // Derived from the counter, not drawn at random: two identical runs must
    // mint identical codes, like every other id in wamock.
    const code = `AQD${createHash('sha256').update(`signup:${seq}`).digest('base64url').slice(0, 22)}`
    this.#signupCodes.set(code, { wabaId, ...(phone !== 'none' ? { phoneNumberId } : {}), used: false })

    // "Triggered whenever a customer successfully completes the Embedded
    // Signup flow": the partner learns of the new customer here, and for a
    // Business app number this is the converted Messaging account.
    this.#context.dispatcher.dispatchToWaba(
      wabaId,
      buildAccountUpdatePayload({
        wabaId,
        timeMs: this.#context.clock.now(),
        event: 'PARTNER_ADDED',
        ownerBusinessId: businessId,
      }),
    )

    if (options.coexistence === true) {
      this.#coexistence.onboard(phoneNumberId, {
        ...(options.shareHistory !== undefined ? { shareHistory: options.shareHistory } : {}),
        ...(options.contacts !== undefined ? { contacts: options.contacts } : {}),
        ...(options.history !== undefined ? { history: options.history } : {}),
      })
    }
    return { code, ...(phone !== 'none' ? { phone_number_id: phoneNumberId } : {}), waba_id: wabaId }
  }

  /** `GET /{version}/oauth/access_token` — trade a signup code for a token. */
  exchangeCode(
    clientId: string,
    clientSecret: string,
    code: string,
  ): { access_token: string; token_type: string } {
    const { clock, state, tokens } = this.#context

    const app = state.app(clientId)
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

    return {
      access_token: tokens.issue(
        { appId: clientId, kind: 'permanent', wabaId: signup.wabaId },
        clock.now(),
      ),
      token_type: 'bearer',
    }
  }

  /** Control API: mint a token of a chosen kind, to exercise expiry and scopes. */
  issueToken(options: { kind?: TokenKind; scopes?: string[] } = {}): { access_token: string } {
    const { clock, state, tokens } = this.#context
    return {
      access_token: tokens.issue(
        {
          appId: state.defaultAppId,
          kind: options.kind ?? 'permanent',
          ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
        },
        clock.now(),
      ),
    }
  }

  /** `GET /{version}/debug_token`. */
  debugToken(inputToken: string, appAccessToken: string): { data: DebugTokenData } {
    const { clock, state, tokens } = this.#context

    // Meta's app access token is literally `{app_id}|{app_secret}`.
    const [appId, appSecret] = appAccessToken.split('|')
    const app = appId ? state.app(appId) : undefined
    if (!app || app.appSecret !== appSecret) {
      throw new GraphError(ERROR_CODES.TOKEN_INVALID, {
        details: 'The access_token must be a valid app access token: {app-id}|{app-secret}',
      })
    }

    return { data: tokens.debug(inputToken, clock.now(), (id) => this.#appName(id)) }
  }

  /**
   * `POST /{waba_id}/subscribed_apps`. Without this, webhooks never arrive.
   * `override_callback_uri` sends this WABA's webhooks to another URL, which
   * must pass the verification handshake with `verify_token`; the two go
   * together.
   */
  subscribeApp(wabaId: string, body: Record<string, unknown> = {}): { success: true } {
    const waba = requireWaba(this.#context, wabaId)
    const override = this.callbackOverrideOf(body)
    this.#context.state.subscribeApp(wabaId, waba.appId, override)
    return { success: true }
  }

  /**
   * The `override_callback_uri` and `verify_token` of a subscribe body, checked
   * for form: the URI an http(s) URL of at most 200 characters, the token
   * present with it. Meta's reference words the first failure `Invalid
   * callback URI format`; that a URI over the limit fails the same way is an
   * inference, as the overrides page states the limit but not its error.
   */
  callbackOverrideOf(body: Record<string, unknown>): { url: string; verifyToken: string } | undefined {
    const url = body['override_callback_uri']
    const verifyToken = body['verify_token']
    if (url === undefined) return undefined
    if (typeof url !== 'string' || url.length > CALLBACK_URI_MAX || !isWebUrl(url)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        message: 'Invalid callback URI format',
        shape: { type: 'OAuthException', errorData: false, codePrefix: false },
      })
    }
    if (typeof verifyToken !== 'string' || verifyToken === '') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: 'Param verify_token is required with override_callback_uri',
      })
    }
    return { url, verifyToken }
  }

  /**
   * The `webhook_configuration` of `POST /{phone_number_id}`, checked for
   * form: an override for the number, or null when `override_callback_uri` is
   * an empty string, which removes it. Meta requires the app to be subscribed
   * to the WABA first. Of the other settings that call takes (two-step PIN,
   * search visibility…) wamock emulates none, and refuses them by name.
   */
  phoneCallbackOverrideOf(
    phoneNumberId: string,
    body: Record<string, unknown>,
  ): { url: string; verifyToken: string } | null {
    const phoneNumber = requirePhoneNumber(this.#context, phoneNumberId, 'post')
    // `access_token` is the call's authentication, read by the server, not a setting.
    const others = Object.keys(body).filter((key) => key !== 'webhook_configuration' && key !== 'access_token')
    if (others.length > 0) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `wamock emulates only webhook_configuration on POST /{phone_number_id}, not ${others.join(', ')}`,
      })
    }
    const configuration = body['webhook_configuration']
    if (typeof configuration !== 'object' || configuration === null || Array.isArray(configuration)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param webhook_configuration must be an object' })
    }
    const fields = configuration as Record<string, unknown>
    if (fields['override_callback_uri'] === '') return null
    if (!this.#context.state.isSubscribed(phoneNumber.wabaId)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Subscribe the app to WABA ${phoneNumber.wabaId} (POST /{waba_id}/subscribed_apps) before overriding a number's callback URL`,
      })
    }
    const override = this.callbackOverrideOf(fields)
    if (!override) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: 'Param webhook_configuration[override_callback_uri] is required',
      })
    }
    return override
  }

  /** Store, or with null remove, a number's callback override. */
  setPhoneCallbackOverride(phoneNumberId: string, override: { url: string; verifyToken: string } | null): { success: true } {
    requirePhoneNumber(this.#context, phoneNumberId, 'post')
    this.#context.state.setPhoneCallbackOverride(phoneNumberId, override ?? undefined)
    return { success: true }
  }

  /** `DELETE /{waba_id}/subscribed_apps`. Deliveries stop at once. */
  unsubscribeApp(wabaId: string): { success: true } {
    const waba = requireWaba(this.#context, wabaId, 'delete')
    this.#context.state.unsubscribeApp(wabaId, waba.appId)
    return { success: true }
  }

  listSubscribedApps(wabaId: string): { data: unknown[] } {
    const waba = requireWaba(this.#context, wabaId, 'get')
    return {
      data: [...waba.subscribedApps].map((appId) => ({
        whatsapp_business_api_data: {
          id: appId,
          name: this.#appName(appId),
          link: `https://wamock.invalid/${appId}`,
        },
        ...(appId === waba.appId && waba.callbackOverride
          ? { override_callback_uri: waba.callbackOverride.url }
          : {}),
      })),
    }
  }

  #appName(appId: string): string {
    return this.#context.state.app(appId)?.name ?? appId
  }

  /**
   * `GET /{version}/{waba_id}/phone_numbers` — every number on the WABA, as
   * Embedded Signup's finishing step reads them. Meta's default fields are
   * `verified_name`, `display_phone_number`, `id` and `quality_rating`; with
   * `fields`, only those come back, plus `id`. Most recently onboarded first,
   * or oldest first with `sort=['last_onboarded_time_ascending']`. wamock's
   * onboarding order is the order numbers were registered.
   */
  listPhoneNumbers(wabaId: string, options: PhoneNumberListOptions = {}): {
    data: Array<Record<string, unknown>>
    paging?: Record<string, unknown>
  } {
    requireWaba(this.#context, wabaId, 'get')
    const fields =
      options.fields !== undefined && options.fields.length > 0
        ? options.fields
        : ['verified_name', 'display_phone_number', 'quality_rating']
    const numbers = this.#context.state.phoneNumbers().filter((number) => number.wabaId === wabaId)
    const ordered = (options.ascending === true ? numbers : [...numbers].reverse()).map((n) => n.phoneNumberId)

    const link = (param: 'after' | 'before', cursor: string) => {
      const url = new URL(`${options.baseUrl ?? 'https://graph.facebook.com'}/${options.version ?? 'v26.0'}/${wabaId}/phone_numbers`)
      if (options.fields !== undefined && options.fields.length > 0) url.searchParams.set('fields', options.fields.join(','))
      if (options.sort !== undefined) url.searchParams.set('sort', options.sort)
      if (options.limit !== undefined) url.searchParams.set('limit', String(options.limit))
      url.searchParams.set(param, cursor)
      return url.toString()
    }
    // A cursor naming no number starts from the top: Meta documents no error
    // for this edge, unlike 131059 for templates.
    const fromTop = { defaultLimit: ordered.length, ...(options.limit !== undefined ? { limit: options.limit } : {}) }
    const page = pageOf(ordered, { ...options, ...fromTop }, link) ?? pageOf(ordered, fromTop, link)!
    const data = page.ids.map((id) => this.getPhoneNumberFields(id, fields))
    return page.paging ? { data, paging: page.paging } : { data }
  }

  #webhookConfiguration(phoneNumberId: string, wabaId: string): Record<string, string> {
    const { state, dispatcher } = this.#context
    const phoneNumber = state.phoneNumber(phoneNumberId)?.callbackOverride?.url
    const waba = state.waba(wabaId)?.callbackOverride?.url
    const application = dispatcher.appCallbackUrl()
    return {
      ...(phoneNumber !== undefined ? { phone_number: phoneNumber } : {}),
      ...(waba !== undefined ? { whatsapp_business_account: waba } : {}),
      ...(application !== undefined ? { application } : {}),
    }
  }

  /**
   * Control API: Meta deems a portfolio eligible for authentication-
   * international rates (in production, past 750K such messages in 30 days).
   * The start time is 30 days out unless given, as Meta sets it, and every
   * WABA of the portfolio hears of it, and of the primary location if set.
   */
  setAuthInternational(
    businessId: string,
    options: { startTime?: number; exceptions?: Array<{ country: string; startTime: number }>; primaryLocation?: string },
  ): { success: true } {
    const { state, clock, dispatcher } = this.#context
    if (!state.business(businessId)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: `Unknown business portfolio ${businessId}` })
    }
    const eligibility = {
      startTime: options.startTime ?? clock.now() + ELIGIBILITY_NOTICE_MS,
      exceptions: options.exceptions ?? [],
    }
    state.updateBusiness(businessId, {
      authInternational: eligibility,
      ...(options.primaryLocation !== undefined ? { primaryLocation: options.primaryLocation } : {}),
    })
    for (const waba of state.wabas().filter((w) => w.businessId === businessId)) {
      dispatcher.dispatchToWaba(
        waba.wabaId,
        buildAuthInternationalPayload({ wabaId: waba.wabaId, timeMs: clock.now(), event: 'AUTH_INTL_PRICE_ELIGIBILITY_UPDATE', ...eligibility }),
      )
      if (options.primaryLocation !== undefined) {
        dispatcher.dispatchToWaba(
          waba.wabaId,
          buildAuthInternationalPayload({
            wabaId: waba.wabaId,
            timeMs: clock.now(),
            event: 'BUSINESS_PRIMARY_LOCATION_COUNTRY_UPDATE',
            country: options.primaryLocation,
          }),
        )
      }
    }
    return { success: true }
  }

  /**
   * `GET /{version}/{waba_id}?fields=…`: `id`, and of the fields Meta's
   * authentication-international page reads here, each one that is set.
   */
  getWabaFields(wabaId: string, fields: string[]): Record<string, unknown> {
    const { state } = this.#context
    const waba = requireWaba(this.#context, wabaId, 'get')
    const business = state.business(waba.businessId)
    const eligibility = business?.authInternational
    const available: Record<string, unknown> = {
      ...(eligibility
        ? {
            auth_international_rate_eligibility: {
              start_time: Math.floor(eligibility.startTime / 1000),
              exception_countries: eligibility.exceptions.map((exception) => ({
                country_code: exception.country,
                start_time: Math.floor(exception.startTime / 1000),
              })),
            },
          }
        : {}),
      ...(business?.primaryLocation !== undefined ? { primary_business_location: business.primaryLocation } : {}),
    }
    const result: Record<string, unknown> = { id: wabaId }
    for (const field of fields) if (field in available) result[field] = available[field]
    return result
  }

  /** `GET /{version}/{phone_number_id}?fields=…`. Only requested fields come back. */
  getPhoneNumberFields(phoneNumberId: string, fields: string[]): Record<string, unknown> {
    const phoneNumber = this.#context.state.phoneNumber(phoneNumberId)
    if (!phoneNumber) throw unsupportedRequest('get', phoneNumberId)

    const limit = this.#context.state.business(this.#context.state.businessIdOf(phoneNumberId) ?? '')
      ?.messagingTier ?? 'TIER_UNLIMITED'
    // Values from the enums of Meta's phone-number reference, for a healthy
    // live number on the Cloud API.
    const available: Record<string, unknown> = {
      display_phone_number: toGraphDisplayNumber(phoneNumber.displayPhoneNumber),
      verified_name: phoneNumber.verifiedName ?? 'wamock Test Business',
      quality_rating: phoneNumber.qualityRating ?? 'GREEN',
      status: phoneNumber.status ?? 'CONNECTED',
      name_status: 'APPROVED',
      unified_cert_status: 'APPROVED',
      account_mode: 'LIVE',
      host_platform: 'CLOUD_API',
      is_official_business_account: false,
      country_code: countryOf(phoneNumber.displayPhoneNumber),
      ...(callingCodeOf(phoneNumber.displayPhoneNumber) !== undefined
        ? { country_dial_code: callingCodeOf(phoneNumber.displayPhoneNumber) }
        : {}),
      // The portfolio's limit, under the current field and the deprecated one
      // that Meta still answers. Both read the same value.
      whatsapp_business_manager_messaging_limit: limit,
      messaging_limit_tier: limit,
      code_verification_status: phoneNumber.verification ?? 'VERIFIED',
      platform_type: 'CLOUD_API',
      is_on_biz_app: this.#coexistence.isOnBizApp(phoneNumberId),
      // Meta's docs show `{ level: "STANDARD" }`; the level after an upgrade
      // is not documented, and `HIGH` is what third-party guides report.
      throughput: { level: phoneNumber.upgradedAt !== undefined && this.#context.clock.now() >= phoneNumber.upgradedAt ? 'HIGH' : 'STANDARD' },
      // Where this number's webhooks can go, each key only when set: its own
      // override, its WABA's, and the app's callback URL.
      webhook_configuration: this.#webhookConfiguration(phoneNumberId, phoneNumber.wabaId),
    }

    // Without `fields`, Meta's defaults; with them, those and `id`.
    const requested = fields.length > 0 ? fields : ['display_phone_number', 'verified_name', 'quality_rating']
    const result: Record<string, unknown> = { id: phoneNumberId }
    for (const field of requested) {
      if (field in available) result[field] = available[field]
    }
    return result
  }

  /**
   * Control API: change a number's quality rating.
   *
   * Silently, because that is what Meta does now: `phone_number_quality_update`
   * reports throughput and limit changes, and no current webhook carries a
   * number's quality rating. It is read with `?fields=quality_rating`.
   */
  setQuality(phoneNumberId: string, quality: QualityRating): { success: true } {
    requirePhoneNumber(this.#context, phoneNumberId)
    this.#context.state.updatePhoneNumber(phoneNumberId, { qualityRating: quality })
    return { success: true }
  }

  /**
   * Control API: Meta changing a number's `status`, read with
   * `?fields=status`. Silently, as quality: no webhook documents the change.
   */
  setPhoneStatus(phoneNumberId: string, status: ConnectionStatus): { success: true } {
    requirePhoneNumber(this.#context, phoneNumberId)
    this.#context.state.updatePhoneNumber(phoneNumberId, { status })
    return { success: true }
  }

  /**
   * Control API: set the messaging limit of the portfolio that owns this
   * number, and announce it with `business_capability_update` on every WABA
   * in that portfolio — every sibling number's limit changed with it.
   */
  setTier(phoneNumberId: string, tier: MessagingTier): { success: true } {
    const { state, clock, dispatcher } = this.#context
    requirePhoneNumber(this.#context, phoneNumberId)
    const businessId = state.businessIdOf(phoneNumberId) ?? state.defaultBusinessId
    state.setMessagingTier(businessId, tier)

    const cap = TIER_CAPS[tier]
    for (const waba of state.wabas().filter((w) => w.businessId === businessId)) {
      dispatcher.dispatchToWaba(
        waba.wabaId,
        buildBusinessCapabilityPayload({
          wabaId: waba.wabaId,
          maxDailyConversationsPerBusiness: Number.isFinite(cap) ? cap : -1,
          timeMs: clock.now(),
        }),
      )
    }
    return { success: true }
  }

  /**
   * Control API: Meta upgrades a number to higher throughput, 80 to 1,000
   * messages per second (Meta's throughput page). Eligible only with an
   * unlimited portfolio and a quality of YELLOW or better; the 100K unique
   * recipients a day Meta also asks for is the caller's to have simulated.
   * The upgrade takes up to a minute, during which the number answers 131057;
   * then `phone_number_quality_update` announces it.
   */
  upgradeThroughput(phoneNumberId: string): { success: true } {
    const { state, clock, dispatcher } = this.#context
    const phoneNumber = requirePhoneNumber(this.#context, phoneNumberId)
    const refuse = (details: string) => new GraphError(ERROR_CODES.INVALID_PARAMETER, { details })
    const businessId = state.businessIdOf(phoneNumberId) ?? state.defaultBusinessId
    if (state.business(businessId)?.messagingTier !== 'TIER_UNLIMITED') {
      throw refuse('Higher throughput needs a business portfolio with an unlimited messaging limit')
    }
    if (phoneNumber.qualityRating === 'RED' || isUnrated(phoneNumber.qualityRating)) {
      throw refuse('Higher throughput needs a quality rating of YELLOW or better')
    }
    if (this.#coexistence.isOnBizApp(phoneNumberId)) {
      throw refuse('A number shared with the WhatsApp Business app keeps a fixed throughput of 20 messages per second')
    }
    if (phoneNumber.upgradedAt !== undefined) throw refuse(`${phoneNumberId} is already on higher throughput`)

    const upgradedAt = clock.now() + THROUGHPUT_UPGRADE_MS
    state.registerPhoneNumber({ ...phoneNumber, upgradedAt })
    const timer = clock.at(upgradedAt, () => {
      this.#timers.delete(timer)
      const current = state.phoneNumber(phoneNumberId)
      if (!current) return
      dispatcher.dispatch(
        phoneNumberId,
        buildThroughputUpgradePayload({ wabaId: current.wabaId, displayPhoneNumber: current.displayPhoneNumber, timeMs: clock.now() }),
      )
    })
    this.#timers.add(timer)
    return { success: true }
  }

  clear(): void {
    this.#signupCodes.clear()
    for (const timer of this.#timers) this.#context.clock.clear(timer)
    this.#timers.clear()
  }
}

/** "The upgrade process itself can take up to 1 minute." */
const THROUGHPUT_UPGRADE_MS = 60 * 1000

/** Whether a number is mid-upgrade, answering 131057 to API requests. */
export const isInMaintenance = (phoneNumber: PhoneNumber, nowMs: number): boolean =>
  phoneNumber.upgradedAt !== undefined && nowMs < phoneNumber.upgradedAt
