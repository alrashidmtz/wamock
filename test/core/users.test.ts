import { describe, expect, it } from 'vitest'

import { PHONE_SHARING_MS, Users } from '../../src/core/users.js'

const DAY = 24 * 60 * 60 * 1000
const MX = '5215555000001'
const US = '15555550123'

describe('Users — business-scoped user ids', () => {
  it('formats a BSUID as country code, a period, and digits', () => {
    expect(new Users().bsuid('BIZ_1', MX)).toMatch(/^MX\.\d{20}$/)
    expect(new Users().bsuid('BIZ_1', US)).toMatch(/^US\.\d{20}$/)
  })

  it('is deterministic: the same portfolio and customer always get the same BSUID', () => {
    expect(new Users().bsuid('BIZ_1', MX)).toBe(new Users().bsuid('BIZ_1', MX))
  })

  it('is scoped to the portfolio: another portfolio sees another BSUID', () => {
    const users = new Users()
    expect(users.bsuid('BIZ_1', MX)).not.toBe(users.bsuid('BIZ_2', MX))
  })

  it('changes with the phone number, as Meta regenerates it', () => {
    const users = new Users()
    expect(users.bsuid('BIZ_1', MX)).not.toBe(users.bsuid('BIZ_1', '5215555000002'))
  })

  it('resolves a BSUID it handed out back to its portfolio and customer', () => {
    const users = new Users()
    const id = users.bsuid('BIZ_1', MX)
    expect(users.resolve(id)).toEqual({ businessId: 'BIZ_1', waId: MX })
    expect(users.resolve('MX.00000000000000000000')).toBeUndefined()
  })

  it('falls back to ZZ for a calling code it has no country for', () => {
    expect(new Users().bsuid('BIZ_1', '9995555000001')).toMatch(/^ZZ\./)
  })
})

describe('Users — when the phone number may be shared', () => {
  it('always shares it for a customer without a username', () => {
    expect(new Users().phoneShareable('PNID_1', MX, 0)).toBe(true)
  })

  it('hides it for a customer with a username and no recent contact', () => {
    const users = new Users()
    users.setProfile(MX, { username: 'pablo' })
    expect(users.phoneShareable('PNID_1', MX, 0)).toBe(false)
  })

  it('shares it within 30 days of contact through that phone number', () => {
    const users = new Users()
    users.setProfile(MX, { username: 'pablo' })
    users.recordPhoneContact('PNID_1', MX, 0)
    expect(users.phoneShareable('PNID_1', MX, PHONE_SHARING_MS - 1)).toBe(true)
    expect(users.phoneShareable('PNID_1', MX, PHONE_SHARING_MS)).toBe(false)
    expect(PHONE_SHARING_MS).toBe(30 * DAY)
  })

  it('evaluates contact per business phone number', () => {
    const users = new Users()
    users.setProfile(MX, { username: 'pablo' })
    users.recordPhoneContact('PNID_1', MX, 0)
    expect(users.phoneShareable('PNID_2', MX, 1)).toBe(false)
  })

  it('keeps a username until told otherwise, and drops it on null', () => {
    const users = new Users()
    users.setProfile(MX, { name: 'Pablo', username: 'pablo' })
    users.setProfile(MX, { name: 'Pablo M.' })
    expect(users.profile(MX)).toEqual({ name: 'Pablo M.', username: 'pablo' })
    users.setProfile(MX, { username: null })
    expect(users.profile(MX)).toEqual({ name: 'Pablo M.' })
  })

  it('clear() forgets profiles, contacts and issued ids', () => {
    const users = new Users()
    const id = users.bsuid('BIZ_1', MX)
    users.setProfile(MX, { username: 'pablo' })
    users.clear()
    expect(users.profile(MX)).toEqual({})
    expect(users.resolve(id)).toBeUndefined()
  })
})
