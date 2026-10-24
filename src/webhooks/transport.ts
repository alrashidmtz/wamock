import { verifyWebhookUrl } from './handshake.js'
import type { HandshakeResult } from './handshake.js'
import type { WebhookPayload } from './payloads.js'

/** One webhook, ready to go on the wire. */
export interface WebhookDelivery {
  /** The exact bytes that were signed. Never re-serialize these before sending. */
  body: string
  /** `sha256=…`, the `X-Hub-Signature-256` header value. */
  signature: string
  /** Parsed form of `body`, so in-process consumers do not have to re-parse. */
  payload: WebhookPayload
  /** Virtual time of delivery. */
  deliveredAt: number
  /**
   * The WABA's `override_callback_uri` and its verify token, when it set one.
   * The HTTP transport delivers there instead of the configured URL.
   */
  callback?: { url: string; verifyToken: string }
}

/**
 * How a webhook reaches the integration under test. Rejecting marks the
 * delivery failed in the log; it never breaks the clock drain.
 */
/**
 * Passed with each attempt. A transport asks it right before it sends, after
 * any wait of its own (a handshake, a slow handler): the WABA may have
 * unsubscribed, moved its callback, or the mock been reset meanwhile.
 */
export interface DeliveryAttempt {
  /** Whether this attempt, to this destination, is still wanted. */
  isCurrent(): boolean
  /**
   * True when the attempt repeats one cancelled because the callback moved.
   * Only the new destination is new: a sink that already took the webhook
   * (library mode's `onWebhook`) must not take it twice.
   */
  rerouted?: boolean
}

/**
 * Thrown by a transport that found its attempt no longer current. Not a
 * failure: nothing was sent, so nothing is logged and nothing retried.
 */
export class DeliveryCancelled extends Error {
  constructor() {
    super('webhook delivery cancelled: no longer wanted')
    this.name = 'DeliveryCancelled'
  }
}

export type WebhookTransport = ((delivery: WebhookDelivery, attempt?: DeliveryAttempt) => Promise<void>) & {
  /**
   * Run the verification handshake against a WABA's `override_callback_uri`,
   * as Meta does before accepting the subscription. A transport that does not
   * deliver over HTTP has nothing to verify and leaves this out.
   */
  verifyCallback?: (url: string, verifyToken: string) => Promise<HandshakeResult>
  /** Forget what this transport learned (verified URLs): part of `reset()`. */
  reset?: () => void
  /** The app's callback URL, for a transport that delivers to one. */
  readonly callbackUrl?: string
}

/**
 * How long to wait for a receiver before giving up.
 *
 * A timeout is not politeness, it is a correctness requirement: without one, a
 * receiver that accepts the connection and never answers blocks the delivery
 * forever, `settle()` never resolves, and the test hangs with no output. A
 * failed delivery is diagnosable; a hang is not.
 */
export const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000

export interface HttpTransportOptions {
  timeoutMs?: number
  /**
   * The token for Meta's verification handshake. When set, the URL receives
   * nothing until it passes the handshake, as with Meta, which delivers only
   * to a callback URL that verified. A failed handshake is tried again on the
   * next delivery, so fixing the receiver is enough.
   */
  verifyToken?: string
}

export type HttpTransport = ((delivery: WebhookDelivery, attempt?: DeliveryAttempt) => Promise<void>) & {
  /** Run the handshake now; a pass is remembered, so deliveries skip it. */
  verify(): Promise<HandshakeResult>
  verifyCallback(url: string, verifyToken: string): Promise<HandshakeResult>
  reset(): void
  readonly callbackUrl: string
}

/**
 * Deliver over HTTP to a configured URL — server mode, and library mode when
 * the app under test is a real server. Only a 200 counts as delivered, as
 * with Meta; anything else fails the attempt and the deliverer retries it.
 */
export function httpTransport(url: string, options: HttpTransportOptions = {}): HttpTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS
  let main = endpoint(url, options.verifyToken, timeoutMs)
  // A WABA that subscribed with `override_callback_uri` gets its webhooks
  // there, after that URL passes the handshake with its own verify token.
  const overrides = new Map<string, Endpoint>()
  const override = (callbackUrl: string, verifyToken: string): Endpoint => {
    const key = `${callbackUrl}\n${verifyToken}`
    let target = overrides.get(key)
    if (!target) {
      target = endpoint(callbackUrl, verifyToken, timeoutMs)
      overrides.set(key, target)
    }
    return target
  }

  const send = async (delivery: WebhookDelivery, attempt?: DeliveryAttempt): Promise<void> => {
    const { callback } = delivery
    return callback
      ? override(callback.url, callback.verifyToken).send(delivery, attempt)
      : main.send(delivery, attempt)
  }
  return Object.assign(send, {
    callbackUrl: url,
    verify: () => main.verify(),
    verifyCallback: (callbackUrl: string, verifyToken: string) => override(callbackUrl, verifyToken).verify(),
    reset: () => {
      main = endpoint(url, options.verifyToken, timeoutMs)
      overrides.clear()
    },
  })
}

interface Endpoint {
  send(delivery: WebhookDelivery, attempt?: DeliveryAttempt): Promise<void>
  verify(): Promise<HandshakeResult>
}

/** One callback URL: its handshake state, and the POST itself. */
function endpoint(url: string, verifyToken: string | undefined, timeoutMs: number): Endpoint {
  let verified = verifyToken === undefined

  const verify = async (): Promise<HandshakeResult> => {
    if (verified) return { ok: true }
    const result = await verifyWebhookUrl(url, verifyToken!)
    verified = result.ok
    return result
  }

  const send = async (delivery: WebhookDelivery, attempt?: DeliveryAttempt): Promise<void> => {
    if (!verified) {
      const result = await verify()
      // An attempt no longer wanted is cancelled whatever the handshake said:
      // a failure here would be logged and retried for a webhook that ended.
      if (attempt && !attempt.isCurrent()) throw new DeliveryCancelled()
      if (!result.ok) throw new Error(`webhook url not verified: ${result.reason}`)
    }
    // Checked last, right before the POST and with nothing awaited after it.
    if (attempt && !attempt.isCurrent()) throw new DeliveryCancelled()
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': delivery.signature,
          'User-Agent': 'facebookplatform/1.0',
        },
        // The already-serialized body — re-stringifying here would break the
        // signature the receiver is about to verify.
        body: delivery.body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      // Name the timeout explicitly. "TimeoutError" alone sends people hunting
      // through their own code for a bug that is on the receiving end.
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`webhook receiver did not respond within ${timeoutMs}ms`)
      }
      throw err
    }
    if (response.status !== 200) {
      throw new Error(`webhook receiver returned HTTP ${response.status}, not 200`)
    }
  }
  return { send, verify }
}

/**
 * Hand the webhook straight to a callback — no socket, no port, no network.
 * This is what makes the full inbound → reply → status cycle testable in CI
 * with nothing listening (spec §8).
 */
export function inProcessTransport(
  handler: (delivery: WebhookDelivery, attempt?: DeliveryAttempt) => void | Promise<void>,
): WebhookTransport {
  return async (delivery, attempt) => {
    await handler(delivery, attempt)
  }
}

/** Discards everything. Useful when a mock is driven purely through inspection. */
export const nullTransport: WebhookTransport = async () => {}
