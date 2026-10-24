import type { Clock } from '../core/clock.js'
import type { WebhookPayload } from './payloads.js'
import { signBody } from './signature.js'
import type { HandshakeResult } from './handshake.js'
import { DeliveryCancelled } from './transport.js'
import type { DeliveryAttempt, WebhookDelivery, WebhookTransport } from './transport.js'

/**
 * Meta retries a webhook the receiver did not take "with decreasing frequency
 * until the request succeeds, for up to 7 days". The exact schedule is not
 * published; wamock doubles the gap from one minute, which keeps the shape
 * (quick at first, sparse later, nothing after 7 days) without inventing a
 * timetable to rely on.
 */
const FIRST_RETRY_MS = 60 * 1000
const RETRY_FOR_MS = 7 * 24 * 60 * 60 * 1000

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
  /**
   * Asked before every attempt, retries included: where the webhook goes now
   * (`callback`, the WABA's override, if any), or undefined when it must not
   * go at all because the app unsubscribed. Meta stops deliveries at once.
   */
  route?: () => { callback?: { url: string; verifyToken: string } } | undefined
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
  /** Bumped by `clear()`, so retries of an earlier generation are dropped. */
  #generation = 0
  /** In-flight transport promises, awaited by `settle()`. */
  #inFlight = new Map<number, Promise<void>>()
  /** Numbers attempts in the order they start; see `settle()`. */
  #attemptSeq = 0

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

    this.#schedule(options.atMs ?? this.#clock.now(), { body, signature, payload }, options.route, 0, undefined)
  }

  /**
   * One attempt at `atMs`. A failure schedules the next one, the gap doubling,
   * until 7 days have passed since the first attempt.
   */
  #schedule(
    atMs: number,
    delivery: Omit<WebhookDelivery, 'deliveredAt' | 'callback'>,
    route: EnqueueOptions['route'],
    attempt: number,
    firstAttemptAt: number | undefined,
    rerouted = false,
  ): void {
    const timerId = this.#clock.at(atMs, () => {
      this.#pending.delete(timerId)
      const target = route ? route() : {}
      if (!target) return
      const now = this.#clock.now()
      const first = firstAttemptAt ?? now
      const callback = target.callback ? { callback: target.callback } : {}
      const generation = this.#generation
      // Current means: same generation, still routed, and to the same place.
      // A callback replaced while this attempt waited is not where it goes.
      const destination = JSON.stringify(target.callback ?? null)
      // Why the attempt stopped being current, fixed the first time it is
      // observed. Deciding later would read a state that may have changed
      // again: a re-subscription must not revive what an unsubscribe ended.
      let cause: 'ended' | 'moved' | undefined
      const observe = (): 'ended' | 'moved' | undefined => {
        if (generation !== this.#generation) return 'ended'
        const current = route ? route() : {}
        if (current === undefined) return 'ended'
        return JSON.stringify(current.callback ?? null) === destination ? undefined : 'moved'
      }
      // `ended` is terminal and beats `moved`: a moved webhook whose app then
      // unsubscribed is over, not rerouted.
      const isCurrent = () => {
        const seen = cause === 'ended' ? 'ended' : observe()
        if (seen === 'ended' || cause === undefined) cause = seen
        return cause === undefined
      }
      this.#send({ ...delivery, ...callback, deliveredAt: now }, { isCurrent, ...(rerouted ? { rerouted } : {}) }, {
        retry: () => {
          // The attempt settles after the clock moved on; a retry already due
          // goes out on the next tick rather than back in time.
          const next = Math.max(now + FIRST_RETRY_MS * 2 ** attempt, this.#clock.now())
          if (next - first <= RETRY_FOR_MS) this.#schedule(next, delivery, route, attempt + 1, first)
        },
        // Cancelled because the callback moved: the webhook still belongs to
        // the WABA, so it goes to the new place now, as the same attempt.
        // Cancelled because the app unsubscribed: it ends here, and a later
        // subscription does not revive it.
        reroute: () => {
          if (cause === 'ended' || observe() === 'ended') return
          if ((cause ?? observe()) !== 'moved') return
          this.#schedule(this.#clock.now(), delivery, route, attempt, first, true)
        },
      })
    })
    this.#pending.add(timerId)
  }

  /**
   * Resolve once every fired delivery has finished.
   *
   * The loop terminates without needing a bound, unlike the clock's drain:
   * a delivery only enters `#inFlight` when a clock timer fires, and in frozen
   * mode timers fire only from `advance()`, which `settle()` never calls. A
   * transport that enqueues more work therefore schedules it for a later
   * `advance()` rather than feeding this loop.
   */
  async settle(from = 0): Promise<void> {
    // Only attempts numbered `from` or later: a call waits for what started
    // after it did — what it set off, and what that set off — never for an
    // attempt already running. Waits therefore point forward in time only and
    // cannot form a cycle: not a handler waiting on its own delivery, not two
    // handlers waiting on each other, not a receiver that calls back over HTTP.
    while (this.hasInFlight(from)) {
      const due: Array<Promise<void>> = []
      for (const [seq, promise] of this.#inFlight) if (seq >= from) due.push(promise)
      await Promise.all(due)
    }
  }

  /**
   * Whether any attempt numbered `from` or later is still running. Answers at
   * once when none has started since `from` — the usual case for a call made
   * from inside a delivery — instead of scanning every attempt in flight:
   * measured, that scan made a runaway receiver take 45s instead of about one.
   */
  hasInFlight(from = 0): boolean {
    if (from >= this.#attemptSeq) return false
    for (const seq of this.#inFlight.keys()) if (seq >= from) return true
    return false
  }

  /** The number the next attempt will get: pass it to `settle()` to wait for what follows. */
  nextAttempt(): number {
    return this.#attemptSeq
  }

  /** Everything delivered so far, successes and failures alike. */
  log(): DeliveryRecord[] {
    return [...this.#log]
  }

  /** How many delivery records the cap evicted. Reported, never silent. */
  droppedLogEntries(): number {
    return this.#droppedLogEntries
  }

  /** Deliveries attempted so far, evicted ones included, failures too. */
  deliveredCount(): number {
    return this.#log.length + this.#droppedLogEntries
  }

  /**
   * Where things stand for a caller waiting from attempt `from`: changes when
   * a reset starts a new generation, an attempt starts, or one of the
   * caller's attempts (numbered `from` on) finishes, whatever the outcome:
   * delivered, failed or cancelled (which logs nothing but may reroute).
   * `flush()` repeats a round while it changes. Attempts that are not the
   * caller's — running before it began — do not move it: counting them let
   * a long queue of earlier deliveries use up a later request's rounds.
   */
  progressSince(from: number): string {
    let running = 0
    for (const seq of this.#inFlight.keys()) if (seq >= from) running++
    return `${this.#generation}:${this.#attemptSeq}:${running}`
  }

  /** The app's callback URL, when the transport delivers to one. */
  callbackUrl(): string | undefined {
    return this.#transport.callbackUrl
  }

  /** The transport's handshake, for a WABA's callback override. */
  async verifyCallback(url: string, verifyToken: string): Promise<HandshakeResult> {
    return this.#transport.verifyCallback ? this.#transport.verifyCallback(url, verifyToken) : { ok: true }
  }

  /** Drop the log and cancel anything still scheduled. Part of `reset()`. */
  clear(): void {
    this.#generation++
    this.#transport.reset?.()
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

  #send(
    delivery: WebhookDelivery,
    current: DeliveryAttempt,
    next: { retry: () => void; reroute: () => void },
  ): void {
    // A cleared queue must not be refilled by an attempt that was in flight.
    const generation = this.#generation
    const id = this.#attemptSeq++
    const attempt = this.#transport(delivery, current)
      .then(() => {
        if (generation === this.#generation) this.#record({ ...delivery, ok: true })
      })
      .catch((err: unknown) => {
        // An attempt from before a `clear()` belongs to the log that was
        // cleared: recording it would leak the last test into the next.
        if (generation !== this.#generation) return
        // A cancelled attempt sent nothing: no failure to log or retry.
        if (err instanceof DeliveryCancelled) return next.reroute()
        this.#record({
          ...delivery,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
        next.retry()
      })
      .finally(() => {
        this.#inFlight.delete(id)
      })

    this.#inFlight.set(id, attempt)
  }
}
