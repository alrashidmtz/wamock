#!/usr/bin/env node
/**
 * Smoke-test the packaged artifact, not the working tree.
 *
 * Every other check in this repo runs against `src/`. The published package
 * runs `dist/`. Nothing was looking at the gap between them — which is how
 * 0.2.1 shipped compiled output from before its own fix: sources containing
 * the fix, a `dist/` that did not, and a full green suite either way.
 *
 * So this packs the tarball exactly as `npm publish` would, installs it into a
 * throwaway project, and drives it through its own public API. If `src/` and
 * `dist/` ever disagree again, this fails before anything reaches a registry.
 *
 * Written in Node rather than shell because CI runs it on Windows too.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const workdir = mkdtempSync(join(tmpdir(), 'wamock-smoke-'))

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })

function fail(message) {
  process.stderr.write(`\nPACKAGE SMOKE TEST FAILED: ${message}\n`)
  rmSync(workdir, { recursive: true, force: true })
  process.exit(1)
}

try {
  process.stdout.write('packing the tarball as npm publish would...\n')
  run('npm', ['pack', '--pack-destination', workdir], repoRoot)
  const tarball = readdirSync(workdir).find((f) => f.endsWith('.tgz'))
  if (!tarball) fail('npm pack produced no tarball')

  process.stdout.write(`installing ${tarball} into a throwaway project...\n`)
  writeFileSync(join(workdir, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }))
  run('npm', ['install', join(workdir, tarball), '--no-audit', '--no-fund'], workdir)

  // The exercise runs in its own process so an import failure or a hang is
  // attributable, not tangled with this script's own state.
  const probe = join(workdir, 'probe.mjs')
  writeFileSync(
    probe,
    `
import { createWamock } from 'wamock'

// A hang would otherwise show up as a silent CI timeout with no output.
const bomb = setTimeout(() => {
  console.error('HUNG: a helper did not return within 20s')
  process.exit(9)
}, 20000)

// 1. The whole lifecycle, through the packaged build.
const mock = await createWamock({ appSecret: 's', start: 1e12, interceptGraph: true })
await mock.inbound({ from: '5216691112233', text: 'hola' })
await mock.send({ to: '5216691112233', text: 'buenas' })
await mock.time.advance(25 * 60 * 60 * 1000)
const code = await mock.send({ to: '5216691112233', text: 'x' }).catch((e) => e.code)
if (code !== 131047) { console.error('expected 131047 outside the window, got ' + code); process.exit(1) }

// The interceptor must reach the mock, and close() must hand fetch back.
const patched = globalThis.fetch
await mock.close()
if (globalThis.fetch === patched) { console.error('close() did not restore the global fetch'); process.exit(1) }

// 2. A receiver that never resolves must not freeze anything. This is the
//    exact regression 0.2.1 shipped, and the reason this file exists.
const t = Date.now()
const stuck = await createWamock({
  appSecret: 's', start: 1e12, settleTimeoutMs: 200,
  onWebhook: () => new Promise(() => {}),
})
await stuck.inbound({ from: '5216691112233', text: 'hola' })
await stuck.close()
if (Date.now() - t > 10000) { console.error('a stuck receiver froze the packaged build'); process.exit(1) }

clearTimeout(bomb)
console.log('packaged build works: full lifecycle, interceptor, and bounded waits')
process.exit(0)
`,
  )

  process.stdout.write(run(process.execPath, [probe], workdir))

  // Identity, not just behaviour. `wamock --version` reported 0.1.0 from 0.2.0
  // onward because the number was duplicated in the CLI and never updated —
  // and that is exactly the string people paste into bug reports.
  const expected = JSON.parse(run('npm', ['pkg', 'get', 'version'], repoRoot).trim())
  const reported = run(process.execPath, [join(workdir, 'node_modules', 'wamock', 'dist', 'cli.js'), '--version'], workdir).trim()
  if (reported !== expected) {
    fail(`the CLI reports version ${reported} but the package is ${expected}`)
  }
  process.stdout.write(`CLI reports the packaged version (${reported})\n`)
} catch (error) {
  const detail = error.stdout || error.stderr || error.message
  fail(String(detail).trim())
}

rmSync(workdir, { recursive: true, force: true })
