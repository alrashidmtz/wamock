import type { Clock } from '../core/clock.js'
import type { WebhookPayload } from './payloads.js'
import { signBody } from './signature.js'
import type { WebhookDelivery, WebhookTransport } from './transport.js'

/**
 * The outbound webhook queue.
 *
 * Everything the mock sends as Meta goes through here, scheduled on the virtual
 * clock. Two consequences worth stating:
 *
 * - **Serialization happens once.** The body is stringified, then signed, then
 *   sent — the same bytes throughout. Signing a re-serialized copy is the
 *   classic way to ship a mock whose signatures verify only by luck.
 * - **A failing receiver is isolated.** `advance()` is synchronous and drives
 *   every scheduled effect; if one unreachable webhook URL could throw out of
 *   it, a single bad transport would stop unrelated timers. Failures are
 *   captured in the log instead.
 */

export interface DeliveryRecord extends WebhookDelivery {
  ok: boolean
  /** Message of the transport failure, when `ok` is false. */
  error?: string
}

export interface EnqueueOptions {
  /** Secret of the app that "delivers" this webhook (spec §5.2). */
  appSecret: string
  /** Virtual time to deliver at. Defaults to now. */
  atMs?: number
}

export interface WebhookDelivererOptions {
  clock: Clock
  transport: WebhookTransport
  /** Cap on retained delivery records. Oldest are evicted first. */
  maxLogEntries?: number
}

/** Same reasoning as the outbound cap: bounded memory, never a silent drop. */
const DEFAULT_MAX_LOG_ENTRIES = 10_000

export class WebhookDeliverer {
  readonly #clock: Clock
  #transport: WebhookTransport
  #log: DeliveryRecord[] = []
  #droppedLogEntries = 0
  readonly #maxLogEntries: number
  /** Timer ids for deliveries not yet fired, so `clear()` can cancel them. */
  #pending = new Set<number>()
  /** In-flight transport promises, awaited by `settle()`. */
  #inFlight = new Set<Promise<void>>()

  constructor(options: WebhookDelivererOptions) {
    this.#clock = options.clock
    this.#transport = options.transport
    this.#maxLogEntries = options.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES
  }

  /** Swap the transport at runtime — the server does this when a webhook URL is (re)configured. */
  setTransport(transport: WebhookTransport): void {
    this.#transport = transport
  }

  enqueue(payload: WebhookPayload, options: EnqueueOptions): void {
    const body = JSON.stringify(payload)
    const signature = signBody(options.appSecret, body)

    const timerId = this.#clock.at(options.atMs ?? this.#clock.now(), () => {
      this.#pending.delete(timerId)
      this.#send({ body, signature, payload, deliveredAt: this.#clock.now() })
    })
    this.#pending.add(timerId)
  }

  /**
   * Resolve once every fired delivery has finished. `advance()` returns as soon
   * as timers have run; the transport promises they started may still be open.
   * Loops because a transport can itself enqueue more work.
   */
  async settle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.all([...this.#inFlight])
    }
  }

  /** Everything delivered so far, successes and failures alike. */
  log(): DeliveryRecord[] {
    return [...this.#log]
  }

  /** How many delivery records the cap evicted. Reported, never silent. */
  droppedLogEntries(): number {
    return this.#droppedLogEntries
  }

  /** Drop the log and cancel anything still scheduled. Part of `reset()`. */
  clear(): void {
    for (const timerId of this.#pending) this.#clock.clear(timerId)
    this.#pending.clear()
    this.#log = []
    this.#droppedLogEntries = 0
  }

  #record(entry: DeliveryRecord): void {
    this.#log.push(entry)
    if (this.#log.length > this.#maxLogEntries) {
      this.#log.shift()
      this.#droppedLogEntries++
    }
  }

  #send(delivery: WebhookDelivery): void {
    const attempt = this.#transport(delivery)
      .then(() => {
        this.#record({ ...delivery, ok: true })
      })
      .catch((err: unknown) => {
        this.#record({
          ...delivery,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        this.#inFlight.delete(attempt)
      })

    this.#inFlight.add(attempt)
  }
}
