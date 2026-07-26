import type { ScenarioController } from '../core/scenario.js'
import type { MockState } from '../core/state.js'
import type { WebhookDeliverer } from './delivery.js'
import { buildStatusPayload } from './payloads.js'
import type { WebhookPayload } from './payloads.js'

/**
 * The single place a webhook can be handed to the delivery queue.
 *
 * Three rules live here, together, because every one of them applies to every
 * webhook and scattering them is how one gets forgotten:
 *
 * 1. **Subscription gate.** If the WABA has no subscribed app, Meta delivers
 *    NOTHING and reports no error. The mock reproduces the silence rather than
 *    inventing an error, because the silence IS the diagnosis problem.
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
    if (!this.#state.isSubscribed(phoneNumber.wabaId)) return

    const appSecret = this.#state.appSecretForPhoneNumber(phoneNumberId)
    // No secret means nothing to sign with. Callers validate the number first,
    // so reaching here is a bug in the mock, not a user error.
    if (!appSecret) return

    const copies = this.#scenario.config.duplicateWebhooks ? 2 : 1
    for (let i = 0; i < copies; i++) {
      this.#deliverer.enqueue(payload, { appSecret, ...(atMs !== undefined ? { atMs } : {}) })
    }
  }

  /** Build and dispatch a delivery status for a message. */
  dispatchStatus(
    phoneNumberId: string,
    options: {
      messageId: string
      status: 'sent' | 'delivered' | 'read' | 'failed'
      recipientId: string
      timestampMs: number
      errorCode?: number
      conversation?: Record<string, unknown>
      pricing?: Record<string, unknown>
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
        recipientId: options.recipientId,
        timestampMs: options.timestampMs,
        ...(options.errorCode !== undefined ? { errorCode: options.errorCode } : {}),
        ...(options.conversation ? { conversation: options.conversation } : {}),
        ...(options.pricing ? { pricing: options.pricing } : {}),
      }),
      options.atMs,
    )
  }
}
