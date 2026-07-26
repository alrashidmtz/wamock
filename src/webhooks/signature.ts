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

/** Compute the header value Meta would send for this body and secret. */
export function signBody(appSecret: string, rawBody: string | Buffer): string {
  const digest = createHmac('sha256', appSecret).update(rawBody).digest('hex')
  return `${PREFIX}${digest}`
}

/**
 * Verify a received signature. Timing-safe, and tolerant of every malformed
 * header shape a caller might send — a signature check that throws is a
 * signature check an attacker can turn into a 500.
 */
export function verifySignature(
  appSecret: string,
  rawBody: string | Buffer,
  header: string | undefined,
): boolean {
  if (!header?.startsWith(PREFIX)) return false

  const provided = Buffer.from(header.slice(PREFIX.length), 'hex')
  const expected = Buffer.from(signBody(appSecret, rawBody).slice(PREFIX.length), 'hex')

  // Length must match before timingSafeEqual, which throws on mismatched sizes.
  // A truncated or non-hex header lands here.
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}
