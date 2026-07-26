import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { signBody, verifySignature } from '../../src/webhooks/signature.js'

const SECRET = 'app-secret-under-test'
const BODY = '{"object":"whatsapp_business_account","entry":[]}'

describe('signBody', () => {
  it('produces the sha256= prefixed hex digest Meta sends', () => {
    const expected = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex')
    expect(signBody(SECRET, BODY)).toBe(`sha256=${expected}`)
  })

  it('signs the raw bytes, not a re-serialized object', () => {
    // This is the whole point of X-Hub-Signature-256. A receiver that verifies
    // against JSON.stringify(req.body) instead of the raw buffer passes in
    // testing and fails in production the moment key order or spacing differs.
    // wamock must let that bug surface.
    const spaced = '{"object": "whatsapp_business_account", "entry": []}'
    expect(signBody(SECRET, spaced)).not.toBe(signBody(SECRET, BODY))
  })

  it('accepts a Buffer body and matches the string form byte-for-byte', () => {
    expect(signBody(SECRET, Buffer.from(BODY, 'utf8'))).toBe(signBody(SECRET, BODY))
  })
})

describe('verifySignature', () => {
  it('accepts a signature it produced itself', () => {
    expect(verifySignature(SECRET, BODY, signBody(SECRET, BODY))).toBe(true)
  })

  it('rejects a signature made with a different app secret', () => {
    // The cross-signing scenario of spec §9.6.4 depends on this being strict.
    expect(verifySignature(SECRET, BODY, signBody('another-app-secret', BODY))).toBe(false)
  })

  it('rejects a valid signature over a different body', () => {
    expect(verifySignature(SECRET, '{"tampered":true}', signBody(SECRET, BODY))).toBe(false)
  })

  it('rejects a missing header', () => {
    expect(verifySignature(SECRET, BODY, undefined)).toBe(false)
  })

  it('rejects a header without the sha256= prefix', () => {
    const bare = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex')
    expect(verifySignature(SECRET, BODY, bare)).toBe(false)
  })

  it('rejects a non-hex header without throwing', () => {
    expect(() => verifySignature(SECRET, BODY, 'sha256=zzzz')).not.toThrow()
    expect(verifySignature(SECRET, BODY, 'sha256=zzzz')).toBe(false)
  })

  it('rejects a truncated digest without throwing', () => {
    const short = signBody(SECRET, BODY).slice(0, 20)
    expect(verifySignature(SECRET, BODY, short)).toBe(false)
  })
})
