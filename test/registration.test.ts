import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { createServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'

/**
 * Putting a number on Cloud API, in Meta's four steps: create, request a code,
 * verify, register. Since Embedded Signup v3 a customer can finish with a
 * verified number, an unverified one, or none; registering is always the
 * partner's step, and until then the number cannot send.
 */

const EPOCH = 1_750_000_000_000
const HOUR = 60 * 60 * 1000
const CUSTOMER = '5215555000001'

let engine: WamockEngine
let app: FastifyInstance

beforeEach(async () => {
  engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
  app = createServer(engine)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    ...(payload !== undefined ? { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) } : {}),
  })
const send = (pnid: string) =>
  call('POST', `/v26.0/${pnid}/messages`, {
    messaging_product: 'whatsapp',
    to: CUSTOMER,
    type: 'template',
    template: { name: 'hello', language: { code: 'es_MX' } },
  })
const register = (pnid: string, pin = '123456') => call('POST', `/v26.0/${pnid}/register`, { messaging_product: 'whatsapp', pin })
const fields = async (pnid: string) =>
  (await call('GET', `/v26.0/${pnid}?fields=code_verification_status,verified_name,display_phone_number`)).json()
const approveHello = (wabaId: string) => {
  engine.createTemplate(wabaId, { name: 'hello', language: 'es_MX', category: 'UTILITY', components: [] })
  engine.transitionTemplate(wabaId, 'hello', 'es_MX', 'APPROVED')
}

describe('a customer who finished Embedded Signup without a number', () => {
  it('gets no phone_number_id, and the partner adds and registers one in four steps', async () => {
    const signup = (await call('POST', '/__mock/embedded-signup', { phone: 'none', subscribed: true })).json()
    expect(signup).not.toHaveProperty('phone_number_id')
    expect((await call('GET', `/v26.0/${signup.waba_id}/phone_numbers`)).json().data).toEqual([])

    // 1. Create: "with or without the country calling code".
    const created = await call('POST', `/v26.0/${signup.waba_id}/phone_numbers`, { cc: '52', phone_number: '5512345678', verified_name: 'Lucky Shrub' })
    const pnid = created.json().id as string
    expect(await fields(pnid)).toMatchObject({ code_verification_status: 'UNVERIFIED', verified_name: 'Lucky Shrub', display_phone_number: '+52 5512345678' })
    approveHello(signup.waba_id)
    expect((await send(pnid)).json().error.code).toBe(133010)
    expect((await register(pnid)).json().error.code).toBe(133006)

    // 2. Request a code, in the query as Meta's example sends it.
    expect((await call('POST', `/v26.0/${pnid}/request_code?code_method=SMS&language=en_US`)).json()).toEqual({ success: true })
    const code = (await call('GET', `/__mock/verification-code?phone_number_id=${pnid}`)).json().code as string
    expect(code).toMatch(/^\d{6}$/)

    // 3. Verify, with the code; a wrong one is refused.
    const wrong = code === '000000' ? '000001' : '000000'
    expect((await call('POST', `/v26.0/${pnid}/verify_code?code=${wrong}`)).json().error.code).toBe(100)
    expect((await call('POST', `/v26.0/${pnid}/verify_code?code=${code}`)).json()).toEqual({ success: true })
    expect((await fields(pnid)).code_verification_status).toBe('VERIFIED')
    // Requesting a code for a verified number is Meta's 136024.
    const again = await call('POST', `/v26.0/${pnid}/request_code?code_method=SMS&language=en_US`)
    expect(again.statusCode).toBe(400)
    expect(again.json().error.code).toBe(136024)

    // 4. Register, and the number sends.
    expect((await register(pnid)).json()).toEqual({ success: true })
    expect((await send(pnid)).statusCode).toBe(200)
  })

  it('takes the number with the calling code too, and the code in a form body', async () => {
    const signup = engine.createSignup({ phone: 'none' })
    const { id } = engine.createPhoneNumber(signup.waba_id, { cc: '1', phone_number: '14195551518', verified_name: 'Lucky Shrub' })
    expect((await fields(id)).display_phone_number).toBe('+1 419-555-1518')
    engine.requestVerificationCode(id, { code_method: 'VOICE', language: 'es_MX' })
    const res = await app.inject({
      method: 'POST',
      url: `/v26.0/${id}/verify_code`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `code=${engine.verificationCode(id)}`,
    })
    expect(res.json()).toEqual({ success: true })
  })

  it('reads a national number that starts with its calling code as national when its length says so', async () => {
    const { waba_id: waba } = engine.createSignup({ phone: 'none' })
    const { id } = engine.createPhoneNumber(waba, { cc: '55', phone_number: '55912345678', verified_name: 'Loja' })
    expect(engine.state.phoneNumber(id)?.displayPhoneNumber).toBe('5555912345678')
  })

  it('refuses a number that is not one, and a request missing its parts', async () => {
    const { waba_id: waba } = engine.createSignup({ phone: 'none' })
    for (const body of [
      { cc: 'constructor', phone_number: 'constructor12345678', verified_name: 'X' },
      { cc: '__proto__', phone_number: '12345678', verified_name: 'X' },
      { cc: '52', phone_number: 'abc', verified_name: 'X' },
      { cc: 'x', phone_number: '5512345678', verified_name: 'X' },
      { phone_number: '5512345678', verified_name: 'X' },
      { cc: '52', phone_number: '5512345678' },
      { cc: '52', phone_number: '5512345678', verified_name: '   ' },
      { cc: 'x52', phone_number: '5512345678', verified_name: 'X' },
      { cc: '5212', phone_number: '5512345678', verified_name: 'X' },
      { cc: '52', phone_number: 'x5512345678', verified_name: 'X' },
      { cc: '52', phone_number: '5512345678x', verified_name: 'X' },
      { cc: '52', phone_number: '1', verified_name: 'X' },
    ]) {
      expect((await call('POST', `/v26.0/${waba}/phone_numbers`, body)).json().error.code, JSON.stringify(body)).toBe(100)
    }
    expect((await call('GET', `/v26.0/${waba}/phone_numbers`)).json().data).toEqual([])
    const { id } = engine.createPhoneNumber(waba, { cc: '52', phone_number: '5512345678', verified_name: 'X' })
    expect((await call('POST', `/v26.0/${id}/request_code?code_method=EMAIL&language=en_US`)).json().error.code).toBe(100)
    expect((await call('POST', `/v26.0/${id}/request_code?code_method=SMS`)).json().error.code).toBe(100)
    expect((await call('POST', `/v26.0/${id}/request_code?code_method=SMS&language=`)).json().error.code).toBe(100)
    expect((await call('POST', `/v26.0/${id}/verify_code`)).json().error.code).toBe(100)
    expect((await call('GET', `/__mock/verification-code?phone_number_id=${id}`)).statusCode).toBe(400)
  })
})

describe('the registration routes guard what they touch', () => {
  it('answers an id that does not exist with Graph’s unsupported post request', async () => {
    for (const path of ['WABA_GHOST/phone_numbers', 'PNID_GHOST/request_code', 'PNID_GHOST/verify_code', 'PNID_GHOST/register', 'PNID_GHOST/deregister']) {
      const res = await call('POST', `/v26.0/${path}`, { messaging_product: 'whatsapp' })
      const ghost = path.slice(0, path.indexOf('/'))
      expect(res.json().error, path).toMatchObject({
        code: 100,
        error_subcode: 33,
        message: expect.stringMatching(new RegExp(`^Unsupported post request\\. Object with ID '${ghost}' does not exist`)),
      })
    }
  })

  // Runs repeat, so a twin engine tells which id the next number would get.
  const nextNumberId = (): string => {
    const twin = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    const { waba_id: tenant } = twin.createSignup({ phone: 'none' })
    return twin.createPhoneNumber(tenant, { cc: '52', phone_number: '5512345678', verified_name: 'X' }).id
  }

  it('never mints the id of a number a test already holds', () => {
    const held = nextNumberId()
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    e.state.registerPhoneNumber({ phoneNumberId: held, wabaId: e.state.defaultWabaId, displayPhoneNumber: '5215555000099' })
    const { waba_id: tenant } = e.createSignup({ phone: 'none' })
    const { id } = e.createPhoneNumber(tenant, { cc: '52', phone_number: '5512345678', verified_name: 'X' })
    expect(id).toMatch(/^\d{15}$/)
    expect(id).not.toBe(held)
    expect(e.state.phoneNumber(id)?.wabaId).toBe(tenant)
    expect(e.state.phoneNumber(held)?.wabaId).toBe(e.state.defaultWabaId)
  })

  it('never mints the id of another kind of object either: Graph ids are one space', () => {
    const held = nextNumberId()
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    e.state.registerWaba({ wabaId: held, appId: e.state.defaultAppId })
    const { waba_id: tenant } = e.createSignup({ phone: 'none' })
    const { id } = e.createPhoneNumber(tenant, { cc: '52', phone_number: '5512345678', verified_name: 'X' })
    expect(id).not.toBe(held)
    expect(e.state.waba(held)?.appId).toBe(e.state.defaultAppId)
    expect(e.state.phoneNumber(id)?.wabaId).toBe(tenant)
  })

  it('never mints a media id or a template id that another object holds', () => {
    // Runs repeat, so a first engine tells which ids a second would mint.
    const upload = (e: WamockEngine) =>
      e.uploadMedia(e.state.defaultPhoneNumberId, { messaging_product: 'whatsapp', type: 'image/png', file: { bytes: Buffer.from('x') } }).id
    const mediaId = upload(new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH }))
    const clash = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, phoneNumberId: mediaId })
    expect(upload(clash)).not.toBe(mediaId)

    const template = (e: WamockEngine, name: string) =>
      e.createTemplate(e.state.defaultWabaId, { name, language: 'es_MX', category: 'UTILITY', components: [] }).id
    const templateId = template(new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH }), 'first')
    const seeded = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    seeded.state.putTemplate({
      id: templateId,
      wabaId: seeded.state.defaultWabaId,
      name: 'seeded',
      language: 'es_MX',
      category: 'UTILITY',
      status: 'APPROVED',
      parameterFormat: 'POSITIONAL',
      components: [],
      pauses: 0,
    })
    expect(template(seeded, 'first')).not.toBe(templateId)
    expect(seeded.listTemplates(seeded.state.defaultWabaId).data.map((t) => t.name).sort()).toEqual(['first', 'seeded'])
  })

  it('settles every signup id before inserting any, so a clash leaves nothing behind', async () => {
    const before = { wabas: engine.state.wabas().length, businesses: engine.state.businesses().length }
    const waba = engine.state.defaultWabaId
    const res = await call('POST', '/__mock/embedded-signup', { business_id: waba })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatchObject({ code: 100, error_data: { details: `Id ${waba} belongs to another kind of object` } })
    expect({ wabas: engine.state.wabas().length, businesses: engine.state.businesses().length }).toEqual(before)
    // Not even the counter moved (called on the engine: over HTTP the error
    // body draws its fbtrace_id from it): the next signup mints what a twin
    // that never saw the refusal mints.
    const refused = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    expect(() => refused.createSignup({ businessId: refused.state.defaultWabaId })).toThrow()
    const twin = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    expect(refused.createSignup()).toEqual(twin.createSignup())
  })

  it('mints the signup’s own ids around a portfolio id the caller chose', () => {
    // A twin engine shows which number id this signup would mint; naming the
    // portfolio that must not make the number clash with it.
    const twin = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    const wouldMint = twin.createSignup().phone_number_id
    const named = engine.createSignup({ businessId: wouldMint })
    expect(named.phone_number_id).not.toBe(wouldMint)
    expect(engine.state.business(wouldMint)).toBeDefined()
    expect(engine.state.phoneNumber(named.phone_number_id)?.wabaId).toBe(named.waba_id)
  })

  it('refuses a coexistence signup with a contact that is no phone, leaving no tenant and sending nothing', async () => {
    const delivered = engine.deliverer.deliveredCount()
    const before = engine.state.wabas().length
    const res = await call('POST', '/__mock/embedded-signup', { coexistence: true, contacts: [{ phone: 'nope' }] })
    expect(res.statusCode).toBe(400)
    expect(engine.state.wabas()).toHaveLength(before)
    expect(engine.deliverer.deliveredCount()).toBe(delivered)
  })

  it('needs both permissions to register, and answers Graph’s 200 without them', async () => {
    const { phone_number_id: pnid } = engine.createSignup()
    for (const scopes of [['whatsapp_business_management'], ['whatsapp_business_messaging']]) {
      const { access_token: token } = engine.issueToken({ scopes })
      const res = await app.inject({
        method: 'POST',
        url: `/v26.0/${pnid}/register`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ messaging_product: 'whatsapp', pin: '123456' }),
      })
      expect([res.statusCode, res.json().error.code], scopes.join()).toEqual([403, 200])
    }
  })

  it('checks a token passed as access_token in the query like one in the header', async () => {
    const a = engine.createSignup({ phone: 'none' })
    const b = engine.createSignup({ phone: 'none' })
    const { access_token: token } = engine.exchangeCode(engine.state.defaultAppId, 's', a.code)
    const res = await call('POST', `/v26.0/${b.waba_id}/phone_numbers?access_token=${token}`, { cc: '52', phone_number: '5512345678', verified_name: 'X' })
    expect(res.json().error).toMatchObject({ code: 100, error_subcode: 33 })
    const own = await call('POST', `/v26.0/${a.waba_id}/phone_numbers?access_token=${token}`, { cc: '52', phone_number: '5512345678', verified_name: 'X' })
    expect(own.statusCode).toBe(200)
  })

  it('leaves nothing behind when a signup is refused', async () => {
    const before = engine.state.wabas().length
    const res = await call('POST', '/__mock/embedded-signup', { coexistence: true, phone: 'none' })
    expect(res.statusCode).toBe(400)
    expect(engine.state.wabas()).toHaveLength(before)
  })
})

describe('a customer who finished with an unverified number', () => {
  it('has a number to verify and register, and nothing reaches it until then', async () => {
    const signup = engine.createSignup({ phone: 'unverified', subscribed: true })
    expect((await fields(signup.phone_number_id)).code_verification_status).toBe('UNVERIFIED')
    const inbound = await call('POST', '/__mock/inbound', { from: CUSTOMER, text: 'hola', phone_number_id: signup.phone_number_id })
    expect(inbound.statusCode).toBe(400)
    expect((await register(signup.phone_number_id)).json().error.code).toBe(133006)
  })

  it('cannot be registered by the signup itself', () => {
    const signup = engine.createSignup({ phone: 'unverified', registered: true })
    expect(engine.state.phoneNumber(signup.phone_number_id)?.registered).toBe(false)
  })
})

describe('a verified number from Embedded Signup', () => {
  it('still has to be registered: signup verifies, the partner registers', async () => {
    const signup = engine.createSignup({ subscribed: true })
    approveHello(signup.waba_id)
    expect((await fields(signup.phone_number_id)).code_verification_status).toBe('VERIFIED')
    expect((await send(signup.phone_number_id)).json().error).toMatchObject({
      code: 133010,
      message: '(#133010) Phone number not registered on the WhatsApp Business Platform.',
    })
    expect((await register(signup.phone_number_id)).json()).toEqual({ success: true })
    expect((await send(signup.phone_number_id)).statusCode).toBe(200)
  })

  it('keeps the first PIN as its two-step verification PIN', async () => {
    const { phone_number_id: pnid } = engine.createSignup({ registered: false })
    // A pin sent as a JSON number is left unpinned: Graph may coerce it.
    for (const pin of ['12345', 'abcdef', '1234567']) expect((await register(pnid, pin)).json().error.code, pin).toBe(100)
    expect((await call('POST', `/v26.0/${pnid}/register`, { pin: '123456' })).json().error.code).toBe(100)
    await register(pnid, '111111')
    expect((await call('POST', `/v26.0/${pnid}/deregister`)).json()).toEqual({ success: true })
    approveHello(engine.state.phoneNumber(pnid)!.wabaId)
    expect((await send(pnid)).json().error.code).toBe(133010)
    expect((await register(pnid, '222222')).json().error.code).toBe(133005)
    expect((await register(pnid, '111111')).json()).toEqual({ success: true })
  })

  it('counts calls in a moving 72-hour window: one exactly 72 hours old no longer counts', async () => {
    const { phone_number_id: pnid } = engine.createSignup()
    for (let i = 0; i < 5; i++) {
      expect((await register(pnid)).statusCode).toBe(200)
      expect((await call('POST', `/v26.0/${pnid}/deregister`)).statusCode).toBe(200)
    }
    engine.clock.advance(72 * HOUR)
    expect((await register(pnid)).statusCode).toBe(200)
  })

  it('allows 10 register or deregister calls in 72 hours, then locks the number for 72 hours', async () => {
    const { phone_number_id: pnid } = engine.createSignup()
    for (let i = 0; i < 5; i++) {
      expect((await register(pnid)).statusCode).toBe(200)
      expect((await call('POST', `/v26.0/${pnid}/deregister`)).statusCode).toBe(200)
    }
    // The 11th, an hour short of the first call leaving the window: refused,
    // and the 72 hours start from here.
    engine.clock.advance(71 * HOUR)
    expect((await register(pnid)).json().error.code).toBe(133016)
    engine.clock.advance(72 * HOUR - 1)
    expect((await register(pnid)).json().error.code).toBe(133016)
    engine.clock.advance(1)
    expect((await register(pnid)).statusCode).toBe(200)
  })
})

describe('numbers that need no registering', () => {
  it('sends from the seeded number and from a Business app number as they are', async () => {
    approveHello(engine.state.defaultWabaId)
    expect((await send(engine.state.defaultPhoneNumberId)).statusCode).toBe(200)
    const coexistence = engine.createSignup({ coexistence: true, subscribed: true })
    expect(engine.state.phoneNumber(coexistence.phone_number_id)?.registered).toBe(true)
    // "You cannot use this endpoint to deregister a business phone number that
    // is in use with both Cloud API and the WhatsApp Business app."
    expect((await call('POST', `/v26.0/${coexistence.phone_number_id}/deregister`)).json().error.code).toBe(100)
    expect(() => engine.createSignup({ coexistence: true, phone: 'none' })).toThrow(expect.objectContaining({ code: 100 }))
  })

  it('keeps the PIN out of /__mock/state', async () => {
    const { phone_number_id: pnid } = engine.createSignup()
    await register(pnid, '987654')
    expect((await call('GET', '/__mock/state')).body).not.toContain('987654')
  })

  it('sends each number its own six-digit code, leading zeros kept', () => {
    const { waba_id: waba } = engine.createSignup({ phone: 'none' })
    const codes = Array.from({ length: 10 }, (_, i) => {
      const { id } = engine.createPhoneNumber(waba, { cc: '52', phone_number: `55123456${String(i).padStart(2, '0')}`, verified_name: 'X' })
      engine.requestVerificationCode(id, { code_method: 'SMS', language: 'en_US' })
      return engine.verificationCode(id)!
    })
    // As the SMS reads it, "WhatsApp code 123-830", always six digits.
    for (const code of codes) expect(code).toMatch(/^\d{6}$/)
  })

  it('keeps each number’s code to itself: verifying one leaves the other’s standing', () => {
    const { waba_id: waba } = engine.createSignup({ phone: 'none' })
    const [a, b] = ['5512345601', '5512345602'].map((n) => engine.createPhoneNumber(waba, { cc: '52', phone_number: n, verified_name: 'X' }).id)
    for (const id of [a!, b!]) engine.requestVerificationCode(id, { code_method: 'SMS', language: 'en_US' })
    const codeOfB = engine.verificationCode(b!)
    engine.verifyCode(a!, { code: engine.verificationCode(a!)! })
    expect(engine.verificationCode(b!)).toBe(codeOfB)
    expect(engine.verifyCode(b!, { code: codeOfB! })).toEqual({ success: true })
  })

  it('forgets requested codes on reset', async () => {
    const { phone_number_id: pnid } = engine.createSignup({ phone: 'unverified' })
    engine.requestVerificationCode(pnid, { code_method: 'SMS', language: 'en_US' })
    engine.reset()
    expect(engine.verificationCode(pnid)).toBeUndefined()
  })
})
