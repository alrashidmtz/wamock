/**
 * The virtual clock. Every time-dependent behaviour in wamock — the 24h service
 * window, scheduled delivery statuses, token expiry, media URL expiry — reads
 * time from here and nowhere else (enforced by an ESLint rule; this file is the
 * only exemption).
 *
 * That indirection is the whole reason the 24h window is testable: `advance()`
 * moves time forward and drains every effect that was scheduled in between, in
 * deadline order, synchronously. Without it you would have to actually wait a
 * day to test re-engagement.
 */

/** Wall-clock replacement. Implementations must fire timers in deadline order. */
export interface Clock {
  /** Current virtual time, in epoch milliseconds. */
  now(): number
  /** Schedule `fn` to run when virtual time reaches `timestampMs`. Returns a cancellable id. */
  at(timestampMs: number, fn: () => void): number
  /** Cancel a scheduled timer. Unknown ids are ignored. */
  clear(id: number): void
  /** Move virtual time forward by `ms`, firing everything that comes due. */
  advance(ms: number): void
}

export interface VirtualClockOptions {
  /**
   * `frozen` — time only moves via `advance()`. This is the mode for tests and
   * the library mode: fully deterministic, no wall-clock flakiness.
   *
   * `live` — time tracks the wall clock (plus any accumulated `advance()`
   * offset), and a background tick fires due timers on its own. This is the
   * mode for the standalone server, where a developer expects a delivery
   * receipt to show up without poking a control endpoint.
   */
  mode?: 'frozen' | 'live'
  /** Starting epoch ms. Defaults to the wall clock. Only meaningful when frozen. */
  start?: number
  /** How often the live tick drains due timers. Ignored when frozen. */
  tickMs?: number
}

interface Timer {
  id: number
  at: number
  fn: () => void
}

/**
 * Guards against a callback that reschedules itself at the same instant
 * forever. Real workloads chain a handful of statuses per message; anything
 * near this bound is a bug, and hanging is a worse failure than throwing.
 */
const MAX_DRAIN_ITERATIONS = 100_000

export class VirtualClock implements Clock {
  readonly #mode: 'frozen' | 'live'
  readonly #tickMs: number
  /** Frozen mode only: the fixed base that `#offset` is added to. */
  readonly #base: number
  /** Accumulated `advance()` time. In live mode it rides on top of wall time. */
  #offset = 0
  readonly #timers = new Map<number, Timer>()
  #nextId = 1
  #tick: ReturnType<typeof setInterval> | undefined

  constructor(options: VirtualClockOptions = {}) {
    this.#mode = options.mode ?? 'frozen'
    this.#tickMs = options.tickMs ?? 25
    this.#base = options.start ?? Date.now()
  }

  /** Whether time only moves via `advance()`. Nothing else will fire a due timer. */
  get frozen(): boolean {
    return this.#mode === 'frozen'
  }

  now(): number {
    return (this.#mode === 'frozen' ? this.#base : Date.now()) + this.#offset
  }

  at(timestampMs: number, fn: () => void): number {
    const id = this.#nextId++
    this.#timers.set(id, { id, at: timestampMs, fn })
    return id
  }

  clear(id: number): void {
    this.#timers.delete(id)
  }

  advance(ms: number): void {
    if (ms < 0) throw new RangeError('Clock.advance() cannot take a negative duration')
    this.#drainUntil(this.now() + ms)
  }

  /** Start the background tick (live mode only). No-op when frozen or already started. */
  start(): void {
    if (this.#mode === 'frozen' || this.#tick) return
    this.#tick = setInterval(() => this.#drainUntil(this.now()), this.#tickMs)
    // Never hold the process open on our account — a mock that won't exit is
    // a mock that hangs someone's CI.
    this.#tick.unref?.()
  }

  /** Stop the background tick. Idempotent. */
  stop(): void {
    if (!this.#tick) return
    clearInterval(this.#tick)
    this.#tick = undefined
  }

  /**
   * Run every timer due at or before `target`, each observing `now()` as its
   * own deadline, then land on `target`.
   *
   * Timers are re-scanned on each iteration rather than sorted once, because a
   * callback may schedule new work (the status chain does exactly this:
   * `sent` schedules `delivered`) and that work must fire in the same drain if
   * it also comes due.
   */
  #drainUntil(target: number): void {
    for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
      const due = this.#earliestDueAt(target)
      if (!due) {
        this.#setNow(target)
        return
      }
      this.#timers.delete(due.id)
      // Never step backwards: a timer whose deadline already passed fires at
      // the current instant instead of rewinding the clock under other effects.
      this.#setNow(Math.max(this.now(), due.at))
      due.fn()
    }
    throw new Error(
      `Clock.advance() exceeded ${MAX_DRAIN_ITERATIONS} timer iterations — a callback is very likely rescheduling itself without making progress`,
    )
  }

  #earliestDueAt(target: number): Timer | undefined {
    let earliest: Timer | undefined
    for (const timer of this.#timers.values()) {
      if (timer.at > target) continue
      if (!earliest || timer.at < earliest.at || (timer.at === earliest.at && timer.id < earliest.id)) {
        earliest = timer
      }
    }
    return earliest
  }

  #setNow(instant: number): void {
    this.#offset = instant - (this.#mode === 'frozen' ? this.#base : Date.now())
  }
}
