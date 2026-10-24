import type { UserIdentity } from '../webhooks/payloads.js'
import type { MockContext } from './context.js'

/**
 * Everything a webhook needs to know about a user, as seen by one business
 * number right now: their BSUID in that number's portfolio, their profile,
 * and whether their phone number may be disclosed.
 */
export function userIdentity(context: MockContext, phoneNumberId: string, waId: string): UserIdentity {
  const { users, state, clock } = context
  const businessId = state.businessIdOf(phoneNumberId) ?? state.defaultBusinessId
  const profile = users.profile(waId)
  return {
    waId,
    userId: users.bsuid(businessId, waId),
    phoneShared: users.phoneShareable(phoneNumberId, waId, clock.now()),
    ...(profile.name !== undefined ? { name: profile.name } : {}),
    ...(profile.username !== undefined ? { username: profile.username } : {}),
  }
}
