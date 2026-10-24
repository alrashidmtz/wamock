import { createHash } from 'node:crypto'

import type { MockContext } from '../core/context.js'
import { requirePhoneNumber, requireWaba } from '../core/guards.js'
import { TIER_CAPS } from '../core/limits.js'
import { callingCodeOf, countryOf, toGraphDisplayNumber } from '../core/phone.js'
import type { DebugTokenData, TokenKind } from '../core/tokens.js'
import type { MessagingTier, QualityRating } from '../core/types.js'
import { isWebUrl } from '../core/values.js'
import { pageOf } from './paging.js'
import { ERROR_CODES, GraphError, unsupportedRequest } from '../errors/graph-error.js'
import type { CoexistenceSeed, CoexistenceService } from './coexistence-service.js'
import { buildAccountUpdatePayload } from '../webhooks/coexistence-payloads.js'
import { buildBusinessCapabilityPayload } from '../webhooks/tech-payloads.js'

/**
 * Tech Provider mode (spec §9) — onboarding OTHER businesses onto your own
 * Meta app: embedded signup, token lifecycle, WABA subscription, quality and
 * messaging limits.
 *
 * This is the surface no other mock covers, and where the failures are silent
 * rather than loud: a token that expires two hours after connect, a WABA that
 * was never subscribed and therefore delivers nothing at all.
 */

/**
 * `base`, or `base_2`, `base_3`… if something already claimed it. A generated
 * id must never land on one a test registered by hand: registering it again
 * would overwrite that WABA or number, and a shared portfolio id would make
 * the tenant share someone else's messaging limit.
 */
function freshId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base
  let n = 2
  while (taken(`${base}_${n}`)) n++
  return `${base}_${n}`
}

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

/** Meta's limit on `override_callback_uri`, for a WABA and for a number. */
const CALLBACK_URI_MAX = 200


interface SignupCode {
  wabaId: string
  phoneNumberId: string
  used: boolean
}

export class TechProviderService {
  readonly #context: MockContext
  readonly #signupCodes = new Map<string, SignupCode>()
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
    options: { subscribed?: boolean; businessId?: string; coexistence?: boolean } & CoexistenceSeed = {},
  ): {
    code: string
    phone_number_id: string
    waba_id: string
  } {
    const { state } = this.#context
    const seq = state.nextSeq()
    const wabaId = freshId(`WABA_TENANT_${seq}`, (id) => !!state.waba(id))
    const phoneNumberId = freshId(`PNID_TENANT_${seq}`, (id) => !!state.phoneNumber(id))
    const businessId = options.businessId ?? freshId(`BUSINESS_TENANT_${seq}`, (id) => !!state.business(id))
    if (!state.business(businessId)) state.registerBusiness(businessId)

    state.registerWaba({
      wabaId,
      appId: state.defaultAppId,
      businessId,
      subscribedApps: options.subscribed === true ? new Set([state.defaultAppId]) : new Set(),
    })
    state.registerPhoneNumber({
      phoneNumberId,
      wabaId,
      displayPhoneNumber: `1555000${String(seq).padStart(4, '0')}`,
    })

    // Derived from the counter, not drawn at random: two identical runs must
    // mint identical codes, like every other id in wamock.
    const code = `AQD${createHash('sha256').update(`signup:${seq}`).digest('base64url').slice(0, 22)}`
    this.#signupCodes.set(code, { wabaId, phoneNumberId, used: false })

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
    return { code, phone_number_id: phoneNumberId, waba_id: wabaId }
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
    const others = Object.keys(body).filter((key) => key !== 'webhook_configuration')
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
      verified_name: 'wamock Test Business',
      quality_rating: phoneNumber.qualityRating ?? 'GREEN',
      status: 'CONNECTED',
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
      code_verification_status: 'VERIFIED',
      platform_type: 'CLOUD_API',
      is_on_biz_app: this.#coexistence.isOnBizApp(phoneNumberId),
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

  clear(): void {
    this.#signupCodes.clear()
  }
}
