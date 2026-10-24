import { describe, expect, it } from 'vitest'

import { NATIONAL_LENGTHS, includesCallingCode } from '../../src/core/national-lengths.js'
import { COUNTRY_BY_CALLING_CODE } from '../../src/core/phone.js'

describe('national number lengths', () => {
  it('cover exactly the calling codes wamock knows, each with plausible lengths', () => {
    expect(Object.keys(NATIONAL_LENGTHS).sort()).toEqual(COUNTRY_BY_CALLING_CODE.map(([code]) => code).sort())
    // National lengths, up to 15: libphonenumber records German fixed lines
    // that long, past E.164's 15 digits with the code.
    const malformed = Object.entries(NATIONAL_LENGTHS).filter(
      ([, lengths]) => lengths.length === 0 || lengths.some((length) => length < 1 || length > 15),
    )
    expect(malformed).toEqual([])
  })
})

describe('whether a number already includes its calling code', () => {
  it('reads Meta’s own example as including it', () => {
    expect(includesCallingCode('1', '14195551518')).toBe(true)
  })

  it('reads a Brazilian number that starts with 55 as national when only that fits', () => {
    // 11 digits is a Brazilian mobile; without the 55 it would be 9, which is not.
    expect(includesCallingCode('55', '55912345678')).toBe(false)
    expect(includesCallingCode('55', '5555912345678')).toBe(true)
  })

  it('never strips a code the number does not start with', () => {
    expect(includesCallingCode('52', '5512345678')).toBe(false)
  })

  it('treats a name the table only inherits as no calling code', () => {
    for (const cc of ['constructor', '__proto__', 'toString']) expect(includesCallingCode(cc, `${cc}12345678`)).toBe(true)
  })

  it('follows Meta’s example where both readings fit, or the code is unknown', () => {
    // Germany: 11 digits fits as a national number, and so do the 9 left without 49.
    expect(includesCallingCode('49', '49301234567')).toBe(true)
    expect(includesCallingCode('999', '99912345678')).toBe(true)
  })
})
