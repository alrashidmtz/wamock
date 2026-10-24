import { describe, expect, it } from 'vitest'

import {
  COUNTRY_BY_CALLING_CODE,
  callingCodeOf,
  countryOf,
  normalizeWaId,
  toGraphDisplayNumber,
  toWebhookDisplayNumber,
} from '../../src/core/phone.js'

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

describe('the business number in a webhook', () => {
  it('is digits only, exactly like the customer side', () => {
    // Every webhook example Meta publishes, and 107 public captures against 6,
    // send `metadata.display_phone_number` without a `+`. wamock sent one
    // until 0.5.0, from a hand-written fixture rather than captured traffic.
    expect(toWebhookDisplayNumber('15550001111')).toBe('15550001111')
  })

  it('drops a + or punctuation a caller configured', () => {
    expect(toWebhookDisplayNumber('+1 555-000-1111')).toBe('15550001111')
  })
})

describe('the business number in a Graph lookup', () => {
  it('is formatted with a + and grouped, as Meta lists numbers', () => {
    // Meta's phone-number listing: "+1 631-555-5555".
    expect(toGraphDisplayNumber('16315555555')).toBe('+1 631-555-5555')
  })

  it('separates the country code for numbers outside North America', () => {
    expect(toGraphDisplayNumber('525500000000')).toBe('+52 5500000000')
  })

  it('accepts a number that already carries a + or punctuation', () => {
    expect(toGraphDisplayNumber('+1 (555) 000-1111')).toBe('+1 555-000-1111')
  })

  it('falls back to + and digits for a calling code it does not know', () => {
    expect(toGraphDisplayNumber('9995550001111')).toBe('+9995550001111')
  })
})

describe('calling codes', () => {
  it('maps a number to its country and calling code', () => {
    expect(countryOf('5215555000001')).toBe('MX')
    expect(callingCodeOf('5215555000001')).toBe('52')
    expect(countryOf('9995550001111')).toBe('ZZ')
    expect(callingCodeOf('9995550001111')).toBeUndefined()
  })

  it('keeps the table prefix-free, so lookup order never matters', () => {
    // E.164 codes are prefix-free; an entry like '1242' beside '1' would make
    // the first match depend on table order.
    const codes = COUNTRY_BY_CALLING_CODE.map(([code]) => code)
    const clashes = codes.flatMap((a) => codes.filter((b) => a !== b && b.startsWith(a)).map((b) => `${a}/${b}`))
    expect(clashes).toEqual([])
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('gives every code a calling code of 1 to 3 digits and a distinct ISO country', () => {
    // The country lands in every BSUID (`MX.…`); a blank or malformed one
    // would ship user ids Meta never issues.
    const malformed = COUNTRY_BY_CALLING_CODE.filter(([code, country]) => !/^[1-9]\d{0,2}$/.test(code) || !/^[A-Z]{2}$/.test(country))
    expect(malformed).toEqual([])
    const countries = COUNTRY_BY_CALLING_CODE.map(([, country]) => country)
    expect(new Set(countries).size).toBe(countries.length)
  })
})

describe('the full E.164 plan', () => {
  it('formats numbers from countries outside the old short table', () => {
    // Finland and Czechia were missing before, and fell back to `+digits`.
    expect(toGraphDisplayNumber('358401234567')).toBe('+358 401234567')
    expect(toGraphDisplayNumber('420601234567')).toBe('+420 601234567')
    expect(countryOf('358401234567')).toBe('FI')
  })

  it('covers every geographic code, cross-checked against libphonenumber', () => {
    // 206 geographic codes, the same set libphonenumber's metadata holds.
    expect(COUNTRY_BY_CALLING_CODE).toHaveLength(206)
    expect(countryOf('381601234567')).toBe('RS')
    expect(countryOf('383441234567')).toBe('XK')
    expect(toGraphDisplayNumber('381601234567')).toBe('+381 601234567')
  })

  it('gives a non-geographic code no country: Inmarsat 870 is not Pitcairn', () => {
    expect(countryOf('870773100000')).toBe('ZZ')
  })
})
