/**
 * Whether a string is an http(s) URL: what Meta can fetch media from, what a
 * call-to-action button can open, and where a webhook can be delivered.
 */
export function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** A plain object: not null, not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
