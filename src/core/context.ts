import type { WebhookDispatcher } from '../webhooks/dispatcher.js'
import type { VirtualClock } from './clock.js'
import type { Conversations } from './conversations.js'
import type { MessagingLimits } from './limits.js'
import type { ScenarioController } from './scenario.js'
import type { MockState } from './state.js'
import type { TokenStore } from './tokens.js'
import type { ServiceWindows } from './window.js'

/**
 * The collaborators every service needs, passed in rather than reached for.
 *
 * Services depend on this interface, not on the engine that assembles it, so
 * each one can be exercised against a hand-built context with a frozen clock
 * and nothing else. It is also what keeps the engine a composition root
 * instead of a place where behaviour accumulates.
 */
export interface MockContext {
  readonly clock: VirtualClock
  readonly state: MockState
  readonly scenario: ScenarioController
  readonly windows: ServiceWindows
  readonly conversations: Conversations
  readonly tokens: TokenStore
  readonly limits: MessagingLimits
  readonly dispatcher: WebhookDispatcher
}
