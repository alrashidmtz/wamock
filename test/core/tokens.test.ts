import { describe, expect, it } from 'vitest'

import { TokenStore } from '../../src/core/tokens.js'

/**
 * Token lifecycle (spec §9.2).
 *
 * The scenario this exists for: a developer pastes a Graph API Explorer token
 * into a connect form. It works. Two hours later every send fails with a 401
 * and nothing in the product says why — the messages simply stop. Being able
 * to reproduce that in a test is the point.
 */

const EPOCH = 1_750_000_000_000
const HOUR = 60 * 60 * 1000

describe('TokenStore — issuing', () => {
  it('issues a permanent System User token with expires_at 0', () => {
    // expires_at: 0 is Meta's marker for "never expires". A checker that
    // compares it numerically against now() decides it expired in 1970.
    const store = new TokenStore()
    const token = store.issue({ appId: 'APP_1', kind: 'permanent' }, EPOCH)

    expect(store.debug(token, EPOCH).expires_at).toBe(0)
    expect(store.debug(token, EPOCH).is_valid).toBe(true)
  })

  it('issues a short-lived token that expires in about two hours', () => {
    const store = new TokenStore()
    const token = store.issue({ appId: 'APP_1', kind: 'short' }, EPOCH)

    const expiresAt = store.debug(token, EPOCH).expires_at
    expect(expiresAt).toBeGreaterThan(EPOCH / 1000)
    expect(expiresAt).toBeLessThanOrEqual((EPOCH + 3 * HOUR) / 1000)
  })

  it('issues a long-lived 60-day token', () => {
    const store = new TokenStore()
    const token = store.issue({ appId: 'APP_1', kind: 'long' }, EPOCH)

    expect(store.debug(token, EPOCH).expires_at).toBe((EPOCH + 60 * 24 * HOUR) / 1000)
  })

  it('issues tokens that differ from each other', () => {
    const store = new TokenStore()
    expect(store.issue({ appId: 'APP_1', kind: 'permanent' }, EPOCH)).not.toBe(
      store.issue({ appId: 'APP_1', kind: 'permanent' }, EPOCH),
    )
  })
})

describe('TokenStore — validity over time', () => {
  it('reports a short token as valid before it expires', () => {
    const store = new TokenStore()
    const token = store.issue({ appId: 'APP_1', kind: 'short' }, EPOCH)

    expect(store.isValid(token, EPOCH + HOUR)).toBe(true)
  })

  it('reports it invalid once the clock passes its expiry', () => {
    // Nothing else changed — only time. This is the whole bug.
    const store = new TokenStore()
    const token = store.issue({ appId: 'APP_1', kind: 'short' }, EPOCH)

    expect(store.isValid(token, EPOCH + 3 * HOUR)).toBe(false)
    expect(store.debug(token, EPOCH + 3 * HOUR).is_valid).toBe(false)
  })

  it('never expires a permanent token', () => {
    const store = new TokenStore()
    const token = store.issue({ appId: 'APP_1', kind: 'permanent' }, EPOCH)

    expect(store.isValid(token, EPOCH + 365 * 24 * HOUR)).toBe(true)
  })

  it('treats an unknown token as invalid rather than throwing', () => {
    const store = new TokenStore()

    expect(store.isValid('made-up-token', EPOCH)).toBe(false)
    expect(store.debug('made-up-token', EPOCH)).toMatchObject({ is_valid: false })
  })

  it('can be revoked, simulating a token pulled in Business Manager', () => {
    const store = new TokenStore()
    const token = store.issue({ appId: 'APP_1', kind: 'permanent' }, EPOCH)

    store.revoke(token)

    expect(store.isValid(token, EPOCH)).toBe(false)
  })
})

describe('TokenStore — scopes', () => {
  it('grants messaging and management scopes by default', () => {
    const store = new TokenStore()
    const token = store.issue({ appId: 'APP_1', kind: 'permanent' }, EPOCH)

    expect(store.hasScope(token, 'whatsapp_business_messaging')).toBe(true)
    expect(store.hasScope(token, 'whatsapp_business_management')).toBe(true)
  })

  it('can issue a token missing the management scope', () => {
    // The real failure: a token that sends fine but cannot create templates,
    // so the connect appears to work and template submission silently 403s.
    const store = new TokenStore()
    const token = store.issue(
      { appId: 'APP_1', kind: 'permanent', scopes: ['whatsapp_business_messaging'] },
      EPOCH,
    )

    expect(store.hasScope(token, 'whatsapp_business_messaging')).toBe(true)
    expect(store.hasScope(token, 'whatsapp_business_management')).toBe(false)
  })

  it('reports the scopes in the debug payload', () => {
    const store = new TokenStore()
    const token = store.issue({ appId: 'APP_1', kind: 'permanent' }, EPOCH)

    expect(store.debug(token, EPOCH).scopes).toContain('whatsapp_business_messaging')
  })

  it('grants no scope on an unknown token', () => {
    expect(new TokenStore().hasScope('nope', 'whatsapp_business_messaging')).toBe(false)
  })
})

describe('TokenStore — debug payload shape', () => {
  it('matches what Meta returns from debug_token', () => {
    const store = new TokenStore()
    const token = store.issue({ appId: 'APP_1', kind: 'permanent' }, EPOCH)

    expect(store.debug(token, EPOCH)).toMatchObject({
      app_id: 'APP_1',
      type: 'USER',
      application: expect.any(String),
      is_valid: true,
      expires_at: 0,
      scopes: expect.any(Array),
    })
  })
})

describe('TokenStore — reset', () => {
  it('clear() forgets every token', () => {
    const store = new TokenStore()
    const token = store.issue({ appId: 'APP_1', kind: 'permanent' }, EPOCH)

    store.clear()

    expect(store.isValid(token, EPOCH)).toBe(false)
  })
})
