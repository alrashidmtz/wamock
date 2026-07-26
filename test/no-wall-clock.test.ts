import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Structural guard, not a unit test.
 *
 * The 24h service window, scheduled statuses and token expiry are only
 * testable because every reading of time goes through the virtual clock. A
 * single stray `Date.now()` in the messaging path makes that behaviour depend
 * on when the suite happens to run — and it fails intermittently, months
 * later, in someone else's CI.
 *
 * ESLint enforces this too; this test makes the rule impossible to silence by
 * disabling a plugin.
 */

const SRC = new URL('../src/', import.meta.url).pathname
const EXEMPT = new Set(['clock.ts'])
const FORBIDDEN = /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)/

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      return entry.name.endsWith('.ts') ? [path] : []
    }),
  )
  return files.flat()
}

describe('wall-clock discipline', () => {
  it('reads time only through the virtual clock', async () => {
    const files = await sourceFiles(SRC)
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      if (EXEMPT.has(file.split('/').pop()!)) continue
      const contents = await readFile(file, 'utf8')
      for (const [index, line] of contents.split('\n').entries()) {
        if (FORBIDDEN.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
