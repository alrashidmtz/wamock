import { describe, expect, it } from 'vitest'

import { ScenarioController } from '../../src/core/scenario.js'

describe('ScenarioController — defaults', () => {
  it('starts inert: nothing fails, nothing duplicates, nothing is delayed', () => {
    // A mock that misbehaves by default is a mock nobody trusts. Chaos is
    // opt-in.
    const s = new ScenarioController()

    expect(s.shouldFailSend()).toBe(false)
    expect(s.shouldDropWebhook()).toBe(false)
    expect(s.config.duplicateWebhooks).toBe(false)
    expect(s.config.outOfOrderStatuses).toBe(false)
    expect(s.latency()).toBe(0)
  })
})

describe('ScenarioController — determinism', () => {
  it('produces the same decisions for the same seed', () => {
    // Randomness without a seed makes a flaky-failure scenario itself flaky:
    // you could not reproduce the run that broke.
    const runs = [0, 1].map(() => {
      const s = new ScenarioController()
      s.configure({ seed: 42, sendFailureRate: 0.5 })
      return Array.from({ length: 20 }, () => s.shouldFailSend())
    })

    expect(runs[0]).toEqual(runs[1])
  })

  it('produces different decisions for different seeds', () => {
    const decisions = (seed: number) => {
      const s = new ScenarioController()
      s.configure({ seed, sendFailureRate: 0.5 })
      return Array.from({ length: 20 }, () => s.shouldFailSend())
    }

    expect(decisions(1)).not.toEqual(decisions(2))
  })

  it('reset() rewinds the sequence, so a replay repeats it', () => {
    const s = new ScenarioController()
    s.configure({ seed: 7, sendFailureRate: 0.5 })
    const first = Array.from({ length: 10 }, () => s.shouldFailSend())

    s.configure({ seed: 7, sendFailureRate: 0.5 })
    const second = Array.from({ length: 10 }, () => s.shouldFailSend())

    expect(second).toEqual(first)
  })
})

describe('ScenarioController — the two failure axes', () => {
  it('sendFailureRate 1 fails every send', () => {
    const s = new ScenarioController()
    s.configure({ sendFailureRate: 1 })
    expect(Array.from({ length: 10 }, () => s.shouldFailSend())).not.toContain(false)
  })

  it('sendFailureRate does not drop webhooks', () => {
    // Two distinct failure classes on purpose. "The send failed" is visible to
    // the app immediately; "the webhook never arrived" is invisible until
    // something times out. Collapsing them into one knob makes the second
    // untestable.
    const s = new ScenarioController()
    s.configure({ sendFailureRate: 1 })
    expect(s.shouldDropWebhook()).toBe(false)
  })

  it('webhookFailureRate 1 drops every webhook without touching sends', () => {
    const s = new ScenarioController()
    s.configure({ webhookFailureRate: 1 })

    expect(s.shouldFailSend()).toBe(false)
    expect(Array.from({ length: 10 }, () => s.shouldDropWebhook())).not.toContain(false)
  })
})

describe('ScenarioController — nextError', () => {
  it('forces the given code for one send, then stops', () => {
    const s = new ScenarioController()
    s.configure({ nextError: { code: 130429 } })

    expect(s.takeForcedError()).toBe(130429)
    expect(s.takeForcedError()).toBeUndefined()
  })

  it('honours a repeat count', () => {
    // Exponential-backoff logic needs "fail three times then succeed" to be
    // expressible, otherwise you can only test one retry.
    const s = new ScenarioController()
    s.configure({ nextError: { code: 130429, times: 3 } })

    expect([s.takeForcedError(), s.takeForcedError(), s.takeForcedError()]).toEqual([
      130429, 130429, 130429,
    ])
    expect(s.takeForcedError()).toBeUndefined()
  })

  it('takes precedence over the random failure rate', () => {
    const s = new ScenarioController()
    s.configure({ sendFailureRate: 1, nextError: { code: 132015 } })
    expect(s.takeForcedError()).toBe(132015)
  })
})

describe('ScenarioController — latency', () => {
  it('returns a fixed delay when given a number', () => {
    const s = new ScenarioController()
    s.configure({ latencyMs: 250 })
    expect(s.latency()).toBe(250)
  })

  it('stays inside the range when given one', () => {
    const s = new ScenarioController()
    s.configure({ seed: 5, latencyMs: { min: 100, max: 200 } })

    for (let i = 0; i < 50; i++) {
      const value = s.latency()
      expect(value).toBeGreaterThanOrEqual(100)
      expect(value).toBeLessThanOrEqual(200)
    }
  })
})

describe('ScenarioController — configuration', () => {
  it('merges partial updates instead of replacing the whole config', () => {
    const s = new ScenarioController()
    s.configure({ duplicateWebhooks: true })
    s.configure({ latencyMs: 50 })

    expect(s.config.duplicateWebhooks).toBe(true)
    expect(s.config.latencyMs).toBe(50)
  })

  it('rejects a failure rate outside 0..1', () => {
    const s = new ScenarioController()
    expect(() => s.configure({ sendFailureRate: 1.5 })).toThrow(/between 0 and 1/i)
  })

  it('rejects a latency range whose min exceeds its max', () => {
    const s = new ScenarioController()
    expect(() => s.configure({ latencyMs: { min: 500, max: 100 } })).toThrow(/min/i)
  })

  it('reset() returns everything to the inert defaults', () => {
    const s = new ScenarioController()
    s.configure({ duplicateWebhooks: true, sendFailureRate: 1, nextError: { code: 100 } })

    s.reset()

    expect(s.config.duplicateWebhooks).toBe(false)
    expect(s.shouldFailSend()).toBe(false)
    expect(s.takeForcedError()).toBeUndefined()
  })
})
