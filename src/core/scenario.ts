/**
 * Scenario control (spec §6.5) — making the production-only failures happen
 * on demand.
 *
 * ## Two failure axes, not one
 *
 * "Failure rate" sounds like one number and is really two:
 *
 * - **`sendFailureRate`** — `POST /messages` returns an error. The app finds
 *   out immediately and can retry or fall back.
 * - **`webhookFailureRate`** — the send succeeds but the webhook never
 *   arrives. The app believes everything is fine and only notices when
 *   something times out, if it notices at all.
 *
 * The second is the one that costs money in production, and collapsing both
 * into a single knob makes it impossible to test on its own. They are separate
 * here for that reason.
 *
 * ## Seeded randomness
 *
 * Every random decision comes from a seeded PRNG. A flaky-failure scenario
 * whose flakiness is itself unreproducible is not a test, it is a lottery — you
 * could not rerun the sequence that broke. Same seed, same run, always.
 */

export interface LatencyRange {
  min: number
  max: number
}

export interface ForcedError {
  code: number
  /** How many sends to fail. Defaults to 1. */
  times?: number
}

export interface ScenarioConfig {
  seed: number
  /** Delay before a webhook is delivered. Fixed, or sampled from a range. */
  latencyMs: number | LatencyRange
  /** 0..1 chance that `POST /messages` fails outright. */
  sendFailureRate: number
  /** 0..1 chance that an accepted message's webhook never arrives. */
  webhookFailureRate: number
  /** Deliver every webhook twice — Meta is at-least-once, not exactly-once. */
  duplicateWebhooks: boolean
  /** Deliver `delivered` before `sent`. Happens in production; breaks state machines. */
  outOfOrderStatuses: boolean
  /** Force the next send(s) to fail with a specific code. Beats the random rate. */
  nextError?: ForcedError
}

const DEFAULTS: ScenarioConfig = {
  seed: 1,
  latencyMs: 0,
  sendFailureRate: 0,
  webhookFailureRate: 0,
  duplicateWebhooks: false,
  outOfOrderStatuses: false,
}

/**
 * mulberry32 — small, fast, and good enough for scheduling decisions. Chosen
 * over Math.random precisely because it takes a seed.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class ScenarioController {
  #config: ScenarioConfig = { ...DEFAULTS }
  #random = mulberry32(DEFAULTS.seed)
  #forcedRemaining = 0

  get config(): Readonly<ScenarioConfig> {
    return this.#config
  }

  /** Merge a partial update. Setting `seed` restarts the random sequence. */
  configure(update: Partial<ScenarioConfig>): void {
    assertRate('sendFailureRate', update.sendFailureRate)
    assertRate('webhookFailureRate', update.webhookFailureRate)
    assertLatency(update.latencyMs)

    this.#config = { ...this.#config, ...update }

    if (update.seed !== undefined) this.#random = mulberry32(update.seed)
    if (update.nextError !== undefined) this.#forcedRemaining = update.nextError.times ?? 1
  }

  reset(): void {
    this.#config = { ...DEFAULTS }
    this.#random = mulberry32(DEFAULTS.seed)
    this.#forcedRemaining = 0
  }

  /**
   * The code the next send should fail with, if one was forced. Consumes one
   * use. Checked before the random rate so a deliberate scenario is never
   * overridden by chance.
   */
  takeForcedError(): number | undefined {
    if (this.#forcedRemaining <= 0 || !this.#config.nextError) return undefined
    this.#forcedRemaining--
    return this.#config.nextError.code
  }

  shouldFailSend(): boolean {
    return this.#roll(this.#config.sendFailureRate)
  }

  shouldDropWebhook(): boolean {
    return this.#roll(this.#config.webhookFailureRate)
  }

  /** How long to hold the next webhook before delivering it. */
  latency(): number {
    const configured = this.#config.latencyMs
    if (typeof configured === 'number') return configured
    return Math.round(configured.min + this.#random() * (configured.max - configured.min))
  }

  #roll(rate: number): boolean {
    // Short-circuit at 0 so an inert scenario never consumes randomness, which
    // keeps the sequence stable when unrelated knobs are turned on.
    if (rate <= 0) return false
    return this.#random() < rate
  }
}

function assertRate(name: string, value: number | undefined): void {
  if (value === undefined) return
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`)
  }
}

function assertLatency(value: number | LatencyRange | undefined): void {
  if (value === undefined || typeof value === 'number') return
  if (value.min > value.max) {
    throw new RangeError('latencyMs.min must not exceed latencyMs.max')
  }
}
