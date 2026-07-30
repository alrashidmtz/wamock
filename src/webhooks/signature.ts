import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * `X-Hub-Signature-256` — HMAC-SHA256 of the RAW request body, keyed with the
 * app secret of the app delivering the webhook.
 *
 * "Raw" is load-bearing. A receiver that verifies against
 * `JSON.stringify(req.body)` instead of the untouched bytes will pass every
 * test written against a naive mock, then fail in production the first time key
 * order or whitespace differs from what it re-serializes. wamock signs the
 * exact bytes it puts on the wire so that bug is reproducible here.
 */

const PREFIX = 'sha256='

/** The unswappable form. Prefer it: two adjacent strings have no safe order. */
export interface SignBodyInput {
  appSecret: string
  body: string | Buffer
}

export interface VerifySignatureInput extends SignBodyInput {
  /** The `X-Hub-Signature-256` header as received, if there was one. */
  header: string | undefined
}

/**
 * Catch `signBody(body, appSecret)` — the arguments the wrong way round.
 *
 * Both orders exist in the wild: `crypto.createHmac(alg, key)` puts the key
 * first, most app-level `sign(payload, secret)` helpers put it second. So there
 * is no convention to fall back on, and the swap costs nothing to make: it
 * type-checks, runs, and returns a perfectly well-formed `sha256=…` that simply
 * never verifies. Well-formed and wrong is the worst possible failure here,
 * because the code it makes you doubt is your own HMAC check — security-relevant
 * code that sends you down a much longer path than "I swapped two arguments".
 *
 * An app secret is never a JSON object; a Meta webhook body always is. That
 * asymmetry is the whole test — and both halves are required, so the guard
 * fires only when the arguments genuinely describe each other's roles. Signing
 * one JSON document with another as the key stays silent: it is almost
 * certainly a swap too, but "almost certainly" is not a bar this should throw
 * on, and refusing a call that might be deliberate is worse than missing one.
 *
 * This throws, and `verifySignature` is documented never to throw — the
 * distinction that keeps both true is WHERE the input comes from. A body being
 * JSON only ever makes the guard quieter, so an attacker cannot use `rawBody`
 * to reach the throw. `appSecret` is supplied by the application, never by a
 * request. A caller with its arguments crossed can get here; a request cannot.
 */
function assertNotSwapped(appSecret: string, body: string | Buffer): void {
  if (!looksLikeJsonObject(appSecret)) return
  // A JSON body in the body slot means the roles are not reversed after all.
  if (typeof body === 'string' && looksLikeJsonObject(body)) return
  throw new TypeError(
    'signBody/verifySignature take (appSecret, rawBody) in that order, and the app secret ' +
      'given here is a JSON object while the body is not — the arguments look swapped. ' +
      'Pass an options object ({ appSecret, body }) if the order is easy to get wrong at ' +
      'your call site.',
  )
}

/**
 * A JSON object or array, as opposed to a bare string or number. The opening
 * brace is checked first so an all-digit app secret — valid JSON, but a scalar —
 * cannot trip the guard.
 */
function looksLikeJsonObject(value: string): boolean {
  const trimmed = value.trimStart()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

function inputOf(
  first: SignBodyInput | string,
  rawBody: string | Buffer | undefined,
): SignBodyInput {
  if (typeof first !== 'string') return first
  const body = rawBody as string | Buffer
  assertNotSwapped(first, body)
  return { appSecret: first, body }
}

/** Compute the header value Meta would send for this body and secret. */
export function signBody(input: SignBodyInput): string
/** @deprecated Two adjacent strings have no safe order — use `signBody({ appSecret, body })`. */
export function signBody(appSecret: string, rawBody: string | Buffer): string
export function signBody(first: SignBodyInput | string, rawBody?: string | Buffer): string {
  const { appSecret, body } = inputOf(first, rawBody)
  const digest = createHmac('sha256', appSecret).update(body).digest('hex')
  return `${PREFIX}${digest}`
}

/**
 * Verify a received signature. Timing-safe, and tolerant of every malformed
 * header shape a caller might send — a signature check that throws is a
 * signature check an attacker can turn into a 500.
 */
export function verifySignature(input: VerifySignatureInput): boolean
/**
 * @deprecated Two adjacent strings have no safe order — use
 * `verifySignature({ appSecret, body, header })`.
 */
export function verifySignature(
  appSecret: string,
  rawBody: string | Buffer,
  header: string | undefined,
): boolean
export function verifySignature(
  first: VerifySignatureInput | string,
  rawBody?: string | Buffer,
  header?: string | undefined,
): boolean {
  const input = inputOf(first, rawBody)
  const received = typeof first === 'string' ? header : first.header

  if (!received?.startsWith(PREFIX)) return false

  const provided = Buffer.from(received.slice(PREFIX.length), 'hex')
  const expected = Buffer.from(signBody(input).slice(PREFIX.length), 'hex')

  // Length must match before timingSafeEqual, which throws on mismatched sizes.
  // A truncated or non-hex header lands here.
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}
