import { randomBytes } from 'node:crypto'

import type { MockContext } from '../core/context.js'
import { assertToken, requirePhoneNumber, requireWaba } from '../core/guards.js'
import { toDisplayPhoneNumber } from '../core/phone.js'
import type { DebugTokenData, TokenKind } from '../core/tokens.js'
import type { MessagingTier, QualityRating } from '../core/types.js'
import { ERROR_CODES, GraphError } from '../errors/graph-error.js'
import { buildQualityUpdatePayload } from '../webhooks/tech-payloads.js'

/**
 * Tech Provider mode (spec §9) — onboarding OTHER businesses onto your own
 * Meta app: embedded signup, token lifecycle, WABA subscription, quality and
 * messaging limits.
 *
 * This is the surface no other mock covers, and where the failures are silent
 * rather than loud: a token that expires two hours after connect, a WABA that
 * was never subscribed and therefore delivers nothing at all.
 */

interface SignupCode {
  wabaId: string
  phoneNumberId: string
  used: boolean
}

export class TechProviderService {
  readonly #context: MockContext
  readonly #signupCodes = new Map<string, SignupCode>()

  constructor(context: MockContext) {
    this.#context = context
  }

  /**
   * Mint an Embedded Signup code plus the `phone_number_id` and `waba_id` the
   * real signup event carries alongside it, which the frontend forwards to
   * your backend.
   *
   * `subscribed: false` creates the tenant WITHOUT subscribing your app — the
   * state that makes inbound messages vanish with no error anywhere.
   */
  createSignup(options: { subscribed?: boolean } = {}): {
    code: string
    phone_number_id: string
    waba_id: string
  } {
    const { state } = this.#context
    const seq = state.nextSeq()
    const wabaId = `WABA_TENANT_${seq}`
    const phoneNumberId = `PNID_TENANT_${seq}`

    state.registerWaba({
      wabaId,
      appId: state.defaultAppId,
      subscribedApps: options.subscribed === false ? new Set() : new Set([state.defaultAppId]),
    })
    state.registerPhoneNumber({
      phoneNumberId,
      wabaId,
      displayPhoneNumber: `1555000${String(seq).padStart(4, '0')}`,
    })

    const code = `AQD${randomBytes(16).toString('base64url')}`
    this.#signupCodes.set(code, { wabaId, phoneNumberId, used: false })
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
    const { state, dispatcher } = this.#context
    const phoneNumber = requirePhoneNumber(this.#context, phoneNumberId)

    state.updatePhoneNumber(phoneNumberId, { qualityRating: quality })
    dispatcher.dispatch(
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
    requirePhoneNumber(this.#context, phoneNumberId)
    this.#context.state.updatePhoneNumber(phoneNumberId, { messagingTier: tier })
    return { success: true }
  }

  clear(): void {
    this.#signupCodes.clear()
  }
}
