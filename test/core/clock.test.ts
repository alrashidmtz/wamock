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
})
