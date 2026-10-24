import { createHash } from 'node:crypto'

import type { MockContext } from '../core/context.js'
import { assertToken, requirePhoneNumber, requireWaba } from '../core/guards.js'
import { TIER_CAPS } from '../core/limits.js'
import { toDisplayPhoneNumber } from '../core/phone.js'
import type { DebugTokenData, TokenKind } from '../core/tokens.js'
import type { MessagingTier, QualityRating } from '../core/types.js'
import { ERROR_CODES, GraphError } from '../errors/graph-error.js'
import type { CoexistenceSeed, CoexistenceService } from './coexistence-service.js'
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
   * `subscribed: false` creates the tenant WITHOUT subscribing your app — the
   * state that makes inbound messages vanish with no error anywhere.
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
      subscribedApps: options.subscribed === false ? new Set() : new Set([state.defaultAppId]),
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

    return { data: tokens.debug(inputToken, clock.now()) }
  }

  /** `POST /{waba_id}/subscribed_apps`. Without this, webhooks never arrive. */
  subscribeApp(wabaId: string, accessToken?: string): { success: true } {
    const waba = requireWaba(this.#context, wabaId)
    assertToken(this.#context, accessToken, 'whatsapp_business_management')

    this.#context.state.subscribeApp(wabaId, waba.appId)
    return { success: true }
  }

  listSubscribedApps(wabaId: string): { data: unknown[] } {
    const waba = requireWaba(this.#context, wabaId)
    return {
      data: [...waba.subscribedApps].map((appId) => ({
        whatsapp_business_api_data: {
          id: appId,
          name: appId,
          link: `https://wamock.invalid/${appId}`,
        },
      })),
    }
  }

  /** `GET /{version}/{phone_number_id}?fields=…`. Only requested fields come back. */
  getPhoneNumberFields(phoneNumberId: string, fields: string[]): Record<string, unknown> {
    const phoneNumber = this.#context.state.phoneNumber(phoneNumberId)
    if (!phoneNumber) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Object with ID '${phoneNumberId}' does not exist`,
      })
    }

    const limit = this.#context.state.business(this.#context.state.businessIdOf(phoneNumberId) ?? '')
      ?.messagingTier ?? 'TIER_UNLIMITED'
    const available: Record<string, unknown> = {
      display_phone_number: toDisplayPhoneNumber(phoneNumber.displayPhoneNumber),
      verified_name: 'wamock Test Business',
      quality_rating: phoneNumber.qualityRating ?? 'GREEN',
      // The portfolio's limit, under the current field and the deprecated one
      // that Meta still answers. Both read the same value.
      whatsapp_business_manager_messaging_limit: limit,
      messaging_limit_tier: limit,
      code_verification_status: 'VERIFIED',
      platform_type: 'CLOUD_API',
      is_on_biz_app: this.#coexistence.isOnBizApp(phoneNumberId),
    }

    const requested = fields.length > 0 ? fields : Object.keys(available)
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
