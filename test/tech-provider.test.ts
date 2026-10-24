import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { createServer } from '../src/server.js'
import { verifySignature } from '../src/webhooks/signature.js'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

/**
 * Tech Provider mode (spec §9) — the surface no other mock covers.
 *
 * This is what you exercise when you onboard OTHER businesses onto your own
 * Meta app: embedded signup, token exchange, app subscription, per-tenant
 * webhook signing. Every failure below is one a real tech provider has hit.
 */

const EPOCH = 1_750_000_000_000
const HOUR = 60 * 60 * 1000
const PLATFORM_SECRET = 'platform-app-secret'
const CUSTOMER = '5215555000001'

let engine: WamockEngine
let app: FastifyInstance
let inbox: Array<{ body: string; signature: string | undefined }>

beforeEach(async () => {
  inbox = []
  engine = new WamockEngine({
    appSecret: PLATFORM_SECRET,
    mode: 'frozen',
    start: EPOCH,
    transport: async (d) => {
      inbox.push({ body: d.body, signature: d.signature })
    },
  })
  app = createServer(engine)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const post = async (url: string, payload: unknown = {}): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  })

const get = async (url: string): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'GET', url })

// --- §9.1 Embedded Signup --------------------------------------------------

describe('embedded signup and token exchange', () => {
  it('issues a signup code carrying the fields the frontend forwards', async () => {
    const res = await post('/__mock/embedded-signup', {})

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      code: expect.any(String),
      phone_number_id: expect.any(String),
      waba_id: expect.any(String),
    })
  })

  it('exchanges a valid code for a business access token', async () => {
    const signup = (await post('/__mock/embedded-signup', {})).json()

    const res = await get(
      `/v19.0/oauth/access_token?client_id=${engine.state.defaultAppId}` +
        `&client_secret=${PLATFORM_SECRET}&code=${signup.code}`,
    )

    expect(res.statusCode).toBe(200)
    expect(res.json().access_token).toEqual(expect.any(String))
  })

  it('refuses to exchange the same code twice', async () => {
    // Signup codes are single-use. A retry that "works" hides a double-connect.
    const signup = (await post('/__mock/embedded-signup', {})).json()
    const url =
      `/v19.0/oauth/access_token?client_id=${engine.state.defaultAppId}` +
      `&client_secret=${PLATFORM_SECRET}&code=${signup.code}`

    await get(url)
    const second = await get(url)

    expect(second.statusCode).toBe(400)
    expect(second.json().error.code).toBe(100)
  })

  it('rejects an unknown code', async () => {
    const res = await get(
      `/v19.0/oauth/access_token?client_id=${engine.state.defaultAppId}` +
        `&client_secret=${PLATFORM_SECRET}&code=made-up`,
    )
    expect(res.statusCode).toBe(400)
  })

  it('rejects the wrong client_secret — an app misconfiguration', async () => {
    const signup = (await post('/__mock/embedded-signup', {})).json()

    const res = await get(
      `/v19.0/oauth/access_token?client_id=${engine.state.defaultAppId}` +
        `&client_secret=wrong&code=${signup.code}`,
    )

    expect(res.statusCode).toBe(400)
  })

  it('requires all three query parameters', async () => {
    expect((await get('/v19.0/oauth/access_token?code=x')).statusCode).toBe(400)
  })
})

// --- §9.2 Token lifecycle --------------------------------------------------

describe('debug_token', () => {
  const appAccess = () => `${engine.state.defaultAppId}|${PLATFORM_SECRET}`

  it('reports a permanent System User token as expires_at 0', async () => {
    const token = (await post('/__mock/tokens', { kind: 'permanent' })).json().access_token

    const res = await get(
      `/v19.0/debug_token?input_token=${token}&access_token=${encodeURIComponent(appAccess())}`,
    )

    expect(res.json().data).toMatchObject({ is_valid: true, expires_at: 0 })
  })

  it('exposes a short Graph Explorer token as expiring soon', async () => {
    // This is the check that catches the token before it kills sends in
    // silence two hours later.
    const token = (await post('/__mock/tokens', { kind: 'short' })).json().access_token

    const data = (
      await get(
        `/v19.0/debug_token?input_token=${token}&access_token=${encodeURIComponent(appAccess())}`,
      )
    ).json().data

    expect(data.is_valid).toBe(true)
    expect(data.expires_at).toBeGreaterThan(0)
    expect(data.expires_at * 1000 - EPOCH).toBeLessThan(3 * HOUR)
  })

  it('reports an unknown token as invalid', async () => {
    const res = await get(
      `/v19.0/debug_token?input_token=nope&access_token=${encodeURIComponent(appAccess())}`,
    )
    expect(res.json().data.is_valid).toBe(false)
  })

  it('requires the app access token', async () => {
    expect((await get('/v19.0/debug_token?input_token=x')).statusCode).toBe(400)
  })
})

describe('§9.6.2 — the Graph Explorer token scenario', () => {
  it('sends fine at first and fails with 190 once the token expires', async () => {
    // Nothing changes except time. This is the most expensive silent bug in
    // WhatsApp integrations, and it is untestable without a virtual clock.
    const token = (await post('/__mock/tokens', { kind: 'short' })).json().access_token
    await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })

    const body = {
      messaging_product: 'whatsapp',
      to: CUSTOMER,
      type: 'text',
      text: { body: 'hi' },
    }
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/v19.0/${engine.state.defaultPhoneNumberId}/messages`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        payload: JSON.stringify(body),
      })

    expect((await send()).statusCode).toBe(200)

    await post('/__mock/time/advance', { ms: 3 * HOUR })
    await post('/__mock/inbound', { from: CUSTOMER, text: 'sigues?' })

    const later = await send()
    expect(later.statusCode).toBe(401)
    expect(later.json().error.code).toBe(190)
  })

  it('accepts a token wamock never issued — it is not an auth server', async () => {
    // Regression. wamock used to validate ANY supplied token, so a real client
    // sending its own credential got a 401 on every call. Every existing test
    // missed it because they all used tokens the mock had minted, or none.
    // A dogfood run against a production-shaped client caught it immediately.
    await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })

    const res = await app.inject({
      method: 'POST',
      url: `/v19.0/${engine.state.defaultPhoneNumberId}/messages`,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer EAAG-a-real-looking-token-from-someones-env-file',
      },
      payload: JSON.stringify({
        messaging_product: 'whatsapp',
        to: CUSTOMER,
        type: 'text',
        text: { body: 'hi' },
      }),
    })

    expect(res.statusCode).toBe(200)
  })

  it('still expires a token it DID issue, which is the scenario worth having', async () => {
    // The permissiveness above must not cost the §9.2 scenario.
    const token = (await post('/__mock/tokens', { kind: 'short' })).json().access_token
    await post('/__mock/time/advance', { ms: 3 * HOUR })
    await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })

    const res = await app.inject({
      method: 'POST',
      url: `/v19.0/${engine.state.defaultPhoneNumberId}/messages`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: JSON.stringify({
        messaging_product: 'whatsapp',
        to: CUSTOMER,
        type: 'text',
        text: { body: 'hi' },
      }),
    })

    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe(190)
  })

  it('leaves unauthenticated sends alone, so the simple case stays simple', async () => {
    // Most users never touch tokens. Requiring one would make the quickstart
    // three steps longer for no benefit.
    await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })
    const res = await post(`/v19.0/${engine.state.defaultPhoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: CUSTOMER,
      type: 'text',
      text: { body: 'hi' },
    })
    expect(res.statusCode).toBe(200)
  })
})

// --- §9.3 WABA subscription ------------------------------------------------

describe('§9.6.3 — a WABA that was never subscribed', () => {
  it('delivers nothing until the app subscribes, then delivers', async () => {
    // The documented integration failure: the number connects, the dashboard
    // looks right, and inbound messages never arrive. There is no error
    // anywhere — just silence.
    const signup = (await post('/__mock/embedded-signup', { subscribed: false })).json()

    await post('/__mock/inbound', { from: CUSTOMER, text: 'hola', phone_number_id: signup.phone_number_id })
    expect(inbox).toHaveLength(0)

    await post(`/v19.0/${signup.waba_id}/subscribed_apps`)

    await post('/__mock/inbound', { from: CUSTOMER, text: 'hola otra vez', phone_number_id: signup.phone_number_id })
    expect(inbox).toHaveLength(1)
  })

  it('reports subscribed_apps success the way Meta does', async () => {
    const res = await post(`/v19.0/${engine.state.defaultWabaId}/subscribed_apps`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true })
  })

  it('rejects subscribing an unknown WABA', async () => {
    expect((await post('/v19.0/WABA_GHOST/subscribed_apps')).statusCode).toBe(400)
  })

  it('rejects a token without the management scope', async () => {
    const token = (
      await post('/__mock/tokens', { kind: 'permanent', scopes: ['whatsapp_business_messaging'] })
    ).json().access_token

    const res = await app.inject({
      method: 'POST',
      url: `/v19.0/${engine.state.defaultWabaId}/subscribed_apps`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.error_data.details).toMatch(/whatsapp_business_management/)
  })

  it('lists the subscribed apps', async () => {
    const res = await get(`/v19.0/${engine.state.defaultWabaId}/subscribed_apps`)
    expect(res.json().data[0]).toMatchObject({
      whatsapp_business_api_data: { id: engine.state.defaultAppId },
    })
  })
})

describe('phone number lookup', () => {
  it('resolves display_phone_number from the object id', async () => {
    const res = await get(
      `/v19.0/${engine.state.defaultPhoneNumberId}?fields=display_phone_number`,
    )

    expect(res.statusCode).toBe(200)
    expect(res.json().display_phone_number).toMatch(/^\+/)
  })

  it('returns quality rating and messaging limit when asked', async () => {
    const res = await get(
      `/v19.0/${engine.state.defaultPhoneNumberId}?fields=quality_rating,whatsapp_business_manager_messaging_limit`,
    )

    expect(res.json()).toMatchObject({
      quality_rating: 'GREEN',
      whatsapp_business_manager_messaging_limit: 'TIER_UNLIMITED',
    })
  })

  it('does not return fields that were not requested', async () => {
    const res = await get(`/v19.0/${engine.state.defaultPhoneNumberId}?fields=quality_rating`)
    expect(res.json().display_phone_number).toBeUndefined()
  })
})

// --- §9.6.4 Cross-signing --------------------------------------------------

describe('§9.6.4 — two apps, two secrets', () => {
  it('signs each tenant’s webhooks with that tenant’s own app secret', async () => {
    // A tech provider hosts numbers for its own app AND for customers who
    // bring their own Meta app. Verifying every webhook with one secret works
    // right up until the second app exists.
    engine.state.registerApp({ appId: 'APP_TENANT', appSecret: 'tenant-app-secret' })
    engine.state.registerWaba({ wabaId: 'WABA_TENANT', appId: 'APP_TENANT' })
    engine.state.registerPhoneNumber({
      phoneNumberId: 'PNID_TENANT',
      wabaId: 'WABA_TENANT',
      displayPhoneNumber: '15550002222',
    })
    engine.state.subscribeApp('WABA_TENANT', 'APP_TENANT')

    await post('/__mock/inbound', { from: CUSTOMER, text: 'platform' })
    await post('/__mock/inbound', {
      from: CUSTOMER,
      text: 'tenant',
      phone_number_id: 'PNID_TENANT',
    })

    const [platform, tenant] = inbox
    expect(verifySignature({ appSecret: PLATFORM_SECRET, body: platform!.body, header: platform!.signature })).toBe(true)
    expect(verifySignature({ appSecret: 'tenant-app-secret', body: platform!.body, header: platform!.signature })).toBe(false)

    expect(verifySignature({ appSecret: 'tenant-app-secret', body: tenant!.body, header: tenant!.signature })).toBe(true)
    expect(verifySignature({ appSecret: PLATFORM_SECRET, body: tenant!.body, header: tenant!.signature })).toBe(false)
  })
})

// --- §9.4 Template status webhooks ----------------------------------------

describe('template_status_update webhooks', () => {
  it('notifies the app when Meta approves a template', async () => {
    // Approval is asynchronous in production: it lands hours later as a
    // webhook, not as a response to your submission.
    await post(`/v19.0/${engine.state.defaultWabaId}/message_templates`, {
      name: 'order_update',
      language: 'es_MX',
      category: 'UTILITY',
      components: [],
    })
    inbox.length = 0

    await post('/__mock/templates/order_update/es_MX/transition', { to: 'APPROVED' })

    const change = JSON.parse(inbox[0]!.body).entry[0].changes[0]
    expect(change.field).toBe('message_template_status_update')
    expect(change.value).toMatchObject({
      event: 'APPROVED',
      message_template_name: 'order_update',
      message_template_language: 'es_MX',
    })
  })

  it('reports a pause with the reason Meta gives', async () => {
    await post(`/v19.0/${engine.state.defaultWabaId}/message_templates`, {
      name: 'promo',
      language: 'es_MX',
      category: 'MARKETING',
      components: [],
    })
    await post('/__mock/templates/promo/es_MX/transition', { to: 'APPROVED' })
    inbox.length = 0

    await post('/__mock/templates/promo/es_MX/transition', { to: 'PAUSED' })

    expect(JSON.parse(inbox[0]!.body).entry[0].changes[0].value).toMatchObject({
      event: 'PAUSED',
      reason: expect.any(String),
    })
  })
})

// --- §9.5 Quality and messaging limits ------------------------------------

describe('quality rating', () => {
  it('changes the rating a phone number lookup reports', async () => {
    const res = await post('/__mock/quality', {
      phone_number_id: engine.state.defaultPhoneNumberId,
      quality_rating: 'RED',
    })

    expect(res.statusCode).toBe(200)
    const lookup = await get(`/v26.0/${engine.state.defaultPhoneNumberId}?fields=quality_rating`)
    expect(lookup.json().quality_rating).toBe('RED')
  })

  it('announces nothing: no current webhook carries a number’s quality rating', async () => {
    // phone_number_quality_update now reports throughput and messaging-limit
    // changes only. A receiver waiting on it for a quality downgrade waits
    // forever; the rating has to be polled.
    await post('/__mock/quality', {
      phone_number_id: engine.state.defaultPhoneNumberId,
      quality_rating: 'RED',
    })
    expect(inbox).toHaveLength(0)
  })

  it('rejects a rating outside Meta’s three', async () => {
    const res = await post('/__mock/quality', {
      phone_number_id: engine.state.defaultPhoneNumberId,
      quality_rating: 'PUCE',
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('messaging limits', () => {
  /** An approved template, so sends can go out with no service window open. */
  const approve = (wabaId: string = engine.state.defaultWabaId) => {
    engine.createTemplate(wabaId, {
      name: 'aviso',
      language: 'es_MX',
      category: 'UTILITY',
      components: [],
    })
    engine.transitionTemplate(wabaId, 'aviso', 'es_MX', 'APPROVED')
  }

  const sendTemplate = (to: string, phoneNumberId = engine.state.defaultPhoneNumberId) =>
    post(`/v26.0/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: 'aviso', language: { code: 'es_MX' } },
    })

  const sendText = (to: string) =>
    post(`/v26.0/${engine.state.defaultPhoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: 'hi' },
    })

  it('blocks a business-initiated send past the cap on unique recipients', async () => {
    // Limits count UNIQUE recipients reached outside a customer service
    // window per rolling 24h, not messages.
    approve()
    await post('/__mock/tier', { tier: 'TIER_2' })

    expect((await sendTemplate('5215555000001')).statusCode).toBe(200)
    expect((await sendTemplate('5215555000002')).statusCode).toBe(200)

    const third = await sendTemplate('5215555000003')
    expect(third.statusCode).toBe(400)
    expect(third.json().error.code).toBe(131048)
    expect(third.json().error.error_data.details).toMatch(/TIER_2/)
  })

  it('does not count a repeat recipient against the cap', async () => {
    approve()
    await post('/__mock/tier', { tier: 'TIER_1' })
    for (let i = 0; i < 5; i++) {
      expect((await sendTemplate(CUSTOMER)).statusCode).toBe(200)
    }
  })

  it('does not count replies inside a customer service window at all', async () => {
    // Answering customers who wrote first is never capped. A mock that
    // counted these would block support traffic Meta lets through.
    await post('/__mock/tier', { tier: 'TIER_1' })
    for (const customer of ['5215555000001', '5215555000002', '5215555000003']) {
      await post('/__mock/inbound', { from: customer, text: 'hola' })
      expect((await sendText(customer)).statusCode).toBe(200)
    }
    expect(engine.limits.used(engine.state.businessIdOf(engine.state.defaultPhoneNumberId)!, engine.clock.now())).toBe(0)
  })

  it('still lets you reply to a customer once the cap is used up', async () => {
    // The cap stops NEW outreach. A customer who wrote first can always be
    // answered, even when business-initiated sends have exhausted the limit.
    approve()
    await post('/__mock/tier', { tier: 'TIER_1' })
    expect((await sendTemplate('5215555000001')).statusCode).toBe(200)
    expect((await sendTemplate('5215555000002')).statusCode).toBe(400)

    await post('/__mock/inbound', { from: '5215555000002', text: 'hola' })
    expect((await sendText('5215555000002')).statusCode).toBe(200)
  })

  it('does not count a template sent into an open window either', async () => {
    approve()
    await post('/__mock/tier', { tier: 'TIER_1' })
    await post('/__mock/inbound', { from: '5215555000001', text: 'hola' })
    expect((await sendTemplate('5215555000001')).statusCode).toBe(200)
    expect((await sendTemplate('5215555000002')).statusCode).toBe(200)
  })

  it('frees the cap once the 24h period rolls over', async () => {
    approve()
    await post('/__mock/tier', { tier: 'TIER_1' })
    expect((await sendTemplate('5215555000001')).statusCode).toBe(200)
    expect((await sendTemplate('5215555000002')).statusCode).toBe(400)

    await post('/__mock/time/advance', { ms: 25 * HOUR })
    expect((await sendTemplate('5215555000002')).statusCode).toBe(200)
  })

  it('shares one cap across every number in the business portfolio', async () => {
    // Set at portfolio level since 2025-10-08: one busy number can consume
    // the whole portfolio's capacity and block its siblings.
    const signup = engine.createSignup({ businessId: engine.state.businessIdOf(engine.state.defaultPhoneNumberId)! })
    approve()
    approve(signup.waba_id)
    await post('/__mock/tier', { tier: 'TIER_1' })

    expect((await sendTemplate('5215555000001')).statusCode).toBe(200)
    const sibling = await sendTemplate('5215555000002', signup.phone_number_id)
    expect(sibling.statusCode).toBe(400)
    expect(sibling.json().error.code).toBe(131048)
  })

  it('puts a signup under an existing portfolio over HTTP too', async () => {
    approve()
    await post('/__mock/tier', { tier: 'TIER_1' })
    const signup = (
      await post('/__mock/embedded-signup', { business_id: engine.state.defaultBusinessId })
    ).json()
    approve(signup.waba_id)

    expect((await sendTemplate('5215555000001')).statusCode).toBe(200)
    expect((await sendTemplate('5215555000002', signup.phone_number_id)).statusCode).toBe(400)
  })

  it('never drops a generated tenant into a portfolio someone named on purpose', async () => {
    // A tenant named BUSINESS_TENANT_2 by hand must not swallow the next
    // generated tenant whose sequence happens to be 2.
    const named = engine.createSignup({ businessId: 'BUSINESS_TENANT_2' })
    const generated = engine.createSignup()

    expect(engine.state.businessIdOf(generated.phone_number_id)).not.toBe(
      engine.state.businessIdOf(named.phone_number_id),
    )
  })

  it('never overwrites a WABA or number registered by hand', async () => {
    const seq = engine.createSignup().waba_id.replace('WABA_TENANT_', '')
    const next = Number(seq) + 1
    engine.state.registerWaba({ wabaId: `WABA_TENANT_${next}`, appId: engine.state.defaultAppId })
    engine.state.registerPhoneNumber({
      phoneNumberId: `PNID_TENANT_${next}`,
      wabaId: `WABA_TENANT_${next}`,
      displayPhoneNumber: '15559990000',
    })

    const generated = engine.createSignup()
    expect(generated.waba_id).not.toBe(`WABA_TENANT_${next}`)
    expect(generated.phone_number_id).not.toBe(`PNID_TENANT_${next}`)
    expect(engine.state.phoneNumber(`PNID_TENANT_${next}`)?.displayPhoneNumber).toBe('15559990000')
  })

  it('keeps separate caps for separate portfolios', async () => {
    const signup = engine.createSignup()
    approve()
    approve(signup.waba_id)
    await post('/__mock/tier', { tier: 'TIER_1' })

    expect((await sendTemplate('5215555000001')).statusCode).toBe(200)
    expect((await sendTemplate('5215555000002', signup.phone_number_id)).statusCode).toBe(200)
  })

  it('reports the portfolio limit under the current field and the deprecated one', async () => {
    await post('/__mock/tier', { tier: 'TIER_2K' })
    const res = await get(
      `/v26.0/${engine.state.defaultPhoneNumberId}?fields=whatsapp_business_manager_messaging_limit,messaging_limit_tier`,
    )
    expect(res.json()).toEqual({
      id: engine.state.defaultPhoneNumberId,
      whatsapp_business_manager_messaging_limit: 'TIER_2K',
      messaging_limit_tier: 'TIER_2K',
    })
  })

  it('announces a limit change with business_capability_update', async () => {
    await post('/__mock/tier', { tier: 'TIER_2K' })

    const payload = JSON.parse(inbox[0]!.body)
    expect(payload.entry[0].id).toBe(engine.state.defaultWabaId)
    expect(payload.entry[0].time).toBe(Math.floor(EPOCH / 1000))
    expect(payload.entry[0].changes[0]).toEqual({
      field: 'business_capability_update',
      value: { max_daily_conversations_per_business: 2000 },
    })
  })

  it('announces a limit change on every WABA in the portfolio, numbers or not', async () => {
    // Account-level webhooks belong to the WABA. Routing them through "some
    // phone number on it" silently skipped a WABA that has none yet.
    engine.state.registerWaba({
      wabaId: 'WABA_EMPTY',
      appId: engine.state.defaultAppId,
      subscribedApps: new Set([engine.state.defaultAppId]),
    })
    await post('/__mock/tier', { tier: 'TIER_2K' })

    const announced = inbox.map((d) => JSON.parse(d.body).entry[0].id).sort()
    expect(announced).toEqual([engine.state.defaultWabaId, 'WABA_EMPTY'].sort())
  })

  it('does not announce to a WABA in the portfolio that is unsubscribed', async () => {
    engine.state.registerWaba({ wabaId: 'WABA_SILENT', appId: engine.state.defaultAppId })
    await post('/__mock/tier', { tier: 'TIER_2K' })
    expect(inbox.map((d) => JSON.parse(d.body).entry[0].id)).toEqual([engine.state.defaultWabaId])
  })

  it('reports unlimited as -1', async () => {
    await post('/__mock/tier', { tier: 'TIER_250' })
    inbox.length = 0
    await post('/__mock/tier', { tier: 'TIER_UNLIMITED' })
    expect(JSON.parse(inbox[0]!.body).entry[0].changes[0].value).toEqual({
      max_daily_conversations_per_business: -1,
    })
  })

  it('no longer accepts TIER_1K, which Meta replaced with TIER_2K', async () => {
    expect((await post('/__mock/tier', { tier: 'TIER_1K' })).statusCode).toBe(400)
  })

  it('is unlimited by default, so the simple case is never blocked', async () => {
    await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })
    const res = await post(`/v19.0/${engine.state.defaultPhoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: CUSTOMER,
      type: 'text',
      text: { body: 'hi' },
    })
    expect(res.statusCode).toBe(200)
  })
})

// --- §9.6.1 The happy path -------------------------------------------------

describe('§9.6.1 — onboarding, end to end', () => {
  it('walks signup → exchange → subscribe → template → approval → first send', async () => {
    const signup = (await post('/__mock/embedded-signup', { subscribed: false })).json()

    const token = (
      await get(
        `/v19.0/oauth/access_token?client_id=${engine.state.defaultAppId}` +
          `&client_secret=${PLATFORM_SECRET}&code=${signup.code}`,
      )
    ).json().access_token
    expect(token).toEqual(expect.any(String))

    // Without this, the tenant's webhooks never arrive — silently.
    expect((await post(`/v19.0/${signup.waba_id}/subscribed_apps`)).statusCode).toBe(200)

    const created = await post(`/v19.0/${signup.waba_id}/message_templates`, {
      name: 'bienvenida',
      language: 'es_MX',
      category: 'UTILITY',
      components: [],
    })
    expect(created.json().status).toBe('PENDING')

    inbox.length = 0
    await post(`/__mock/templates/bienvenida/es_MX/transition?waba_id=${signup.waba_id}`, {
      to: 'APPROVED',
    })
    expect(JSON.parse(inbox[0]!.body).entry[0].changes[0].field).toBe(
      'message_template_status_update',
    )

    const sent = await post(`/v19.0/${signup.phone_number_id}/messages`, {
      messaging_product: 'whatsapp',
      to: CUSTOMER,
      type: 'template',
      template: { name: 'bienvenida', language: { code: 'es_MX' }, components: [] },
    })
    expect(sent.statusCode).toBe(200)
    expect(sent.json().messages[0].id).toMatch(/^wamid\./)
  })
})

describe('signup codes are deterministic', () => {
  it('mints the same code in two identical runs', () => {
    const codeOf = () => new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH }).createSignup().code
    expect(codeOf()).toBe(codeOf())
  })
})
