import { ERROR_CODES, GraphError } from '../errors/graph-error.js'
import type { MockContext } from './context.js'
import type { PhoneNumber, Waba } from './types.js'

/**
 * Validations shared by more than one service, kept in one place so the error
 * wording stays identical everywhere. Integrations match on these strings.
 */

/** Meta's wording for an object id it does not recognize. */
const unknownObject = (id: string): GraphError =>
  new GraphError(ERROR_CODES.INVALID_PARAMETER, {
    message: 'Unsupported post request',
    details: `Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
  })

export function requireWaba(context: MockContext, wabaId: string): Waba {
  const waba = context.state.waba(wabaId)
  if (!waba) throw unknownObject(wabaId)
  return waba
}

export function requirePhoneNumber(context: MockContext, phoneNumberId: string): PhoneNumber {
  const phoneNumber = context.state.phoneNumber(phoneNumberId)
  if (!phoneNumber) throw unknownObject(phoneNumberId)
  return phoneNumber
}

/**
 * Validate a bearer token, if one was supplied.
 *
 * Absent is deliberately fine: most users never touch tokens and requiring one
 * would add three steps to the quickstart for no benefit. But a token that IS
 * supplied must hold up — that is what makes the "expires between connect and
 * first send" scenario reproducible.
 */
export function assertToken(
  context: MockContext,
  accessToken: string | undefined,
  scope?: string,
): void {
  if (accessToken === undefined) return

  if (!context.tokens.isValid(accessToken, context.clock.now())) {
    throw new GraphError(ERROR_CODES.TOKEN_EXPIRED)
  }
  if (scope !== undefined && !context.tokens.hasScope(accessToken, scope)) {
    throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
      message: 'Permissions error',
      details: `The access token does not have the required permission: ${scope}`,
    })
  }
}
