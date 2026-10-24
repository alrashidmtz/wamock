import { ERROR_CODES, GraphError, unsupportedRequest } from '../errors/graph-error.js'
import type { MockContext } from './context.js'
import type { PhoneNumber, Waba } from './types.js'

/**
 * Validations shared by more than one service, kept in one place so the error
 * wording stays identical everywhere. Integrations match on these strings.
 */

/** The WABA, or Graph's unsupported-request error for the verb of the call. */
export function requireWaba(context: MockContext, wabaId: string, method: 'get' | 'post' | 'delete' = 'post'): Waba {
  const waba = context.state.waba(wabaId)
  if (!waba) throw unsupportedRequest(method, wabaId)
  return waba
}

/** The number, or Graph's unsupported-request error for the verb of the call. */
export function requirePhoneNumber(
  context: MockContext,
  phoneNumberId: string,
  method: 'get' | 'post' | 'delete' = 'post',
): PhoneNumber {
  const phoneNumber = context.state.phoneNumber(phoneNumberId)
  if (!phoneNumber) throw unsupportedRequest(method, phoneNumberId)
  return phoneNumber
}

/**
 * Validate a bearer token — but only one wamock itself issued.
 *
 * Three cases, and the middle one is the important one:
 *
 * - **No token.** Fine. Most users never touch tokens and requiring one would
 *   add three steps to the quickstart for no benefit.
 * - **A token wamock did not issue.** Also fine. wamock is not an auth server
 *   and cannot tell a real WABA token from a random string. Rejecting these
 *   would 401 every real client, because real clients always send their own
 *   token — a dogfood run against a production-shaped client found exactly
 *   that, and it broke the drop-in promise completely.
 * - **A token wamock issued.** Fully validated: expiry, revocation, scope.
 *   This is what keeps the "expires between connect and first send" scenario
 *   (spec §9.2) reproducible, which is the whole reason token emulation exists.
 */
export function assertToken(
  context: MockContext,
  accessToken: string | undefined,
  scopes: readonly string[] = [],
): void {
  if (accessToken === undefined) return
  if (!context.tokens.isKnown(accessToken)) return

  if (!context.tokens.isValid(accessToken, context.clock.now())) {
    throw new GraphError(ERROR_CODES.TOKEN_EXPIRED)
  }
  const missing = scopes.filter((scope) => !context.tokens.hasScope(accessToken, scope))
  if (missing.length > 0) {
    throw new GraphError(ERROR_CODES.PERMISSION_DENIED, {
      details: `The access token does not have the required permission: ${missing.join(', ')}`,
    })
  }
}
