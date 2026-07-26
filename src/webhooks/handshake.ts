import { randomBytes } from 'node:crypto'

/**
 * The subscription handshake — wamock acting as Meta.
 *
 * When you register a callback URL, Meta does not take your word for it: it
 * issues `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` and
 * requires the challenge echoed back verbatim. Receivers that answer `200 ok`,
 * or that JSON-wrap the challenge, look healthy and are not — and they only
 * find out when Meta silently refuses to deliver anything.
 *
 * Running the same handshake at startup turns that into an error message on
 * the first run instead of a mystery hours later.
 */

export interface HandshakeResult {
  ok: boolean
  /** Why it failed. Meant to be shown to a human, not parsed. */
  reason?: string
}

/** Startup check — kept short so a dead receiver does not delay the banner. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000

export async function verifyWebhookUrl(
  webhookUrl: string,
  verifyToken: string,
  timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
): Promise<HandshakeResult> {
  const challenge = randomBytes(8).toString('hex')

  let url: URL
  try {
    url = new URL(webhookUrl)
  } catch {
    return { ok: false, reason: `'${webhookUrl}' is not a valid URL` }
  }
  // Append rather than replace: multi-tenant receivers often carry their own
  // query string on the callback URL.
  url.searchParams.set('hub.mode', 'subscribe')
  url.searchParams.set('hub.verify_token', verifyToken)
  url.searchParams.set('hub.challenge', challenge)

  let response: Response
  try {
    // Bounded: the handshake runs at startup, and a receiver that accepts the
    // connection without answering would otherwise hang the CLI before it ever
    // prints its banner.
    response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { ok: false, reason: `receiver did not respond within ${timeoutMs}ms` }
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }

  if (!response.ok) {
    return { ok: false, reason: `receiver returned HTTP ${response.status}` }
  }

  const body = (await response.text()).trim()
  if (body !== challenge) {
    return {
      ok: false,
      reason: `receiver did not echo hub.challenge (expected '${challenge}', got '${body.slice(0, 64)}')`,
    }
  }

  return { ok: true }
}
