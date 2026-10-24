# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

wamock is a standalone mock of Meta's WhatsApp Cloud API (Graph API + signed
webhooks back to the app under test), shipped as an npm package (library +
`wamock` CLI) and a Docker image. Its whole value is **fidelity**: it must fail
the way Meta fails — same error codes, wording, HTTP statuses and payload
shapes. Read `CONTRIBUTING.md` before changing behaviour.

## Commands

```bash
npm ci
npm test                         # vitest run (all tests)
npx vitest run test/lib.test.ts  # single file
npx vitest run -t "131047"       # tests whose name matches
npm run test:watch
npm run check                    # typecheck + lint + test:coverage — what CI runs (Node 22/24 × linux/macOS/windows)
npm run build                    # tsc -p tsconfig.build.json → dist/
npm run test:package             # packs the tarball, installs it in a temp dir, drives dist/ through the public API
npm run test:mutation            # Stryker; slow (~15 min), not in `check`, CI runs it weekly
```

`test:package` exists because `dist/` once shipped stale with a green suite —
run it (after `build`) whenever a change touches what ships.

## Architecture

- **`src/core/engine.ts` — `WamockEngine`** is a composition root, not a home
  for behaviour. It builds the collaborators (`VirtualClock`, `MockState`,
  `ScenarioController`, `ServiceWindows`, `Pricing`, `TokenStore`,
  `MessagingLimits`, `WebhookDispatcher`), bundles them as a `MockContext`
  (`src/core/context.ts`), and hands that context to the services in
  `src/graph/*-service.ts` (messaging, templates, media, tech provider), which
  hold the actual behaviour. Services depend on `MockContext`, not on the
  engine, so they can be tested against a hand-built context. `reset()` must
  clear every collaborator.
- **Account-level webhooks** (template status, category updates, limits) go
  through `dispatcher.dispatchToWaba()`; message-level ones through
  `dispatch(phoneNumberId)`. Timers a service schedules on the clock (template
  unpauses, recategorizations) must be tracked and cancelled in that service's
  `clear()`, which `engine.reset()` calls.
- **`engine.flush()`** is the one way a front door delivers what it triggered:
  `advance(0)` + bounded settle (`settleWithin`), repeated while the
  deliverer makes progress (an attempt settled, or `reset()` started a new
  generation) when the clock is frozen (capped at 100 rounds, so a receiver
  that answers every webhook with another throws instead of hanging), a single
  round when live. Only one flush runs rounds; a call made meanwhile (nested in
  a handler, in-process or over HTTP, or concurrent) waits only for the
  attempts it started itself and leaves the rest to the running one — letting
  it run its own rounds made a receiver that answers every webhook nest flushes
  until memory ran out. Every wait is forward-only: a call waits for attempts
  numbered from its starting point (`deliverer.nextAttempt()`, taken before it
  fires anything), never for one already running, so a handler never waits on
  its own delivery or a sibling's. `mock.time.advance()` goes through
  `advanceAndSettle()`; control requests take their starting point in an
  `onRequest` hook. Both the library helpers and the control API call these —
  never add a second drain implementation. Delivery
  statuses are scheduled at +50ms/+500ms, so they still need `time.advance()`.
- **`src/server.ts`** is the HTTP shell (Fastify): routing and error rendering
  only. Graph routes accept any `vNN.N` version segment, take JSON,
  form-urlencoded and multipart bodies (`src/http/forms.ts`, hand-written to
  keep two runtime deps), and **never flush** (Meta answers a send without waiting on
  your webhook endpoint). `/__mock/*` routes flush via hooks: writes in
  `onSend` (after the handler), `GET`s in `preHandler` (before answering, so
  `/__mock/state` doesn't report pre-drain counts); `POST /__mock/reset` is
  deliberately not pre-flushed. A Graph `preHandler` checks every
  wamock-issued token through `engine.assertAccessToken()`: validity, the
  permission the edge needs, and that a business token owns the object
  (otherwise `unsupportedRequest()`, Graph's code 100/subcode 33). Every error
  leaves as a Meta-shaped body via
  `GraphError` (`src/errors/graph-error.ts`, the error catalogue).
- **`src/control/routes.ts`** — the `/__mock/*` control API. Bodies are parsed
  as JSON regardless of content-type (so `curl -d` works) and validated with
  strict zod schemas that reject and name unknown keys. `/__mock/state` is
  built by the typed `buildStateSnapshot()` — internal `Set`/`Map`s must be
  converted there (`JSON.stringify(new Set(...))` is `{}`), and it must never
  include app secrets.
- **`src/lib.ts`** — library mode (`createWamock`): wraps engine + server with a
  **frozen** clock; every helper calls `engine.flush(settleTimeoutMs)`, and the
  same `settleTimeoutMs` is passed to `createServer` so `baseUrl` callers get
  the same behaviour. `src/cli.ts` / `cli-args.ts` is server mode with a
  **live** clock. Same engine underneath, so modes can't drift.
- **Media** (`src/graph/media-service.ts`) stores the bytes in memory: uploaded
  ids live 30 days, received ones 7, and each `GET /{media_id}` signs a
  5-minute download URL served at `DOWNLOAD_PATH`. A send by media `id` needs
  `mimeTypeOf(id)`: undefined when the id expired or never existed (131009),
  otherwise a type that suits the message kind (131053).
- **Embedded Signup tenants start unsubscribed**, as with Meta; tests that are
  not about subscription pass `subscribed: true` or subscribe explicitly.
- **Coexistence** (`src/graph/coexistence-service.ts`) is reached through
  Embedded Signup (`createSignup({ coexistence: true })`) and gates sends via
  `assertCanSend`/`recordSend` in `MessagingService`. It owns its own timers
  (inactivity, reconnection), cancelled in `clear()`.
- **`src/intercept.ts`** (`wamock/intercept` export) patches global `fetch` to
  redirect `graph.facebook.com`.
- **Webhooks** (`src/webhooks/`): `WebhookDispatcher` is the *only* entry point
  to the delivery queue and owns three rules — silent drop when the WABA is
  unsubscribed (except `account_update`, the partner's own field), per-tenant
  signing secret, duplication under the scenario. It also attaches the
  callback override to the delivery: the number's (`webhook_configuration`),
  else its WABA's (`override_callback_uri`), and only for
  `OVERRIDABLE_FIELDS` — template and account-level webhooks always go to the
  app's URL, as Meta routes them. `WebhookDeliverer` schedules
  deliveries on the clock and retries failures (1 min, doubling, up to 7
  days; `clear()` drops them); the transport receives the exact signed bytes
  (never re-serialize `body`). `httpTransport` counts only a 200 as delivered
  and delivers nothing to a URL until it passes the verification handshake. Statuses (`sent`,
  `delivered`) are scheduled in virtual time, so in frozen mode they only
  arrive after `time.advance()`. `signBody`/`verifySignature` (public exports)
  take `(appSecret, rawBody)` or an `{ appSecret, body }` object, and throw a
  `TypeError` when the positional arguments look swapped.

## Invariants (enforced — don't work around them)

- **No wall-clock reads outside `src/core/clock.ts`.** `Date.now()` and
  `new Date()` are banned by ESLint and by `test/no-wall-clock.test.ts`. Use
  the injected clock.
- **Determinism.** Ids come from a counter (`state.nextSeq()`), randomness from
  a seeded PRNG; `reset()` rewinds both. Two identical runs must produce
  identical output.
- **Emulate Meta as it runs today.** Verify payload shapes against the current
  reference pages (`developers.facebook.com/documentation/business-messaging/whatsapp/…`,
  each has a `.md` variant that is easy to fetch) before coding them. When the
  reference contradicts itself, pick one form and say which and why in a code
  comment. Never invent a field or wording. A quirk needs a source, either
  captured traffic or Meta's own example. "Verified in production" did not hold
  for the webhook's business-number `+`, which came from a hand-written fixture
  and shipped from 0.1 to 0.4. Messaging limits belong to the
  business portfolio (`Waba.businessId`) and only count recipients reached
  outside a customer service window. Pricing is per message (`src/core/pricing.ts`), including free entry point
  windows. Users are identified by BSUID (`src/core/users.ts`): every
  `messages` webhook carries `user_id`, and `wa_id`/`from` disappear for a user
  with a username unless the number was in contact with that phone in the last
  30 days. Build webhook payloads from a `UserIdentity`, never from a bare phone.
- **Reproduce Meta's quirks, don't smooth them over** (e.g. every number in a
  webhook is digits only, while the Graph API formats the business number as
  `+1 555-000-1111` — see `src/core/phone.ts`; status-only webhooks
  have no `messages` key; per-language template approval). Comment why so
  nobody "fixes" it.
- **Error wording is contract.** `test/errors/catalog-contract.test.ts` pins
  messages/types; changing an expected value there is a deliberate change to
  what wamock claims Meta returns, not a test to update casually.
- **Fixtures are executed.** `test/fixtures-contract.test.ts` rebuilds every
  file in `test/fixtures/` from the real builders and requires an exact match.
- **The README is executable.** `test/readme-is-executable.test.ts` replays
  every documented `curl` against `/__mock/`; README control-API examples and
  `examples/express` must keep working.
- **Public API is pinned** in `test/lib-contract.test.ts`.
- TypeScript is strict with `exactOptionalPropertyTypes` — that's why the code
  uses `...(x !== undefined ? { x } : {})` spreads instead of passing
  `undefined`. ESM with `NodeNext`: relative imports use `.js` extensions;
  type-only imports must use `import type`.

## Testing bar

- Tests first. Coverage thresholds (90% statements/lines/functions, 85%
  branches) are enforced for `src/core`, `src/errors`, `src/webhooks`.
- Mutation score is the real bar (break threshold in `stryker.config.json`).
  Pin observable contract (codes, wording, payload fields, Meta's limits), not
  developer debug text; when leaving a survivor alone, say why in the test file.
- Reading Stryker results: timeouts count as kills, so the headline score is
  inflated on slow machines — compare killed/survived counts across runs, not
  two scores. A reported survivor is a lead: apply the mutation by hand and
  confirm the suite stays green before writing a test for it.
- Fixtures in `test/fixtures/` are sanitized payload shapes using fixed
  placeholders (`5215555000001`, `15550001111`, `PNID_1`, `WABA_1`,
  `wamid.TEST1`) — never real tokens/numbers.

## Conventions

- Commit messages explain **why**; a behaviour change toward Meta should name
  the real failure it reproduces. Each release gets a `CHANGELOG.md` entry
  (Keep a Changelog).
- Releasing: `git tag vX.Y.Z && git push origin vX.Y.Z` triggers
  `.github/workflows/release.yml` (npm via Trusted Publishing/OIDC + multi-arch
  GHCR image).
- `specs/` is gitignored on purpose (private internal spec); code comments
  reference it as "spec §N".
- Clean-room: derive behaviour only from Meta's public docs and observed
  behaviour.
