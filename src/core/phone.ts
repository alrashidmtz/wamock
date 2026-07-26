/**
 * Phone number handling, and the single most important quirk wamock
 * reproduces on purpose.
 *
 * Meta is *asymmetric* about the leading `+`:
 *   - `contacts[].wa_id`, `messages[].from`, `statuses[].recipient_id` → digits ONLY
 *   - `metadata.display_phone_number`                                  → WITH `+`
 *
 * Integrations routinely normalize one and forget the other, ending up with two
 * different keys for the same human. That breaks opt-out lookups, session keys
 * and dedupe — and it only shows up against real traffic. wamock keeps the
 * asymmetry instead of smoothing it over, because smoothing it over is exactly
 * what lets the bug reach production.
 */

/** E.164 allows at most 15 digits; anything longer is not a real number. */
const MAX_DIGITS = 15
/** Shortest plausible national+country number. Below this Meta rejects the send. */
const MIN_DIGITS = 7

/**
 * Reduce anything a caller might send in `to` to Meta's `wa_id` form: digits
 * only, no `+`, no punctuation. Returns `null` when the input could not be a
 * phone number — the caller maps that to a Graph error rather than guessing.
 */
export function normalizeWaId(input: string): string | null {
  const digits = input.replace(/\D/g, '')
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null
  return digits
}

/** Render a business number the way Meta puts it in `metadata.display_phone_number`. */
export function toDisplayPhoneNumber(digits: string): string {
  return digits.startsWith('+') ? digits : `+${digits.replace(/\D/g, '')}`
}
