# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[semver](https://semver.org/).

## [0.2.6] — 2026-07-29

### Added

- **A warning when `interceptGraph` was enabled but nothing was ever
  intercepted.** That is the signature of a client which captured
  `globalThis.fetch` before the mock installed its patch — it still holds the
  real one, and its requests reached Meta. Nothing can un-capture that
  reference, but staying silent about it was the dangerous part, and 0.2.5 only
  documented the hazard. The warning names the benign case too, so a test that
  simply makes no Graph calls is not left guessing.

## [0.2.5] — 2026-07-29

From a first external evaluation. Nothing here was found by the test suite —
all of it came from someone using the tool for the first time.

### Fixed

- **Control API bodies were rejected without saying what was wrong.** Three
  schemas were permissive while the rest were strict, so an extra key was
  ignored and only the missing one reported: `{messageId, status}` answered
  `id: Required` and left you to work out that `messageId` should be `id`. All
  bodies are strict now and name both, and root-level issues no longer render
  with an empty field prefix.

### Documented

- **Interception does not reach a client that captured `fetch` at
  construction.** `constructor(transport = globalThis.fetch)` is a common DI
  default; built before the mock, it keeps the original and requests go to the
  real `graph.facebook.com`. With a valid token in the environment that means a
  test sending real messages to real numbers. Written up as the security
  warning it is, with the assertion that catches it, and pinned by a test —
  there is no fix from inside wamock, so the limitation itself is the contract.
- **Delivery statuses need `time.advance()`.** They are due shortly after the
  send and the clock is frozen, so asserting immediately finds nothing and
  looks like a broken mock.
- **Your app's clock is not wamock's clock.** `advance()` cannot move the
  `Date.now()` inside the code under test, so expiry tests have to age both
  sides or they prove nothing.
- **Request bodies for every control endpoint**, in the table rather than in
  `src/control/routes.ts`.
- **Pin `@latest` when installing.** pnpm's `minimumReleaseAge` holds back
  recent publishes as a supply-chain measure, and a warm cache does the same;
  landing on 0.1.0 and finding no `interceptGraph` is a bad first ten minutes.

## [0.2.4] — 2026-07-29

### Fixed

- **Replying from a webhook handler stalled when deliveries were duplicated.**
  Under at-least-once, both copies of an inbound run your handler; each reply
  called `send()`, which waited for the drain the other copy was holding. The
  call burned the whole settle timeout doing nothing. A nested flush now defers
  to the one already running — the outer drain sees the work regardless.
- **The shipped vitest example never worked.** It imported inside the webhook
  handler, which deadlocks under vitest's module runner and is poor practice
  besides. Four of its six tests hung. It is now a top-level import, and
  `npm run test:package` runs the example against the packaged build on every
  push, so documentation that ships is documentation that runs.

## [0.2.3] — 2026-07-29

### Fixed

- **`wamock --version` reported 0.1.0 from 0.2.0 onward.** The number was
  duplicated in the CLI as a literal and nothing updated it. It now reads
  `package.json`, so there is one source of truth — and the package smoke test
  asserts the CLI agrees with the tarball it came from. Version output is what
  people paste into bug reports; letting it drift means diagnoses start from a
  false fact.
- **The CLI printed a stack trace when its output pipe closed early.** An
  unhandled `EPIPE` looks like a crash in wamock rather than the reader simply
  going away.

## [0.2.2] — 2026-07-29

### Fixed

- **0.2.1 shipped a stale build.** Its `dist/` was compiled before the hang fix
  and published alongside sources that contained it, so the package said one
  thing in TypeScript and did another in JavaScript — and JavaScript is what
  runs. As published, 0.2.1 behaves exactly like 0.2.0 and still hangs.
  **Upgrade to 0.2.2**; 0.2.1 has nothing 0.2.0 lacked.

  Root cause: nothing forced a rebuild before publishing. `npm publish` packed
  whatever happened to be in `dist/`. There is now a `prepublishOnly` hook that
  runs the full check and a fresh build, so a stale or failing build cannot be
  published at all. Releases through CI were never affected — that path always
  built first — which is one more argument for publishing from CI.

## [0.2.1] — 2026-07-29 — **broken, use 0.2.2**

### Fixed

- **Every library helper could hang forever on a stuck receiver.** `inbound`,
  `send`, `time.advance`, `reset` and `close` all wait for the webhooks they
  triggered, and that wait is on *your* `onWebhook`. A receiver that never
  resolves — a lock, a pending request, a forgotten `await` — froze the very
  first call with no output at all. Introduced in 0.2.0 by the `close()` fix,
  which traded delivered-after-close for a hang; a hang is worse, because it
  leaves nothing to read.

  Every wait is now bounded, configurable via `settleTimeoutMs` (default 5s).
  A late delivery is diagnosable; a wedged suite is not.

## [0.2.0] — 2026-07-28

A quality pass driven by lenses the first reviews had not used: resource
lifecycle, portability, and — the one that found the most — mutation testing.

### Added

- **`createWamock({ interceptGraph: true })`** — installs the Graph interceptor
  for the mock's lifetime and restores the global `fetch` on `close()`.
  Forgetting the manual `restore()` used to leave `fetch` patched for every
  later test, which surfaces as unrelated tests failing much later.
- **`npm run test:mutation`** — Stryker across all of `src/`, with a threshold
  that breaks the build on regression and a weekly CI run.

### Fixed

- **`close()` delivered webhooks after it resolved.** With a slow receiver —
  which is any real app — deliveries already in flight landed well after the
  mock was closed, so `afterEach(close)` did not isolate and one test's
  webhooks arrived inside the next. It now cancels pending timers first, then
  awaits what is in flight; the reverse order lets a delivery start during the
  wait and outlive the close. Also idempotent.
- **The suite could not run on Windows.** The wall-clock guard used
  `URL.pathname` (which yields `/C:/…`) and `split('/')` against paths built
  with `join` (backslashes), so its exemption never matched.
- **Interactive messages accepted an empty `id` or `title`** where Meta rejects
  them — a `typeof === 'string'` check passes for `""`.

### Changed

- **CI now runs 3 operating systems × Node 22 and 24.** `engines` promised
  `>=22` on any platform while exactly one combination was tested, and none on
  macOS, where most of this tool's users are.
- Test quality is now measured, not assumed. Mutation score went from **72.14%
  to 77.82%**; the error catalogue specifically went from 43 undetected
  mutations to 1. Coverage had reported it as fully tested.

## [0.1.0] — 2026-07-27

First release.

### Added

- **Message sending** — `POST /{version}/{phone_number_id}/messages` for
  `text`, `template` and `interactive` (button + list). Any `vNN.N` version
  segment is accepted.
- **Signed webhooks** — `X-Hub-Signature-256` computed over the exact bytes
  sent, so a receiver that verifies against a re-serialized body fails here the
  way it would against Meta.
- **Virtual clock** — `advance(ms)` moves time and fires every scheduled effect
  in deadline order. No module outside `core/clock.ts` may read wall time;
  enforced by ESLint and by a test that greps the source.
- **24-hour service window** — per conversation, renewed only by inbound
  messages. Free-form sends outside it fail with `131047`.
- **Templates** — full CRUD plus the state machine
  (`PENDING`/`APPROVED`/`REJECTED`/`PAUSED`/`DISABLED`), keyed by
  `name` + `language` with no fallback, because approval is per language.
- **Error catalogue** — `100`, `0`, `190`, `130429`, `131000`, `131026`,
  `131047`, `131048`, `132001`, `132015`, each with Meta's real HTTP status and
  retry semantics.
- **Interactive limits** — 3 buttons / 20-char titles, 10 rows total across all
  sections, 24-char row titles, 72-char descriptions. Exceeding them returns
  `100` rather than being silently truncated.
- **Conversations and pricing** on delivery statuses, so integrations can test
  their own conversation counting.
- **Scenario control** — seeded randomness, latency, two independent failure
  rates (send vs. webhook delivery), duplicate webhooks, out-of-order statuses,
  and forced error codes.
- **Control API** — `/__mock/inbound`, `/__mock/statuses`, `/__mock/time/advance`,
  `/__mock/templates/{name}/{language}/transition`, `/__mock/scenario`,
  `/__mock/reset`, `/__mock/state`, `/__mock/messages`.
- **Media stub** — valid ids and URLs that expire after ~5 minutes.
- **Library mode** — `createWamock()` with `inbound`, `send`, `time.advance`,
  `expectSent`, `approveTemplate`, `scenario` and `reset`. No network required.
- **CLI** — `npx wamock start`, including Meta's subscription handshake against
  the configured webhook URL.
- **Docker image** and examples for express, vitest, GitHub Actions and
  docker-compose.

- **Tech Provider mode** — Embedded Signup codes (single-use) and token
  exchange, `debug_token` with permanent / short / long / revoked tokens,
  `subscribed_apps` including the unsubscribed state that silently drops every
  webhook, phone-number field lookup, per-tenant webhook signing,
  `message_template_status_update` and `phone_number_quality_update` webhooks,
  quality ratings and messaging tiers metered by unique recipients per 24h.

### Security

- **Binds `127.0.0.1` by default.** The `/__mock` control API is
  unauthenticated by design; binding beyond loopback would let anyone who can
  reach the port read every message the app under test sent and inject forged
  inbound messages. `--host` is an explicit opt-in that prints a warning; the
  Docker image passes it because the container boundary does the limiting.
- **Outbound HTTP is bounded.** Webhook delivery and the startup handshake time
  out, so a receiver that accepts a connection and never answers cannot leave
  `settle()` unresolved and hang a test with no output.
- **Message content cannot forge the webhook envelope.** Reserved keys
  (`from`, `id`, `timestamp`, `type`) are stripped from message content, and
  the inbound control schema is strict.
- **Retained history is capped** with oldest-first eviction, and the dropped
  count is reported in `/__mock/state` — a truncated history that looks
  complete is worse than a smaller one that admits it.
- `SECURITY.md` states the threat model plainly.

### Known limitations

- `conversation` and `pricing` are **modeled from Meta's public documentation
  rather than captured from production traffic** — neither audited integration
  consumed those fields. Shape and field names are faithful; treat the finer
  points of category assignment as best-effort.
- No GUI, no disk persistence, no real media bytes.
- No WhatsApp Flows and no calling.
- Access tokens are **optional**. Calls without an `Authorization` header are
  accepted so the quickstart stays short; a token that IS supplied gets
  validated for expiry and scope. wamock is a local tool, not an auth server.
- `TIER_1` and `TIER_2` are wamock additions, not Meta tiers — they exist so a
  messaging-limit test does not need 250 recipients.

### Dogfood findings

A pass against two production integrations turned up two things worth stating.

**"Just change the Graph base URL" does not work.** Both integrations build
their Graph URLs as string literals; neither had a base-URL setting. That is
the normal case, so `installGraphInterceptor` (`wamock/intercept`) now swaps
the destination underneath a client without modifying it. It patches the global
`fetch` and therefore does not cover `axios`, `node-fetch` or raw
`http.request`.

**wamock used to reject every real client.** It validated any supplied bearer
token, and real clients always send their own — so every call came back 401
with code 190. All 389 tests missed it because each used a token the mock had
issued, or none at all. Fixed: tokens wamock did not issue are accepted (it is
not an auth server and cannot tell a real credential from a random string);
tokens it did issue are still fully validated, which is what keeps the
token-expiry scenario meaningful.

### Verified against a real integration

A production WhatsApp Cloud API integration now runs its **own adapter**,
unmodified, against wamock — 20 tests covering the paths it uses in
production, plus the tech-provider connect flow. The adapter still builds
`https://graph.facebook.com/v19.0/...` as it always did; `installGraphInterceptor`
moves the destination underneath it.

Everything held on the first run: 131047 from the mock enforcing the window,
132001 for a template approved in a different language, 132015 once paused,
message splitting, interactive limits, statuses-only webhook parsing, and the
connect flow (`debug_token` telling a permanent System User token from a short
Graph Explorer one, `subscribed_apps`, `display_phone_number`, and the
"already exists" branch). No fidelity gaps surfaced.

The tests were confirmed to depend on the mock rather than pass vacuously —
disabling the interceptor fails 16 of the 20.

This closes the acceptance criterion that had been open since v1: a real
integration can be pointed at wamock without changing its code. The one
caveat worth repeating is the reason the interceptor exists — that
integration hardcodes the Graph host, and so does every other one we
checked, so "just change the base URL" was never the mechanism.
