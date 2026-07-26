import { describe, expect, it } from 'vitest'

import { parseArgs } from '../src/cli-args.js'

describe('parseArgs', () => {
  it('defaults to the start command', () => {
    expect(parseArgs([]).command).toBe('start')
  })

  it('reads the flags from the README quickstart', () => {
    const parsed = parseArgs([
      'start',
      '--port',
      '4004',
      '--app-secret',
      'shhh',
      '--webhook-url',
      'http://localhost:3000/webhook',
    ])

    expect(parsed).toMatchObject({
      command: 'start',
      options: {
        port: 4004,
        appSecret: 'shhh',
        webhookUrl: 'http://localhost:3000/webhook',
      },
    })
  })

  it('accepts --flag=value as well as --flag value', () => {
    expect(parseArgs(['start', '--port=5000']).options.port).toBe(5000)
  })

  it('picks a default port when none is given', () => {
    expect(parseArgs(['start']).options.port).toBe(4004)
  })

  it('generates an app secret when none is given, rather than using a fixed one', () => {
    // A hardcoded default secret would make every wamock signature forgeable
    // by anyone who read the source, and someone would eventually run this
    // somewhere reachable.
    const a = parseArgs(['start']).options.appSecret
    const b = parseArgs(['start']).options.appSecret

    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(16)
  })

  it('rejects a non-numeric port', () => {
    expect(() => parseArgs(['start', '--port', 'abc'])).toThrow(/port/i)
  })

  it('rejects a port outside the valid range', () => {
    expect(() => parseArgs(['start', '--port', '99999'])).toThrow(/port/i)
  })

  it('rejects a flag that expects a value but has none', () => {
    expect(() => parseArgs(['start', '--app-secret'])).toThrow(/app-secret/)
  })

  it('rejects an unknown flag instead of ignoring it', () => {
    // Ignoring a typo'd flag means the user thinks they configured something.
    expect(() => parseArgs(['start', '--webhookurl', 'x'])).toThrow(/webhookurl/)
  })

  it('recognises help and version', () => {
    expect(parseArgs(['--help']).command).toBe('help')
    expect(parseArgs(['-h']).command).toBe('help')
    expect(parseArgs(['--version']).command).toBe('version')
  })

  it('rejects an unknown command', () => {
    expect(() => parseArgs(['frobnicate'])).toThrow(/frobnicate/)
  })

  it('takes a verify token for the subscription handshake', () => {
    expect(parseArgs(['start', '--verify-token', 'vt']).options.verifyToken).toBe('vt')
  })

  it('takes a phone number id so an app can keep its existing config', () => {
    expect(parseArgs(['start', '--phone-number-id', 'PNID_X']).options.phoneNumberId).toBe('PNID_X')
  })
})
