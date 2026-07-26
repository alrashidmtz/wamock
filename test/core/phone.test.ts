import { describe, expect, it } from 'vitest'

import { normalizeWaId, toDisplayPhoneNumber } from '../../src/core/phone.js'

describe('normalizeWaId', () => {
  it('strips a leading + — Meta reports wa_id as digits only', () => {
    expect(normalizeWaId('+5215555000001')).toBe('5215555000001')
  })

  it('leaves an already-normalized number untouched', () => {
    expect(normalizeWaId('5215555000001')).toBe('5215555000001')
  })

  it('strips the punctuation humans type', () => {
    expect(normalizeWaId('+52 (1) 555-500-0001')).toBe('5215555000001')
  })

  it('rejects an empty string', () => {
    expect(normalizeWaId('')).toBeNull()
  })

  it('rejects a string with no digits at all', () => {
    expect(normalizeWaId('not-a-number')).toBeNull()
  })

  it('rejects a number too short to be dialable', () => {
    expect(normalizeWaId('12345')).toBeNull()
  })

  it('rejects a number longer than E.164 allows', () => {
    expect(normalizeWaId('1234567890123456789')).toBeNull()
  })
})

describe('toDisplayPhoneNumber', () => {
  it('adds the + that Meta includes on the business number', () => {
    // The asymmetry is deliberate: metadata.display_phone_number carries '+',
    // contacts[].wa_id does not. Integrations that normalize one and not the
    // other end up with two keys for the same person.
    expect(toDisplayPhoneNumber('15550001111')).toBe('+15550001111')
  })

  it('does not double the + when the input already has one', () => {
    expect(toDisplayPhoneNumber('+15550001111')).toBe('+15550001111')
  })
})
