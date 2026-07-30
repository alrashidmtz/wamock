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

describe('the options form', () => {
  it('signs the same bytes as the positional form', () => {
    expect(signBody({ appSecret: SECRET, body: BODY })).toBe(signBody(SECRET, BODY))
  })

  it('verifies what it signed', () => {
    const header = signBody({ appSecret: SECRET, body: BODY })
    expect(verifySignature({ appSecret: SECRET, body: BODY, header })).toBe(true)
  })

  it('still rejects the wrong secret, and an absent header', () => {
    const header = signBody({ appSecret: 'another-app-secret', body: BODY })
    expect(verifySignature({ appSecret: SECRET, body: BODY, header })).toBe(false)
    expect(verifySignature({ appSecret: SECRET, body: BODY, header: undefined })).toBe(false)
  })

  it('cannot be swapped, so it is never guarded', () => {
    // Naming the fields is the point: there is no wrong order to protect from,
    // so a body-shaped secret here is the caller's business and not an error.
    expect(() => signBody({ appSecret: BODY, body: SECRET })).not.toThrow()
  })
})

describe('swapped arguments', () => {
  it('refuses to sign with the arguments the wrong way round', () => {
    // The field report's exact mistake: a helper of the caller's own is
    // `firmar(body, secret)`, and muscle memory writes that order here. It used
    // to return a well-formed signature that never verified, which sends you to
    // audit your own HMAC check rather than your call.
    expect(() => signBody(BODY, SECRET)).toThrow(/look swapped/)
  })

  it('refuses to verify with them the wrong way round', () => {
    const header = signBody(SECRET, BODY)
    expect(() => verifySignature(BODY, SECRET, header)).toThrow(/look swapped/)
  })

  it('says which order is right and how to avoid the question', () => {
    // The message IS the fix here. Matching one phrase of it leaves the rest
    // free to rot into an empty string that diagnoses nothing, which is what
    // the caller is left holding at 2am.
    let message = ''
    try {
      signBody(BODY, SECRET)
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('(appSecret, rawBody)')
    expect(message).toContain('look swapped')
    expect(message).toContain('{ appSecret, body }')
    expect(message).toContain('your call site')
  })

  // A JSON body satisfies the guard's second clause on its own, so the secret
  // is never examined and any mistake in that half goes unseen. These pass a
  // body that is plainly not JSON, which is what puts the secret on trial.
  const PLAIN = 'not json at all'

  it('leaves a secret that merely looks numeric alone', () => {
    // `JSON.parse('1234')` succeeds. Requiring an object, not just valid JSON,
    // is what keeps an all-digit secret from tripping the guard.
    expect(() => signBody('1234567890', PLAIN)).not.toThrow()
    expect(() => signBody('null', PLAIN)).not.toThrow()
    expect(() => signBody('"quoted"', PLAIN)).not.toThrow()
  })

  it('leaves a secret that merely starts with a brace alone', () => {
    // Opens like JSON, is not JSON. The parse has to decide, not the brace.
    expect(() => signBody('{not-json-at-all', PLAIN)).not.toThrow()
  })

  it('sees a JSON secret through leading whitespace', () => {
    // A body arriving with leading whitespace is ordinary; trimming the wrong
    // end would let exactly that shape of swap past.
    expect(() => signBody('  {"object":"whatsapp_business_account"}', PLAIN)).toThrow(
      /look swapped/,
    )
  })

  it('catches a JSON array in the secret slot, not just an object', () => {
    // `entry` is an array, and a caller slicing a payload can land one here.
    expect(() => signBody('[{"id":1}]', PLAIN)).toThrow(/look swapped/)
  })

  it('stays silent when BOTH arguments are JSON — a known, deliberate gap', () => {
    // The guard needs the asymmetry: a JSON secret AND a non-JSON body. Signing
    // one document with another as the key is almost certainly a swap too, but
    // "almost certainly" is not a bar worth throwing on, and a caller doing it
    // on purpose must not be refused. Documented rather than quietly true.
    expect(() => signBody(BODY, '{"also":"json"}')).not.toThrow()
  })

  it('never lets a request body reach the guard', () => {
    // The guard throws, and verifySignature is documented never to throw. Both
    // stay true because only `appSecret` is inspected, and that half is never
    // attacker-controlled — no request can turn this into a 500.
    for (const hostile of ['{"a":1}', '[]', '{}', '  {"nested":{"deep":true}}']) {
      expect(verifySignature(SECRET, hostile, 'sha256=zzzz')).toBe(false)
    }
  })
})
