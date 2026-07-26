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
}

/**
 * How a webhook reaches the integration under test. Rejecting marks the
 * delivery failed in the log; it never breaks the clock drain.
 */
export type WebhookTransport = (delivery: WebhookDelivery) => Promise<void>

/**
 * Deliver over HTTP to a configured URL — server mode, and library mode when
 * the app under test is a real server.
 */
export function httpTransport(url: string): WebhookTransport {
  return async (delivery) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': delivery.signature,
        'User-Agent': 'facebookplatform/1.0',
      },
      // The already-serialized body — re-stringifying here would break the
      // signature the receiver is about to verify.
      body: delivery.body,
    })
    if (!response.ok) {
      throw new Error(`webhook receiver returned HTTP ${response.status}`)
    }
  }
}

/**
 * Hand the webhook straight to a callback — no socket, no port, no network.
 * This is what makes the full inbound → reply → status cycle testable in CI
 * with nothing listening (spec §8).
 */
export function inProcessTransport(
  handler: (delivery: WebhookDelivery) => void | Promise<void>,
): WebhookTransport {
  return async (delivery) => {
    await handler(delivery)
  }
}

/** Discards everything. Useful when a mock is driven purely through inspection. */
export const nullTransport: WebhookTransport = async () => {}
