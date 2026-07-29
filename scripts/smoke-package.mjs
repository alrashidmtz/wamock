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
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer, connect } from 'node:net'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const workdir = mkdtempSync(join(tmpdir(), 'wamock-smoke-'))

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })

function fail(message) {
  process.stderr.write(`\nPACKAGE SMOKE TEST FAILED: ${message}\n`)
  rmSync(workdir, { recursive: true, force: true })
  process.exit(1)
}


/** An OS-assigned free port, so a busy 3000 cannot fail the release. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** Poll the port rather than sleeping: a fixed wait is wrong on both ends. */
async function waitForListening(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = connect(port, '127.0.0.1')
      socket.on('connect', () => (socket.end(), resolve(true)))
      socket.on('error', () => resolve(false))
    })
    if (open) return
    if (Date.now() > deadline) fail(`nothing listening on ${port} after ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 200))
  }
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

  // The shipped example, run against the shipped package. It had never been
  // executed and four of its six tests hung: it imported inside the webhook
  // handler, and duplicate deliveries deadlocked two handlers against each
  // other. Documentation that ships is documentation that must run.
  process.stdout.write('running the shipped vitest example against the package...\n')
  run('npm', ['install', 'vitest', '--no-audit', '--no-fund'], workdir)
  // Copy in-process. Shelling out to `node -e` meant the path travelled
  // through cmd.exe on Windows, which mangled the quoting — caught by the
  // Windows leg of the CI matrix, which is what it is there for.
  const example = join(repoRoot, 'examples', 'vitest', 'whatsapp-flow.test.ts')
  copyFileSync(example, join(workdir, 'whatsapp-flow.test.ts'))
  const result = run('npx', ['vitest', 'run', 'whatsapp-flow.test.ts'], workdir)
  if (!/\d+ passed/.test(result) || /failed/.test(result)) {
    fail(`the shipped vitest example does not pass:\n${result}`)
  }
  process.stdout.write('shipped example passes\n')

  // The Express example, driven the way a reader would drive it. It is the only
  // shipped example that is a running server rather than a test, and nothing
  // executed it — the same gap that let the vitest example ship broken above.
  //
  // wamock runs in-process here rather than as a second child. One subprocess
  // is one thing that can fail to die on Windows; two is a flaky release gate.
  process.stdout.write('running the shipped express example against the package...\n')
  run('npm', ['install', 'express', '--no-audit', '--no-fund'], workdir)
  copyFileSync(join(repoRoot, 'examples', 'express', 'server.mjs'), join(workdir, 'server.mjs'))

  // The mock comes up first: the receiver needs its address to reply to, and
  // in library mode that is an ephemeral port, not the 4004 the example
  // defaults to.
  const receiverPort = await freePort()
  const { createWamock } = await import(
    pathToFileURL(join(workdir, 'node_modules', 'wamock', 'dist', 'lib.js')).href
  )
  const mock = await createWamock({
    appSecret: 'shhh',
    webhookUrl: `http://127.0.0.1:${receiverPort}/webhook`,
  })

  const receiver = spawn(process.execPath, ['server.mjs'], {
    cwd: workdir,
    env: {
      ...process.env,
      PORT: String(receiverPort),
      WA_APP_SECRET: 'shhh',
      GRAPH_API_BASE_URL: mock.baseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let receiverLog = ''
  receiver.stdout.on('data', (d) => (receiverLog += d))
  receiver.stderr.on('data', (d) => (receiverLog += d))

  try {
    await waitForListening(receiverPort)

    await mock.inbound({ from: '5215555000001', text: 'hola' })

    // The example replies through the Graph API, so the reply landing in
    // wamock is the proof the whole loop closed: signature verified over the
    // raw body, webhook parsed, response sent back.
    //
    // Polled, not awaited. The virtual clock orders wamock's own timers and
    // knows nothing about an HTTP round trip to another process — advancing it
    // and reading once checked before the reply could possibly have arrived.
    let replied = false
    for (let i = 0; i < 60 && !replied; i++) {
      replied = mock.messages().some((m) => m.payload?.text?.body === 'You said: hola')
      if (!replied) await new Promise((r) => setTimeout(r, 250))
    }

    if (!replied) {
      fail(`the express example never replied. Receiver output:\n${receiverLog}`)
    }
    process.stdout.write('shipped express example completes the round trip\n')
  } finally {
    receiver.kill()
    await mock.close()
  }
} catch (error) {
  const detail = error.stdout || error.stderr || error.message
  fail(String(detail).trim())
}

rmSync(workdir, { recursive: true, force: true })
