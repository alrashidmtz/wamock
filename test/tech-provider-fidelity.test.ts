import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { createServer } from '../src/server.js'
import type { WebhookDelivery } from '../src/webhooks/transport.js'
import type { FastifyInstance } from 'fastify'

/**
 * The Tech Provider surface as Meta's references describe it: business tokens
 * that reach only their own customer, permissions per endpoint, the full
 * debug_token, subscription as an explicit step (with DELETE and callback
 * overrides), and the phone-number list with Meta's default fields, cursors
 * and sort.
 */

const EPOCH = 1_750_000_000_000
const SECRET = 'platform-secret'

let engine: WamockEngine
let app: FastifyInstance
let deliveries: WebhookDelivery[]
/** Message webhooks only: every signup also tells the partner PARTNER_ADDED. */
const messageDeliveries = () => deliveries.filter((d) => d.payload.entry[0]!.changes[0]!.field === 'messages')

beforeEach(async () => {
  deliveries = []
  engine = new WamockEngine({ appSecret: SECRET, mode: 'frozen', start: EPOCH, transport: async (d) => void deliveries.push(d) })
  app = createServer(engine)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, token?: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  })

/** Sign a tenant up and exchange its code, as a tech provider's backend does. */
function onboard() {
  // Registered: these tests are about tokens, subscriptions and routing.
  const signup = engine.createSignup({ registered: true })
  const { access_token: token } = engine.exchangeCode(engine.state.defaultAppId, SECRET, signup.code)
  return { ...signup, token }
}

describe('business tokens reach only their own customer', () => {
  it('lets a tenant’s token read its own number and refuses another tenant’s', async () => {
    const a = onboard()
    const b = onboard()

    expect((await call('GET', `/v26.0/${a.waba_id}/phone_numbers`, a.token)).statusCode).toBe(200)
    const foreign = await call('GET', `/v26.0/${b.waba_id}/phone_numbers`, a.token)
    expect(foreign.statusCode).toBe(400)
    expect(foreign.json().error).toMatchObject({ code: 100, error_subcode: 33, type: 'GraphMethodException' })

    expect((await call('GET', `/v26.0/${b.phone_number_id}?fields=id`, a.token)).statusCode).toBe(400)
    expect((await call('POST', `/v26.0/${b.waba_id}/subscribed_apps`, a.token, {})).statusCode).toBe(400)
    expect(
      (
        await call('POST', `/v26.0/${b.phone_number_id}/messages`, a.token, {
          messaging_product: 'whatsapp',
          to: '5215555000001',
          type: 'text',
          text: { body: 'x' },
        })
      ).json().error.error_subcode,
    ).toBe(33)
  })

  it('applies to media too: another tenant’s media id is not there for this token', async () => {
    const a = onboard()
    const b = onboard()
    const { id } = engine.uploadMedia(b.phone_number_id, {
      messaging_product: 'whatsapp',
      type: 'image/jpeg',
      file: { bytes: Buffer.from('x') },
    })
    expect((await call('GET', `/v26.0/${id}`, a.token)).json().error.error_subcode).toBe(33)
    expect((await call('GET', `/v26.0/${id}`, b.token)).statusCode).toBe(200)
  })

  it('checks the object the route decodes, so percent-encoding is no way around it', async () => {
    const a = onboard()
    const b = onboard()
    const encoded = (id: string) => `%${id.charCodeAt(0).toString(16).toUpperCase()}${id.slice(1)}`
    expect((await call('GET', `/v26.0/${encoded(b.phone_number_id)}?fields=id`, a.token)).json().error.error_subcode).toBe(33)
    expect((await call('DELETE', `/v26.0/${encoded(b.waba_id)}/subscribed_apps`, a.token)).statusCode).toBe(400)

    const { access_token: none } = engine.issueToken({ scopes: [] })
    expect((await call('GET', `/v26.0/${a.waba_id}/%70hone_numbers`, none)).json().error.code).toBe(200)

    const { access_token: revoked } = engine.issueToken()
    engine.tokens.revoke(revoked)
    expect((await call('GET', `/v%32%36.0/${a.waba_id}/phone_numbers`, revoked)).statusCode).toBe(401)
  })

  it('guards the media download like the media itself', async () => {
    const a = onboard()
    const b = onboard()
    const { id } = engine.uploadMedia(b.phone_number_id, {
      messaging_product: 'whatsapp',
      type: 'image/jpeg',
      file: { bytes: Buffer.from('secret') },
    })
    const url = new URL(engine.getMedia(id, { baseUrl: 'http://localhost' })['url'] as string)
    const path = url.pathname + url.search
    expect((await call('GET', path, a.token)).statusCode).toBe(400)
    const { access_token: managementOnly } = engine.issueToken({ scopes: ['whatsapp_business_management'] })
    expect((await call('GET', path, managementOnly)).json().error.code).toBe(200)
    expect((await call('GET', path, b.token)).statusCode).toBe(200)
  })

  it('names the verb of the refused call in the error, as Graph does', async () => {
    const a = onboard()
    const b = onboard()
    const verbOf = async (method: 'GET' | 'POST' | 'DELETE') =>
      (await call(method, `/v26.0/${b.waba_id}/subscribed_apps`, a.token, method === 'POST' ? {} : undefined)).json().error
        .message
    expect(await verbOf('GET')).toMatch(new RegExp(`^Unsupported get request\\. Object with ID '${b.waba_id}'`))
    expect(await verbOf('POST')).toMatch(new RegExp(`^Unsupported post request\\. Object with ID '${b.waba_id}'`))
    expect(await verbOf('DELETE')).toMatch(new RegExp(`^Unsupported delete request\\. Object with ID '${b.waba_id}'`))
  })

  it('leaves a token wamock did not issue alone, as before', async () => {
    const b = onboard()
    expect((await call('GET', `/v26.0/${b.waba_id}/phone_numbers`, 'EAAG-from-elsewhere')).statusCode).toBe(200)
  })
})

describe('permissions per endpoint', () => {
  it('needs whatsapp_business_management for management and whatsapp_business_messaging for sending', async () => {
    const { access_token: messagingOnly } = engine.issueToken({ scopes: ['whatsapp_business_messaging'] })
    const { access_token: managementOnly } = engine.issueToken({ scopes: ['whatsapp_business_management'] })
    const waba = engine.state.defaultWabaId
    const pnid = engine.state.defaultPhoneNumberId

    expect((await call('GET', `/v26.0/${waba}/message_templates`, messagingOnly)).json().error.error_data.details).toMatch(
      /whatsapp_business_management/,
    )
    // Graph's permissions error: code 200, HTTP 403.
    const refused = await call('GET', `/v26.0/${waba}/phone_numbers`, messagingOnly)
    expect([refused.statusCode, refused.json().error.code, refused.json().error.message]).toEqual([403, 200, '(#200) Permissions error'])
    expect((await call('GET', `/v26.0/${waba}/message_templates`, managementOnly)).statusCode).toBe(200)

    engine.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
    const send = { messaging_product: 'whatsapp', to: '5215555000001', type: 'text', text: { body: 'x' } }
    expect((await call('POST', `/v26.0/${pnid}/messages`, managementOnly, send)).json().error.error_data.details).toMatch(
      /whatsapp_business_messaging/,
    )
    expect((await call('POST', `/v26.0/${pnid}/messages`, messagingOnly, send)).statusCode).toBe(200)

    // Reading a number is management; reading media is messaging.
    expect((await call('GET', `/v26.0/${pnid}?fields=id`, messagingOnly)).statusCode).toBe(403)
    expect((await call('GET', `/v26.0/${pnid}?fields=id`, managementOnly)).statusCode).toBe(200)
    const { id } = engine.uploadMedia(pnid, { messaging_product: 'whatsapp', type: 'image/jpeg', file: { bytes: Buffer.from('x') } })
    expect((await call('GET', `/v26.0/${id}`, managementOnly)).statusCode).toBe(403)
    expect((await call('GET', `/v26.0/${id}`, messagingOnly)).statusCode).toBe(200)
  })
})

describe('debug_token', () => {
  it('reports the fields Meta’s reference lists, with the app’s name and the token’s WABA', async () => {
    const tenant = onboard()
    const res = await call('GET', `/v26.0/debug_token?input_token=${tenant.token}&access_token=${engine.state.defaultAppId}|${SECRET}`)
    expect(res.json().data).toEqual({
      app_id: engine.state.defaultAppId,
      type: 'USER',
      application: 'wamock Test App',
      is_valid: true,
      expires_at: 0,
      data_access_expires_at: 0,
      issued_at: EPOCH / 1000,
      scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
      granular_scopes: [
        { scope: 'whatsapp_business_messaging', target_ids: [tenant.waba_id] },
        { scope: 'whatsapp_business_management', target_ids: [tenant.waba_id] },
      ],
      user_id: expect.stringMatching(/^\d+$/),
    })
  })

  it('omits target_ids for a token that applies to everything, and expires user data access with the token kind', async () => {
    const { access_token: short } = engine.issueToken({ kind: 'short' })
    const { data } = (
      await call('GET', `/v26.0/debug_token?input_token=${short}&access_token=${engine.state.defaultAppId}|${SECRET}`)
    ).json()
    expect(data.granular_scopes).toEqual([{ scope: 'whatsapp_business_messaging' }, { scope: 'whatsapp_business_management' }])
    expect(data.data_access_expires_at).toBe(EPOCH / 1000 + 90 * 24 * 60 * 60)
  })

  it('takes the app token in the Authorization header too', async () => {
    const tenant = onboard()
    const res = await call('GET', `/v26.0/debug_token?input_token=${tenant.token}`, `${engine.state.defaultAppId}|${SECRET}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().data.is_valid).toBe(true)
  })
})

describe('subscribing a tenant is a step of its own', () => {
  it('tells the partner PARTNER_ADDED at once, and nothing else until it subscribes', async () => {
    const tenant = onboard()
    await engine.flush()
    expect(deliveries.map((d) => d.payload.entry[0]!.changes[0]!.field)).toEqual(['account_update'])
    engine.simulateInbound({ phoneNumberId: tenant.phone_number_id, from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
    await engine.flush()
    expect(messageDeliveries()).toHaveLength(0)

    expect((await call('POST', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token, {})).json()).toEqual({ success: true })
    engine.simulateInbound({ phoneNumberId: tenant.phone_number_id, from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
    await engine.flush()
    expect(messageDeliveries()).toHaveLength(1)
  })

  it('unsubscribes with DELETE, at once', async () => {
    const tenant = onboard()
    await call('POST', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token, {})
    expect((await call('DELETE', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token)).json()).toEqual({ success: true })
    expect((await call('GET', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token)).json()).toEqual({ data: [] })

    engine.simulateInbound({ phoneNumberId: tenant.phone_number_id, from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
    await engine.flush()
    expect(messageDeliveries()).toHaveLength(0)
  })

  it('routes the tenant’s webhooks to override_callback_uri, which GET reports', async () => {
    const tenant = onboard()
    const override = { override_callback_uri: 'https://tenant.example.com/hook', verify_token: 'tenant-vt' }
    expect((await call('POST', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token, override)).json()).toEqual({ success: true })

    expect((await call('GET', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token)).json().data).toEqual([
      {
        whatsapp_business_api_data: { id: engine.state.defaultAppId, name: 'wamock Test App', link: expect.any(String) },
        override_callback_uri: 'https://tenant.example.com/hook',
      },
    ])

    engine.simulateInbound({ phoneNumberId: tenant.phone_number_id, from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
    await engine.flush()
    expect(messageDeliveries()[0]!.callback).toEqual({ url: 'https://tenant.example.com/hook', verifyToken: 'tenant-vt' })
  })

  it('drops the override when the partner subscribes again without one', async () => {
    const tenant = onboard()
    await call('POST', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token, {
      override_callback_uri: 'https://tenant.example.com/hook',
      verify_token: 'vt',
    })
    await call('POST', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token, {})
    const [subscription] = (await call('GET', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token)).json().data
    expect(subscription).not.toHaveProperty('override_callback_uri')
  })

  it('refuses an override that is not a URL, in Meta’s words', async () => {
    const tenant = onboard()
    const res = await call('POST', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token, {
      override_callback_uri: 'not a url',
      verify_token: 'vt',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatchObject({ message: 'Invalid callback URI format', type: 'OAuthException', code: 100 })
  })

  it('stops retrying a failed webhook once the partner unsubscribes', async () => {
    const attempts: string[] = []
    const e = new WamockEngine({
      appSecret: SECRET,
      mode: 'frozen',
      start: EPOCH,
      transport: async (d) => {
        attempts.push(d.payload.entry[0]!.changes[0]!.field)
        throw new Error('receiver returned HTTP 500')
      },
    })
    const tenant = e.createSignup({ subscribed: true, registered: true })
    e.simulateInbound({ phoneNumberId: tenant.phone_number_id, from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
    await e.flush()
    const before = attempts.filter((f) => f === 'messages').length
    expect(before).toBe(1)

    e.unsubscribeApp(tenant.waba_id)
    for (let i = 0; i < 60; i++) {
      e.clock.advance(60_000)
      await e.settle()
    }
    expect(attempts.filter((f) => f === 'messages')).toHaveLength(before)
  })

  it('needs verify_token with override_callback_uri', async () => {
    const tenant = onboard()
    const res = await call('POST', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token, {
      override_callback_uri: 'https://tenant.example.com/hook',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.error_data.details).toMatch(/verify_token/)
  })

  it('needs a verify_token that is not empty', async () => {
    const tenant = onboard()
    const res = await call('POST', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token, {
      override_callback_uri: 'https://tenant.example.com/hook',
      verify_token: '',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(100)
  })

  it('refuses an override that is a URL but not an http(s) one, with no error_data', async () => {
    const tenant = onboard()
    for (const uri of ['ftp://tenant.example.com/hook', 'javascript:alert(1)']) {
      const res = await call('POST', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token, {
        override_callback_uri: uri,
        verify_token: 'vt',
      })
      expect(res.statusCode, uri).toBe(400)
      const { fbtrace_id: _trace, ...error } = res.json().error
      expect(error, uri).toEqual({ message: 'Invalid callback URI format', type: 'OAuthException', code: 100 })
    }
  })

  it('refuses an override that is not a string, even one that reads as a URL', async () => {
    const tenant = onboard()
    const res = await call('POST', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token, {
      override_callback_uri: ['https://tenant.example.com/hook'],
      verify_token: 'vt',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toBe('Invalid callback URI format')
  })

  it('reports the override only on the partner’s own subscription', async () => {
    const tenant = onboard()
    await call('POST', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token, {
      override_callback_uri: 'https://tenant.example.com/hook',
      verify_token: 'vt',
    })
    // Another app on the same WABA, one wamock holds no record of.
    engine.state.subscribeApp(tenant.waba_id, 'APP_OTHER', { url: 'https://tenant.example.com/hook', verifyToken: 'vt' })

    const res = await call('GET', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token)
    expect(res.statusCode).toBe(200)
    const other = res.json().data.find((s: { whatsapp_business_api_data: { id: string } }) => s.whatsapp_business_api_data.id === 'APP_OTHER')
    expect(other).toBeDefined()
    expect(other).not.toHaveProperty('override_callback_uri')
  })

  it('answers an unknown WABA with the verb of the call', async () => {
    const message = async (method: 'GET' | 'DELETE', edge: string) =>
      (await call(method, `/v26.0/WABA_GHOST/${edge}`)).json().error.message as string
    expect(await message('GET', 'subscribed_apps')).toMatch(/^Unsupported get request\. Object with ID 'WABA_GHOST'/)
    expect(await message('DELETE', 'subscribed_apps')).toMatch(/^Unsupported delete request\. Object with ID 'WABA_GHOST'/)
    expect(await message('GET', 'phone_numbers')).toMatch(/^Unsupported get request\. Object with ID 'WABA_GHOST'/)
  })
})

describe('callback overrides, as Meta routes them', () => {
  const HOOK = 'https://tenant.example.com/hook'
  const NUMBER_HOOK = 'https://number.example.com/hook'
  const inbound = (phoneNumberId: string) =>
    engine.simulateInbound({ phoneNumberId, from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
  const subscribed = async (tenant: ReturnType<typeof onboard>, body: Record<string, unknown> = {}) =>
    (await call('POST', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token, body)).json()
  const configure = (tenant: ReturnType<typeof onboard>, configuration: unknown) =>
    call('POST', `/v26.0/${tenant.phone_number_id}`, tenant.token, { webhook_configuration: configuration })

  it('sends template webhooks to the app’s own URL, never to the override', async () => {
    // Meta: template and account-level webhooks "do not support callback
    // overrides" and always go to the app's default callback URL.
    const tenant = onboard()
    await subscribed(tenant, { override_callback_uri: HOOK, verify_token: 'vt' })
    deliveries.length = 0
    engine.createTemplate(tenant.waba_id, {
      name: 'order_update',
      language: 'es_MX',
      category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Hola' }],
    })
    engine.transitionTemplate(tenant.waba_id, 'order_update', 'es_MX', 'APPROVED')
    inbound(tenant.phone_number_id)
    await engine.flush()

    const byField = Object.fromEntries(deliveries.map((d) => [d.payload.entry[0]!.changes[0]!.field, d.callback]))
    expect(byField['message_template_status_update']).toBeUndefined()
    expect(byField['messages']).toEqual({ url: HOOK, verifyToken: 'vt' })
  })

  it('sends a number’s webhooks to its own override first, then its WABA’s, then the app’s', async () => {
    const tenant = onboard()
    await subscribed(tenant, { override_callback_uri: HOOK, verify_token: 'vt' })
    expect((await configure(tenant, { override_callback_uri: NUMBER_HOOK, verify_token: 'nvt' })).json()).toEqual({ success: true })
    inbound(tenant.phone_number_id)
    await engine.flush()
    expect(messageDeliveries().at(-1)!.callback).toEqual({ url: NUMBER_HOOK, verifyToken: 'nvt' })

    // An empty override_callback_uri removes the number's: back to the WABA's.
    expect((await configure(tenant, { override_callback_uri: '' })).json()).toEqual({ success: true })
    inbound(tenant.phone_number_id)
    await engine.flush()
    expect(messageDeliveries().at(-1)!.callback).toEqual({ url: HOOK, verifyToken: 'vt' })

    // Subscribing without a body drops the WABA's: back to the app's.
    await subscribed(tenant)
    inbound(tenant.phone_number_id)
    await engine.flush()
    expect(messageDeliveries().at(-1)!.callback).toBeUndefined()
  })

  it('reports each override under webhook_configuration, only when it is set', async () => {
    const tenant = onboard()
    const read = async () =>
      (await call('GET', `/v26.0/${tenant.phone_number_id}?fields=webhook_configuration`, tenant.token)).json()
    await subscribed(tenant)
    expect(await read()).toEqual({ id: tenant.phone_number_id, webhook_configuration: {} })

    await subscribed(tenant, { override_callback_uri: HOOK, verify_token: 'vt' })
    await configure(tenant, { override_callback_uri: NUMBER_HOOK, verify_token: 'nvt' })
    expect(await read()).toEqual({
      id: tenant.phone_number_id,
      webhook_configuration: { phone_number: NUMBER_HOOK, whatsapp_business_account: HOOK },
    })
    // Not among the default fields.
    expect((await call('GET', `/v26.0/${tenant.phone_number_id}`, tenant.token)).json()).not.toHaveProperty('webhook_configuration')
  })

  it('keeps verify tokens out of /__mock/state, which gets pasted into bug reports', async () => {
    const tenant = onboard()
    await subscribed(tenant, { override_callback_uri: HOOK, verify_token: 'waba-secret-vt' })
    await configure(tenant, { override_callback_uri: NUMBER_HOOK, verify_token: 'number-secret-vt' })
    const state = (await call('GET', '/__mock/state')).body
    expect(state).toContain(tenant.phone_number_id)
    expect(state).not.toContain('secret-vt')
  })

  it('takes the token in a form body as authentication, not as a setting', async () => {
    const tenant = onboard()
    await subscribed(tenant)
    const res = await app.inject({
      method: 'POST',
      url: `/v26.0/${tenant.phone_number_id}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `webhook_configuration=${encodeURIComponent(JSON.stringify({ override_callback_uri: '' }))}&access_token=${tenant.token}`,
    })
    expect(res.json()).toEqual({ success: true })
  })

  it('needs the WABA subscribed before a number can override its callback', async () => {
    const tenant = onboard()
    const res = await configure(tenant, { override_callback_uri: NUMBER_HOOK, verify_token: 'nvt' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(100)
    expect(engine.state.phoneNumber(tenant.phone_number_id)).not.toHaveProperty('callbackOverride')
  })

  it('refuses a number override Meta would refuse', async () => {
    const tenant = onboard()
    await subscribed(tenant)
    const longest = `https://n.example.com/${'a'.repeat(200 - 'https://n.example.com/'.length)}`
    expect((await configure(tenant, { override_callback_uri: longest, verify_token: 'v' })).statusCode).toBe(200)
    for (const configuration of [
      { override_callback_uri: `${longest}a`, verify_token: 'v' },
      { override_callback_uri: 'ftp://n.example.com/hook', verify_token: 'v' },
      { override_callback_uri: NUMBER_HOOK },
      { verify_token: 'v' },
      'https://n.example.com/hook',
      null,
    ]) {
      const res = await configure(tenant, configuration)
      expect(res.statusCode, JSON.stringify(configuration)).toBe(400)
      expect(res.json().error.code).toBe(100)
    }
    // The rest of what this call takes in production is not emulated, and says so.
    const pin = await call('POST', `/v26.0/${tenant.phone_number_id}`, tenant.token, { pin: '123456' })
    expect(pin.statusCode).toBe(400)
    expect(pin.json().error.error_data.details).toMatch(/pin/)
    // An id that is not a number gets Graph's unsupported post request.
    const ghost = await call('POST', `/v26.0/PNID_GHOST`, undefined, { webhook_configuration: { override_callback_uri: '' } })
    expect(ghost.json().error).toMatchObject({ code: 100, error_subcode: 33 })
  })

  it('holds a WABA override to the same 200 characters', async () => {
    const tenant = onboard()
    const res = await call('POST', `/v26.0/${tenant.waba_id}/subscribed_apps`, tenant.token, {
      override_callback_uri: `https://t.example.com/${'a'.repeat(200)}`,
      verify_token: 'vt',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toBe('Invalid callback URI format')
  })

  it('needs the management permission to configure a number', async () => {
    const tenant = onboard()
    await subscribed(tenant)
    const { access_token: messagingOnly } = engine.issueToken({ scopes: ['whatsapp_business_messaging'] })
    const res = await call('POST', `/v26.0/${tenant.phone_number_id}`, messagingOnly, { webhook_configuration: { override_callback_uri: '' } })
    expect(res.json().error.error_data.details).toMatch(/whatsapp_business_management/)
  })
})

describe('reading phone numbers', () => {
  it('returns Meta’s default fields on a single number', async () => {
    const res = await call('GET', `/v26.0/${engine.state.defaultPhoneNumberId}`)
    expect(Object.keys(res.json()).sort()).toEqual(['display_phone_number', 'id', 'quality_rating', 'verified_name'])
  })

  it('answers the documented status fields', async () => {
    const res = await call(
      'GET',
      `/v26.0/${engine.state.defaultPhoneNumberId}?fields=status,name_status,unified_cert_status,account_mode,host_platform,is_official_business_account,country_code,country_dial_code`,
    )
    expect(res.json()).toEqual({
      id: engine.state.defaultPhoneNumberId,
      status: 'CONNECTED',
      name_status: 'APPROVED',
      unified_cert_status: 'APPROVED',
      account_mode: 'LIVE',
      host_platform: 'CLOUD_API',
      is_official_business_account: false,
      country_code: 'US',
      country_dial_code: '1',
    })
  })

  it('pages the list with limit and cursors', async () => {
    const waba = engine.state.defaultWabaId
    for (const n of [2, 3]) {
      engine.state.registerPhoneNumber({ phoneNumberId: `PNID_${n}`, wabaId: waba, displayPhoneNumber: `1555000000${n}` })
    }
    const first = (await call('GET', `/v26.0/${waba}/phone_numbers?fields=id&limit=2`)).json()
    expect(first.data.map((n: { id: string }) => n.id)).toEqual(['PNID_3', 'PNID_2'])
    expect(first.paging.cursors).toEqual({ before: expect.any(String), after: expect.any(String) })
    expect(first.paging.next).toContain(`after=${first.paging.cursors.after}`)

    const second = (await call('GET', `/v26.0/${waba}/phone_numbers?fields=id&limit=2&after=${first.paging.cursors.after}`)).json()
    expect(second.data.map((n: { id: string }) => n.id)).toEqual([engine.state.defaultPhoneNumberId])
    expect(second.paging).not.toHaveProperty('next')
    expect(second.paging.previous).toContain(`before=${second.paging.cursors.before}`)
    expect(first.paging).not.toHaveProperty('previous')

    const back = (await call('GET', `/v26.0/${waba}/phone_numbers?fields=id&limit=2&before=${second.paging.cursors.before}`)).json()
    expect(back.data.map((n: { id: string }) => n.id)).toEqual(['PNID_3', 'PNID_2'])
  })

  // Left alive: `at(undefined)` is never called, so its branch is dead; and a
  // call with both `after` and `before` is not pinned, as Meta's references
  // do not say which one wins.
  /** Four numbers besides the seed; newest first that is PNID_5, PNID_4, PNID_3, PNID_2, the seed. */
  const fiveNumbers = (): string[] => {
    const waba = engine.state.defaultWabaId
    for (const n of [2, 3, 4, 5]) {
      engine.state.registerPhoneNumber({ phoneNumberId: `PNID_${n}`, wabaId: waba, displayPhoneNumber: `1555000000${n}` })
    }
    return ['PNID_5', 'PNID_4', 'PNID_3', 'PNID_2', engine.state.defaultPhoneNumberId]
  }
  const idsOf = (page: { data: Array<{ id: string }> }) => page.data.map((n) => n.id)
  const list = async (query: string) => (await call('GET', `/v26.0/${engine.state.defaultWabaId}/phone_numbers?${query}`)).json()

  it('reads the page before a cursor from the middle of the list, not from the top', async () => {
    const ordered = fiveNumbers()
    const first = await list('fields=id&limit=2')
    const second = await list(`fields=id&limit=2&after=${first.paging.cursors.after}`)
    const third = await list(`fields=id&limit=2&after=${second.paging.cursors.after}`)
    expect(idsOf(third)).toEqual(ordered.slice(4))

    const back = await list(`fields=id&limit=2&before=${third.paging.cursors.before}`)
    expect(idsOf(back)).toEqual(ordered.slice(2, 4))
    expect(back.paging).toHaveProperty('previous')
    expect(back.paging).toHaveProperty('next')
  })

  it('stops the page before a cursor at that cursor, even near the top', async () => {
    const ordered = fiveNumbers()
    const first = await list('fields=id&limit=1')
    const second = await list(`fields=id&limit=1&after=${first.paging.cursors.after}`)
    expect(idsOf(second)).toEqual([ordered[1]])

    const back = await list(`fields=id&limit=2&before=${second.paging.cursors.before}`)
    expect(idsOf(back)).toEqual([ordered[0]])
    expect(back.paging).not.toHaveProperty('previous')
  })

  it('points the paging links at the mock and the version called, carrying the query', async () => {
    fiveNumbers()
    const waba = engine.state.defaultWabaId
    const page = (await call('GET', `/v21.0/${waba}/phone_numbers?fields=id,verified_name&limit=2`)).json()
    const next = new URL(page.paging.next)
    expect(`${next.origin}${next.pathname}`).toBe(`http://localhost/v21.0/${waba}/phone_numbers`)
    expect(Object.fromEntries(next.searchParams)).toEqual({ fields: 'id,verified_name', limit: '2', after: page.paging.cursors.after })
  })

  it('leaves out of the paging links what the call left out', async () => {
    fiveNumbers()
    const first = await list('limit=1')
    const rest = await list(`after=${first.paging.cursors.after}`)
    expect(rest.data).toHaveLength(4)
    expect(rest.paging).not.toHaveProperty('next')
    const previous = new URL(rest.paging.previous)
    expect(Object.fromEntries(previous.searchParams)).toEqual({ before: rest.paging.cursors.before })
  })

  it('points the paging links at Graph when called without an address', () => {
    fiveNumbers()
    const waba = engine.state.defaultWabaId
    const { paging } = engine.listPhoneNumbers(waba, { limit: 2 })
    expect(new URL(paging!['next'] as string).pathname).toBe(`/v26.0/${waba}/phone_numbers`)
    expect(new URL(paging!['next'] as string).origin).toBe('https://graph.facebook.com')
  })

  it('refuses a number it does not know, as Graph does', () => {
    expect(() => engine.getPhoneNumberFields('PNID_GHOST', ['id'])).toThrow(
      expect.objectContaining({ code: 100, message: expect.stringMatching(/^Unsupported get request\. Object with ID 'PNID_GHOST'/) }),
    )
  })

  it('keeps the sort in the paging links, so following next continues the same order', async () => {
    const waba = engine.state.defaultWabaId
    for (const n of [2, 3, 4]) {
      engine.state.registerPhoneNumber({ phoneNumberId: `PNID_${n}`, wabaId: waba, displayPhoneNumber: `1555000000${n}` })
    }
    const ids: string[] = []
    let url: string | undefined = `/v26.0/${waba}/phone_numbers?fields=id&limit=2&sort=last_onboarded_time.asc`
    while (url !== undefined) {
      const page: { data: Array<{ id: string }>; paging?: { next?: string } } = (await call('GET', url)).json()
      ids.push(...page.data.map((n) => n.id))
      url = page.paging?.next ? new URL(page.paging.next).pathname + new URL(page.paging.next).search : undefined
    }
    expect(ids).toEqual([engine.state.defaultPhoneNumberId, 'PNID_2', 'PNID_3', 'PNID_4'])
  })

  it('takes a limit from 1 to 100', async () => {
    const waba = engine.state.defaultWabaId
    expect((await call('GET', `/v26.0/${waba}/phone_numbers?limit=0`)).statusCode).toBe(400)
    expect((await call('GET', `/v26.0/${waba}/phone_numbers?limit=101`)).statusCode).toBe(400)
    expect((await call('GET', `/v26.0/${waba}/phone_numbers?limit=100`)).statusCode).toBe(200)
    expect((await call('GET', `/v26.0/${waba}/phone_numbers?limit=1`)).statusCode).toBe(200)
  })

  it('takes only a whole number as the limit', async () => {
    const waba = engine.state.defaultWabaId
    for (const limit of ['1.5', '1e1', 'x5', '5x']) {
      const res = await call('GET', `/v26.0/${waba}/phone_numbers?limit=${limit}`)
      expect(res.statusCode, limit).toBe(400)
      expect(res.json().error.code, limit).toBe(100)
    }
  })

  it('sorts oldest first with either documented spelling', async () => {
    const waba = engine.state.defaultWabaId
    engine.state.registerPhoneNumber({ phoneNumberId: 'PNID_2', wabaId: waba, displayPhoneNumber: '15550000002' })
    for (const sort of ["['last_onboarded_time_ascending']", 'last_onboarded_time.asc']) {
      const res = (await call('GET', `/v26.0/${waba}/phone_numbers?fields=id&sort=${encodeURIComponent(sort)}`)).json()
      expect(res.data.map((n: { id: string }) => n.id)).toEqual([engine.state.defaultPhoneNumberId, 'PNID_2'])
    }
  })
})
