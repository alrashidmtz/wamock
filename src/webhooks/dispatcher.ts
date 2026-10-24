import type { ScenarioController } from '../core/scenario.js'
import type { MockState } from '../core/state.js'
import type { WebhookDeliverer } from './delivery.js'
import { buildStatusPayload } from './payloads.js'
import type { MessageStatus, UserIdentity, WebhookPayload } from './payloads.js'

/**
 * The fields a callback override applies to, from Meta's "Webhook overrides"
 * page. Every other field (template and account-level webhooks among them)
 * always goes to the app's own callback URL.
 */
export const OVERRIDABLE_FIELDS: ReadonlySet<string> = new Set([
  'messages',
  'message_echoes',
  'calls',
  'consumer_profile',
  'messaging_handovers',
  'standby',
  'group_lifecycle_update',
  'group_participants_update',
  'group_settings_update',
  'group_status_update',
  'smb_message_echoes',
  'smb_app_state_sync',
  'history',
  'account_settings_update',
])

/**
 * The single place a webhook can be handed to the delivery queue.
 *
 * Three rules live here, together, because every one of them applies to every
 * webhook and scattering them is how one gets forgotten:
 *
 * 1. **Subscription gate.** If the WABA has no subscribed app, Meta delivers
 *    NOTHING and reports no error. The mock reproduces the silence rather than
 *    inventing an error, because the silence IS the diagnosis problem.
 *    `account_update` is the exception: it is the partner's own field, and
 *    tells the partner a customer finished Embedded Signup, which happens
 *    before the partner can subscribe to that customer's WABA.
 * 2. **Per-tenant signing.** Each webhook is signed with the secret of the app
 *    that owns the delivering number, not a single global secret.
 * 3. **At-least-once.** Under the duplication scenario every webhook goes out
 *    twice, because Meta retries and receivers that assume exactly-once
 *    double-book, double-charge or double-reply.
 */
export class WebhookDispatcher {
  readonly #state: MockState
  readonly #deliverer: WebhookDeliverer
  readonly #scenario: ScenarioController

  constructor(state: MockState, deliverer: WebhookDeliverer, scenario: ScenarioController) {
    this.#state = state
    this.#deliverer = deliverer
    this.#scenario = scenario
  }

  /**
   * Queue a webhook for the app that owns `phoneNumberId`. Silently does
   * nothing when the number is unknown or its WABA is unsubscribed — see rule 1.
   */
  dispatch(phoneNumberId: string, payload: WebhookPayload, atMs?: number): void {
    const phoneNumber = this.#state.phoneNumber(phoneNumberId)
    if (!phoneNumber) return
    this.#enqueue(phoneNumber.wabaId, phoneNumberId, payload, atMs)
  }

  /**
   * Queue an account-level webhook (template status, messaging limits) for the
   * app that owns `wabaId`. These belong to the WABA, not to a number: routing
   * them through "some number on the WABA" silently skips a WABA that has none
   * yet, which is exactly the state right after a tech-provider signup.
   */
  dispatchToWaba(wabaId: string, payload: WebhookPayload, atMs?: number): void {
    this.#enqueue(wabaId, undefined, payload, atMs)
  }

  #enqueue(wabaId: string, phoneNumberId: string | undefined, payload: WebhookPayload, atMs?: number): void {
    const field = payload.entry[0]?.changes[0]?.field
    const partnerField = field === 'account_update'
    const overridable = field !== undefined && OVERRIDABLE_FIELDS.has(field)
    if (!partnerField && !this.#state.isSubscribed(wabaId)) return

    const appSecret = this.#state.appSecretForWaba(wabaId)
    // No secret means nothing to sign with. Callers validate the WABA first,
    // so reaching here is a bug in the mock, not a user error.
    if (!appSecret) return

    // Re-read at every attempt: unsubscribing stops even a delivery already
    // queued or being retried, and a new override applies to it. The number's
    // override comes first, then its WABA's, then the app's own URL.
    const route = () => {
      if (!partnerField && !this.#state.isSubscribed(wabaId)) return undefined
      if (!overridable) return {}
      const override =
        (phoneNumberId !== undefined ? this.#state.phoneNumber(phoneNumberId)?.callbackOverride : undefined) ??
        this.#state.waba(wabaId)?.callbackOverride
      return override ? { callback: override } : {}
    }
    const copies = this.#scenario.config.duplicateWebhooks ? 2 : 1
    for (let i = 0; i < copies; i++) {
      this.#deliverer.enqueue(payload, { appSecret, route, ...(atMs !== undefined ? { atMs } : {}) })
    }
  }

  /** The app's own callback URL, where non-overridden webhooks go. */
  appCallbackUrl(): string | undefined {
    return this.#deliverer.callbackUrl()
  }

  /** Build and dispatch a delivery status for a message. */
  dispatchStatus(
    phoneNumberId: string,
    options: {
      messageId: string
      status: MessageStatus
      user: UserIdentity
      sentTo: 'phone' | 'user_id'
      timestampMs: number
      errorCode?: number
      conversation?: Record<string, unknown>
      pricing?: Record<string, unknown>
      bizOpaqueCallbackData?: string
      atMs?: number
    },
  ): void {
    const phoneNumber = this.#state.phoneNumber(phoneNumberId)
    if (!phoneNumber) return

    this.dispatch(
      phoneNumberId,
      buildStatusPayload({
        wabaId: phoneNumber.wabaId,
        phoneNumberId,
        displayPhoneNumber: phoneNumber.displayPhoneNumber,
        messageId: options.messageId,
        status: options.status,
        user: options.user,
        sentTo: options.sentTo,
        timestampMs: options.timestampMs,
        ...(options.errorCode !== undefined ? { errorCode: options.errorCode } : {}),
        ...(options.conversation ? { conversation: options.conversation } : {}),
        ...(options.pricing ? { pricing: options.pricing } : {}),
        ...(options.bizOpaqueCallbackData !== undefined
          ? { bizOpaqueCallbackData: options.bizOpaqueCallbackData }
          : {}),
      }),
      options.atMs,
    )
  }
}
