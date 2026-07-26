import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../../src/core/engine.js'
import { GraphError } from '../../src/errors/graph-error.js'

/**
 * Media is a stub (spec §5.5, a stated non-goal): wamock issues valid-looking
 * ids and URLs but stores no bytes. What it DOES reproduce is the expiry —
 * Meta's media URLs die after about five minutes, and integrations that cache
 * one and fetch it later get a 404 they never saw in testing.
 */

const EPOCH = 1_750_000_000_000
const MINUTE = 60 * 1000

const engine = () => new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })

const codeOf = (fn: () => unknown): number => {
  try {
    fn()
  } catch (err) {
    if (err instanceof GraphError) return err.code
    throw err
  }
  throw new Error('expected a GraphError, but nothing was thrown')
}

describe('uploadMedia', () => {
  it('returns an id shaped like Meta’s', () => {
    const e = engine()
    const res = e.uploadMedia(e.state.defaultPhoneNumberId, { mime_type: 'image/jpeg' })

    expect(res.id).toMatch(/^\d+$/)
  })

  it('is deterministic across a reset', () => {
    const e = engine()
    const first = e.uploadMedia(e.state.defaultPhoneNumberId, { mime_type: 'image/jpeg' }).id
    e.reset()
    const second = e.uploadMedia(e.state.defaultPhoneNumberId, { mime_type: 'image/jpeg' }).id

    expect(second).toBe(first)
  })

  it('rejects an unknown phone number', () => {
    expect(codeOf(() => engine().uploadMedia('PNID_GHOST', { mime_type: 'image/jpeg' }))).toBe(100)
  })

  it('requires a mime type', () => {
    const e = engine()
    expect(codeOf(() => e.uploadMedia(e.state.defaultPhoneNumberId, {}))).toBe(100)
  })
})

describe('getMedia', () => {
  it('returns the metadata envelope Meta returns', () => {
    const e = engine()
    const { id } = e.uploadMedia(e.state.defaultPhoneNumberId, { mime_type: 'image/jpeg' })

    expect(e.getMedia(id)).toMatchObject({
      messaging_product: 'whatsapp',
      id,
      mime_type: 'image/jpeg',
      url: expect.stringContaining('http'),
      sha256: expect.any(String),
      file_size: expect.any(Number),
    })
  })

  it('still resolves just before the URL expires', () => {
    const e = engine()
    const { id } = e.uploadMedia(e.state.defaultPhoneNumberId, { mime_type: 'image/jpeg' })

    e.clock.advance(5 * MINUTE - 1)

    expect(() => e.getMedia(id)).not.toThrow()
  })

  it('stops resolving once the URL expired', () => {
    // The trap: an integration that stores the URL and fetches it minutes later
    // works in every test and fails against Meta.
    const e = engine()
    const { id } = e.uploadMedia(e.state.defaultPhoneNumberId, { mime_type: 'image/jpeg' })

    e.clock.advance(5 * MINUTE)

    expect(codeOf(() => e.getMedia(id))).toBe(100)
  })

  it('rejects a media id it never issued', () => {
    expect(codeOf(() => engine().getMedia('999999999999999'))).toBe(100)
  })
})
