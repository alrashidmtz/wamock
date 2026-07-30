import { describe, expect, it, vi } from 'vitest'

import { VirtualClock } from '../../src/core/clock.js'

const EPOCH = 1_750_000_000_000

describe('VirtualClock — frozen mode', () => {
  it('does not move on its own', async () => {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    const before = clock.now()
    await new Promise((r) => setTimeout(r, 20))
    expect(clock.now()).toBe(before)
  })

  it('moves forward exactly by advance()', () => {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    clock.advance(1000)
    expect(clock.now()).toBe(EPOCH + 1000)
  })

  it('fires a timer whose deadline is crossed by advance()', () => {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    const fired: number[] = []
    clock.at(EPOCH + 500, () => fired.push(clock.now()))

    clock.advance(400)
    expect(fired).toEqual([])

    clock.advance(200)
    expect(fired).toEqual([EPOCH + 500])
  })

  it('sets now() to each timer deadline while draining, not to the final time', () => {
    // Effects must observe the time they were scheduled for. If now() jumped
    // straight to the end, a status firing at T+1s would stamp T+10s.
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    const stamps: number[] = []
    clock.at(EPOCH + 1000, () => stamps.push(clock.now()))
    clock.at(EPOCH + 2000, () => stamps.push(clock.now()))

    clock.advance(10_000)

    expect(stamps).toEqual([EPOCH + 1000, EPOCH + 2000])
    expect(clock.now()).toBe(EPOCH + 10_000)
  })

  it('fires timers in deadline order regardless of scheduling order', () => {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    const order: string[] = []
    clock.at(EPOCH + 300, () => order.push('third'))
    clock.at(EPOCH + 100, () => order.push('first'))
    clock.at(EPOCH + 200, () => order.push('second'))

    clock.advance(1000)

    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('fires timers scheduled from inside a timer callback within the same advance()', () => {
    // The delivery queue chains statuses: sent schedules delivered. A single
    // advance() past both deadlines must deliver both.
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    const fired: string[] = []
    clock.at(EPOCH + 100, () => {
      fired.push('sent')
      clock.at(clock.now() + 100, () => fired.push('delivered'))
    })

    clock.advance(1000)

    expect(fired).toEqual(['sent', 'delivered'])
  })

  it('does not fire a cleared timer', () => {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    const fn = vi.fn()
    const id = clock.at(EPOCH + 100, fn)
    clock.clear(id)

    clock.advance(1000)

    expect(fn).not.toHaveBeenCalled()
  })

  it('ignores clear() for an unknown timer id', () => {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    expect(() => clock.clear(9999)).not.toThrow()
  })

  it('fires a timer whose deadline is already in the past on the next advance', () => {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    const fn = vi.fn()
    clock.at(EPOCH - 5000, fn)

    clock.advance(1)

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('rejects a negative advance — time never runs backwards', () => {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    expect(() => clock.advance(-1)).toThrow(/negative/i)
  })

  it('throws instead of hanging when a callback reschedules itself forever', () => {
    // A runaway timer is a bug either way, but a thrown error names the file
    // and a hang just wedges someone's CI with no output.
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    const reschedule = () => clock.at(clock.now(), reschedule)
    reschedule()

    expect(() => clock.advance(1)).toThrow(/rescheduling itself/i)
  })
})

describe('VirtualClock — live mode', () => {
  it('tracks wall time', async () => {
    const clock = new VirtualClock({ mode: 'live' })
    const before = clock.now()
    await new Promise((r) => setTimeout(r, 25))
    expect(clock.now()).toBeGreaterThan(before)
  })

  it('applies advance() as an offset on top of wall time', () => {
    const clock = new VirtualClock({ mode: 'live' })
    const before = clock.now()
    clock.advance(60_000)
    expect(clock.now()).toBeGreaterThanOrEqual(before + 60_000)
  })

  it('fires due timers on its own tick, without an explicit advance()', async () => {
    const clock = new VirtualClock({ mode: 'live', tickMs: 5 })
    const fn = vi.fn()
    clock.at(clock.now() + 10, fn)
    clock.start()

    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1), { timeout: 500 })
    clock.stop()
  })

  it('stop() keeps the process from being held open by the tick', () => {
    const clock = new VirtualClock({ mode: 'live', tickMs: 5 })
    clock.start()
    expect(() => clock.stop()).not.toThrow()
    expect(() => clock.stop()).not.toThrow()
  })

  it('stop() actually stops it, not merely returns quietly', async () => {
    // "Does not throw" is satisfied by a stop() that clears nothing. The only
    // proof is a timer that stays unfired afterwards.
    const clock = new VirtualClock({ mode: 'live', tickMs: 5 })
    clock.start()
    clock.stop()

    const fn = vi.fn()
    clock.at(clock.now(), fn)
    await new Promise((r) => setTimeout(r, 60))

    expect(fn).not.toHaveBeenCalled()
  })

  it('start() twice leaves one tick, so a single stop() ends all of it', async () => {
    // A second interval would survive stop() and keep firing — which is how a
    // "stopped" clock goes on delivering into the next test.
    const clock = new VirtualClock({ mode: 'live', tickMs: 5 })
    clock.start()
    clock.start()
    clock.stop()

    const fn = vi.fn()
    clock.at(clock.now(), fn)
    await new Promise((r) => setTimeout(r, 60))

    expect(fn).not.toHaveBeenCalled()
  })
})

describe('VirtualClock — the frozen/live boundary', () => {
  it('start() is a no-op when frozen, or determinism is gone', async () => {
    // Everything library mode promises rests on this: a frozen clock moves only
    // when advance() says so. A tick here would deliver webhooks on wall time
    // and turn every timing assertion into a race.
    const clock = new VirtualClock({ mode: 'frozen', start: 1_750_000_000_000, tickMs: 5 })
    const fn = vi.fn()
    clock.at(clock.now(), fn)

    clock.start()
    await new Promise((r) => setTimeout(r, 60))

    expect(fn).not.toHaveBeenCalled()
    expect(clock.now()).toBe(1_750_000_000_000)
  })

  it('reports which mode it is in, since the flush branches on it', () => {
    // WamockEngine.flush() repeats rounds only when frozen: a live clock's tick
    // already fires due timers, and repeating there counts unrelated concurrent
    // deliveries as progress and never converges.
    expect(new VirtualClock({ mode: 'frozen' }).frozen).toBe(true)
    expect(new VirtualClock({ mode: 'live' }).frozen).toBe(false)
    expect(new VirtualClock().frozen).toBe(true)
  })
})
