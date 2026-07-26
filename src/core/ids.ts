/**
 * Deterministic id generation.
 *
 * Real Meta ids are opaque and random. wamock's are opaque but *derived*, so
 * that the same sequence of calls after a `reset()` produces byte-identical
 * ids. That is what lets a test assert on a specific wamid, and what keeps CI
 * from going red because a random id changed.
 */

const encode = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')

/**
 * A message id in Meta's shape: `wamid.` + an opaque base64url blob. Derived
 * from the sending number and a per-state counter.
 */
export function makeWamid(phoneNumberId: string, seq: number): string {
  return `wamid.${encode(`${phoneNumberId}:${seq}`)}`
}

/**
 * The trace id Meta attaches to every Graph error. Integrations log it; some
 * assert on its presence. Fixed width so it looks like the real thing.
 */
export function makeFbtraceId(seq: number): string {
  return `A${String(seq).padStart(22, '0')}`
}

/** Media ids are long numeric strings in Meta's API, not base64. */
export function makeMediaId(seq: number): string {
  return String(1_000_000_000_000_000n + BigInt(seq))
}
