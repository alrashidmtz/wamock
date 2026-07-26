import { describe, expect, it } from 'vitest'

import { MockState } from '../../src/core/state.js'

describe('MockState — default seed', () => {
  it('comes with one app, one WABA and one phone number wired together', () => {
    // The simple case must not pay for the multi-tenant model: a developer who
    // just wants to send a text should never have to register anything.
    const state = new MockState({ appSecret: 's3cret' })

    const pn = state.phoneNumber(state.defaultPhoneNumberId)
    expect(pn).toBeDefined()
    expect(state.waba(pn!.wabaId)).toBeDefined()
    expect(state.appSecretForPhoneNumber(state.defaultPhoneNumberId)).toBe('s3cret')
  })

  it('uses stable default ids so tests can hardcode them', () => {
    const a = new MockState({ appSecret: 'x' })
    const b = new MockState({ appSecret: 'x' })
    expect(a.defaultPhoneNumberId).toBe(b.defaultPhoneNumberId)
    expect(a.defaultWabaId).toBe(b.defaultWabaId)
  })

  it('honours explicit seed ids', () => {
    const state = new MockState({
      appSecret: 'x',
      phoneNumberId: 'PNID_CUSTOM',
      wabaId: 'WABA_CUSTOM',
      displayPhoneNumber: '15550009999',
    })
    expect(state.defaultPhoneNumberId).toBe('PNID_CUSTOM')
    expect(state.phoneNumber('PNID_CUSTOM')?.wabaId).toBe('WABA_CUSTOM')
    expect(state.phoneNumber('PNID_CUSTOM')?.displayPhoneNumber).toBe('15550009999')
  })
})

describe('MockState — the app graph', () => {
  it('resolves a phone number to the app secret that signs its webhooks', () => {
    // Spec §5.2 / §9.3: each webhook is signed with the secret of the app that
    // "delivers" it. Getting this wrong is invisible until a second app exists.
    const state = new MockState({ appSecret: 'platform-secret' })
    state.registerApp({ appId: 'APP_TENANT', appSecret: 'tenant-secret' })
    state.registerWaba({ wabaId: 'WABA_TENANT', appId: 'APP_TENANT' })
    state.registerPhoneNumber({
      phoneNumberId: 'PNID_TENANT',
      wabaId: 'WABA_TENANT',
      displayPhoneNumber: '15550002222',
    })

    expect(state.appSecretForPhoneNumber('PNID_TENANT')).toBe('tenant-secret')
    expect(state.appSecretForPhoneNumber(state.defaultPhoneNumberId)).toBe('platform-secret')
  })

  it('returns undefined for a phone number it does not host', () => {
    const state = new MockState({ appSecret: 'x' })
    expect(state.appSecretForPhoneNumber('PNID_NOPE')).toBeUndefined()
  })

  it('refuses to register a phone number under an unknown WABA', () => {
    const state = new MockState({ appSecret: 'x' })
    expect(() =>
      state.registerPhoneNumber({
        phoneNumberId: 'PNID_ORPHAN',
        wabaId: 'WABA_GHOST',
        displayPhoneNumber: '15550003333',
      }),
    ).toThrow(/WABA_GHOST/)
  })

  it('refuses to register a WABA under an unknown app', () => {
    const state = new MockState({ appSecret: 'x' })
    expect(() => state.registerWaba({ wabaId: 'WABA_X', appId: 'APP_GHOST' })).toThrow(/APP_GHOST/)
  })
})

describe('MockState — sequence and reset', () => {
  it('hands out sequence numbers starting at 1', () => {
    const state = new MockState({ appSecret: 'x' })
    expect(state.nextSeq()).toBe(1)
    expect(state.nextSeq()).toBe(2)
  })

  it('reset() rewinds the sequence so ids replay identically', () => {
    const state = new MockState({ appSecret: 'x' })
    state.nextSeq()
    state.nextSeq()
    state.reset()
    expect(state.nextSeq()).toBe(1)
  })

  it('reset() clears recorded traffic', () => {
    const state = new MockState({ appSecret: 'x' })
    state.recordOutbound({
      id: 'wamid.X',
      phoneNumberId: state.defaultPhoneNumberId,
      to: '5215555000001',
      type: 'text',
      payload: { text: { body: 'hi' } },
      sentAt: 0,
    })
    expect(state.outbound()).toHaveLength(1)

    state.reset()

    expect(state.outbound()).toHaveLength(0)
  })

  it('reset() restores tenants registered after the seed', () => {
    // reset() means "back to the seed", not "back to whatever I had". A test
    // that registered a second tenant must not leak it into the next test.
    const state = new MockState({ appSecret: 'x' })
    state.registerApp({ appId: 'APP_TENANT', appSecret: 'tenant' })
    state.reset()
    expect(state.app('APP_TENANT')).toBeUndefined()
    expect(state.appSecretForPhoneNumber(state.defaultPhoneNumberId)).toBe('x')
  })

  it('outbound() returns a copy — callers cannot mutate history', () => {
    const state = new MockState({ appSecret: 'x' })
    state.outbound().push({
      id: 'wamid.FAKE',
      phoneNumberId: 'p',
      to: 't',
      type: 'text',
      payload: {},
      sentAt: 0,
    })
    expect(state.outbound()).toHaveLength(0)
  })
})
