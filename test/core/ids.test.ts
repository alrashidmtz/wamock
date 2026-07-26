import { describe, expect, it } from 'vitest'

import { makeFbtraceId, makeMediaId, makeWamid } from '../../src/core/ids.js'

describe('makeWamid', () => {
  it('produces an id with the wamid. prefix Meta uses', () => {
    expect(makeWamid('PNID_1', 1)).toMatch(/^wamid\./)
  })

  it('is deterministic — the same inputs always give the same id', () => {
    // Determinism is what makes `expectSent` assertions stable across runs and
    // lets a reset() replay produce byte-identical output.
    expect(makeWamid('PNID_1', 7)).toBe(makeWamid('PNID_1', 7))
  })

  it('gives different ids for different sequence numbers', () => {
    expect(makeWamid('PNID_1', 1)).not.toBe(makeWamid('PNID_1', 2))
  })

  it('gives different ids for different phone numbers at the same sequence', () => {
    expect(makeWamid('PNID_1', 1)).not.toBe(makeWamid('PNID_2', 1))
  })

  it('is URL-safe — no characters that would break a query string', () => {
    expect(makeWamid('PNID_1', 1)).toMatch(/^wamid\.[A-Za-z0-9_-]+$/)
  })
})

describe('makeFbtraceId', () => {
  it('is deterministic', () => {
    expect(makeFbtraceId(3)).toBe(makeFbtraceId(3))
  })

  it('differs per sequence number', () => {
    expect(makeFbtraceId(3)).not.toBe(makeFbtraceId(4))
  })
})

describe('makeMediaId', () => {
  it('is deterministic and numeric-looking, like Meta media ids', () => {
    expect(makeMediaId(5)).toBe(makeMediaId(5))
    expect(makeMediaId(5)).toMatch(/^\d+$/)
  })
})
