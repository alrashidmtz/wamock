import { describe, expect, it } from 'vitest'

import { ServiceWindows, WINDOW_MS } from '../../src/core/window.js'

const EPOCH = 1_750_000_000_000
const HOUR = 60 * 60 * 1000

describe('ServiceWindows', () => {
  it('is closed for a customer who has never written', () => {
    // The default is closed, not open. A mock that starts every conversation
    // open lets free-form sends pass in testing and fail in production.
    expect(new ServiceWindows().isOpen('PNID_1', '5215555000001', EPOCH)).toBe(false)
  })

  it('opens when the customer writes', () => {
    const windows = new ServiceWindows()
    windows.recordInbound('PNID_1', '5215555000001', EPOCH)

    expect(windows.isOpen('PNID_1', '5215555000001', EPOCH)).toBe(true)
  })

  it('stays open just before the 24h mark', () => {
    const windows = new ServiceWindows()
    windows.recordInbound('PNID_1', '5215555000001', EPOCH)

    expect(windows.isOpen('PNID_1', '5215555000001', EPOCH + WINDOW_MS - 1)).toBe(true)
  })

  it('is closed exactly at the 24h mark', () => {
    // Meta's boundary is exclusive. Off-by-one here means an integration's
    // "send just before it expires" retry logic tests differently than it runs.
    const windows = new ServiceWindows()
    windows.recordInbound('PNID_1', '5215555000001', EPOCH)

    expect(windows.isOpen('PNID_1', '5215555000001', EPOCH + WINDOW_MS)).toBe(false)
  })

  it('renews to a full 24h on every new inbound', () => {
    const windows = new ServiceWindows()
    windows.recordInbound('PNID_1', '5215555000001', EPOCH)
    windows.recordInbound('PNID_1', '5215555000001', EPOCH + 20 * HOUR)

    // Would have expired at EPOCH+24h under the first message alone.
    expect(windows.isOpen('PNID_1', '5215555000001', EPOCH + 30 * HOUR)).toBe(true)
    expect(windows.isOpen('PNID_1', '5215555000001', EPOCH + 45 * HOUR)).toBe(false)
  })

  it('tracks each conversation separately, not one global window', () => {
    // Two customers on the same business number have independent windows;
    // so does the same customer across two business numbers.
    const windows = new ServiceWindows()
    windows.recordInbound('PNID_1', '5215555000001', EPOCH)

    expect(windows.isOpen('PNID_1', '5215555000002', EPOCH)).toBe(false)
    expect(windows.isOpen('PNID_2', '5215555000001', EPOCH)).toBe(false)
  })

  it('exposes when a window expires, for diagnostics', () => {
    const windows = new ServiceWindows()
    windows.recordInbound('PNID_1', '5215555000001', EPOCH)

    expect(windows.expiresAt('PNID_1', '5215555000001')).toBe(EPOCH + WINDOW_MS)
    expect(windows.expiresAt('PNID_1', 'nobody')).toBeUndefined()
  })

  it('clear() closes every window', () => {
    const windows = new ServiceWindows()
    windows.recordInbound('PNID_1', '5215555000001', EPOCH)

    windows.clear()

    expect(windows.isOpen('PNID_1', '5215555000001', EPOCH)).toBe(false)
  })

  it('accepts a custom window length', () => {
    // Escape hatch for testing edge behaviour without advancing a full day.
    const windows = new ServiceWindows({ windowMs: 1000 })
    windows.recordInbound('PNID_1', '5215555000001', EPOCH)

    expect(windows.isOpen('PNID_1', '5215555000001', EPOCH + 999)).toBe(true)
    expect(windows.isOpen('PNID_1', '5215555000001', EPOCH + 1000)).toBe(false)
  })
})
