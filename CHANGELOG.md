# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[semver](https://semver.org/).

## [0.4.0] — 2026-10-23

**wamock now emulates the WhatsApp Cloud API as Meta runs it today.** Several
things it reproduced as "faithful quirks" stopped being true over the last
year. Each change below was checked against Meta's current reference pages.
Where a page contradicts itself, the code says which form wamock picked and why.

### Breaking

- **Pricing is per message.** The `pricing` object now reads `pricing_model:
  "PMP"` with a `type` field. `CBP` only ever appears on webhooks sent before
  2025-07-01. Since 2026-10-01 each business phone number gets 1,000 free
  service messages a month (`type: "free_customer_service"`, `billable:
  false`). The 1,001st is `regular`. Templates are always `regular`, utility
  ones included, even inside an open customer service window.
- **`pricing` rides on one status per message**, `delivered` in wamock, not on
  both `sent` and `delivered`. Meta sends it on `sent` or on one of
  `delivered`/`read`, never on each.
- **No `conversation` object, outside free entry point windows.** Graph v24.0
  omits it unless the message went out inside one (see Added). Billing keyed
  on `conversation.id` reads `undefined` for every other message.
- **Messaging limits belong to the business portfolio**, as they have since
  2025-10-08. Every number in a portfolio shares one cap, so one busy number
  can block its siblings. Tenants created by `/__mock/embedded-signup` get
  their own portfolio unless `business_id` names an existing one.
- **Limits only count recipients reached outside a customer service window.**
  The old counter capped replies to customers who had written first, which
  Meta never does. Support traffic on a low tier was being refused.
- **`TIER_1K` is gone.** Meta's ladder is 250 → `TIER_2K` → `TIER_10K` →
  `TIER_100K` → `TIER_UNLIMITED`. `TIER_1` and `TIER_2` remain as wamock's
  test-only tiers.
- **`POST /__mock/quality` no longer sends a webhook.**
  `phone_number_quality_update` now reports throughput and limit changes only,
  and no current webhook carries a number's quality rating. The 0.3.0 fix (#4)
  made this endpoint deliver what it announced. What it announced turned out to
  be a webhook Meta retired. The rating still changes and is read with
  `?fields=quality_rating`.
- **Token errors lose their `(#code)` prefix.** `190` now reads `Error
  validating access token: Session has expired.` and `0` reads `Invalid OAuth
  access token - Cannot parse access token`, as Graph sends them. The fixture
  in `test/fixtures/` already said so. The catalogue contract test pinned the
  prefixed form and had been wrong all along.
- **`DISABLED` templates fail with `132016`, not `132015`.** A paused template
  comes back on its own; a disabled one never does. Reporting both as paused
  sent integrations to wait for a template that would not return.
- **Every `messages` webhook carries a business-scoped user ID.** Inbound
  messages gain `contacts[].user_id` and `messages[].from_user_id`. Statuses gain
  `recipient_user_id` and a `contacts` array on `sent`, `delivered` and `read`.
  A customer with a username (`/__mock/inbound {username}`) discloses no phone
  number at all unless your number was in contact with it in the last 30 days.
  `wa_id`, `from` and `recipient_id` then go missing.
- **Template status webhooks follow Meta's reference.** A pause reports
  `reason: "NONE"` (it said `PAIRWISE_QUALITY_SIGNAL`, which is not a reason
  Meta sends). Every event carries `message_template_category`, entry `time`
  and a numeric `message_template_id`. Pauses carry `other_info`, rejections
  `rejection_info`, disablements `disable_info`.
- **Pausing a template follows Meta's schedule.** The first pause lifts itself
  after 3 hours and the second after 6, each announced with `UNPAUSE`. The third
  `PAUSED` transition disables the template instead.
- **`GET /{waba_id}/message_templates` answers in Meta's shape** (`name`,
  `parameter_format`, `components`, `language`, `status`, `category`, `id`).
  It used to expose wamock's internal record, `wabaId` included.
- **`SendOptions` is a type alias, no longer an interface**, because a send
  takes `to`, `recipient` or both. Code that wrote `interface X extends
  SendOptions` now fails with TS2312; write `type X = SendOptions & { … }`
  instead.
- **`OutboundMessage` gains `recipientUserId` and `sentTo`.** These are
  `mock.messages()` entries, and integrations that build them by hand need both.

### Added

- **Sends to a BSUID.** `POST /{phone_number_id}/messages` takes `recipient`
  instead of `to`. With both, `to` wins, as at Meta. The response then carries
  `contacts[].user_id` and no `wa_id`. A BSUID only works from a number in its
  own portfolio (`131009` otherwise). Authentication templates refuse BSUID
  recipients with `131062`. The library's `send` takes `recipient` too.
- **Customers changing numbers.** `POST /__mock/users/change-number` (and
  `mock.changeUserNumber`) regenerates the BSUID and announces it as a `system`
  message: `user_changed_number` when the new number can be shared, otherwise
  `user_changed_user_id` with no phone number anywhere.
- **Mark as read and typing indicators.** `{status: "read", message_id,
  typing_indicator?}` on the messages route answers `{success: true}` instead
  of `(#100)`. An id the number never received fails with `131009`, as Meta
  documents. `mock.readReceipts()` lists them.
- **Marketing opt-out.** `POST /__mock/users/preferences` (and
  `mock.setUserPreference`) announces `user_preferences`. A marketing template to
  a stopped customer is accepted, then fails on its status with `131050`, and is
  not billed.
- **Free entry point windows.** An inbound with a Click-to-WhatsApp `referral`
  makes the business's reply inside the service window open a 7-day window.
  Inside it every message is `type: "free_entry_point"`, `category:
  "referral_conversion"`, spends no free tier, and carries a `conversation`
  object again.
- **Template recategorization.** `POST
  /__mock/templates/{name}/{language}/recategorize` (and
  `mock.recategorizeTemplate`) sends Meta's 24-hour notice, in which
  `new_category` still holds the current category, then switches. Sends bill
  under the new category from then on. `notice: false` switches at once.
- `parameter_format` (`named`, `positional`) on template creation.
- **Coexistence with the WhatsApp Business app.** `/__mock/embedded-signup
  {coexistence: true}` onboards a Business app number with seeded contacts and
  history, announcing `PARTNER_ADDED`. `POST /{phone_number_id}/smb_app_data`
  syncs contacts (`smb_app_state_sync`) and history (`history`, in phases,
  or `2593109` if not shared), once each (`2593107`) and only within 24 hours
  (`2593108`). Replies from the app (`/__mock/app/send`,
  `mock.businessApp.send`) arrive as `smb_message_echoes`, and open no window
  and cost nothing. Throughput is fixed at 20 messages per second. 14 days
  without app activity disconnect the number (`PARTNER_REMOVED`,
  `PRIMARY_INACTIVITY`), after which sends fail with `133010`.
  `/__mock/app/offboard` plays a device change (`ACCOUNT_OFFBOARDED`, then
  `ACCOUNT_RECONNECTED`). `?fields=is_on_biz_app` reports it.
- `POST /__mock/tier` announces the new limit with `business_capability_update`
  on every WABA in the portfolio. The limit is sent as a number (`2000`, `-1`
  for unlimited), following Meta's payload example and declared type rather
  than the tier strings its prose lists.
- `GET /{phone_number_id}?fields=whatsapp_business_manager_messaging_limit`.
  The deprecated `messaging_limit_tier` still answers, with the same value.
- Errors on `failed` statuses carry `error_data.details` and `href`, as Meta's
  do. `131049` matches Meta's own example word for word.
- `/__mock/state` reports business portfolios and each WABA's `businessId`.

### Fixed

- **zod 4, carried from 0.3.2.** The control API words its own validation
  errors, so the move kept every message as 0.3.1 sent it.
- **`business_capability_update` and template webhooks reach a WABA that has
  no phone number yet.** Account-level webhooks were routed through "some
  number on the WABA", which silently skipped one with none: the state right
  after a tech-provider signup.
- **Signup codes and issued tokens are deterministic.** Both came from
  `randomBytes`, so two identical runs minted different values, against the
  rule every other id in wamock follows. They now derive from counters that
  `reset()` rewinds.
- **`/__mock/embedded-signup` names what is wrong** with a rejected body, like
  every other control endpoint, instead of answering `Invalid signup options`.
- **A generated tenant can no longer land on a portfolio, WABA or number
  registered by hand** with the same id, where it would have shared a
  messaging limit or overwritten the record.
- **The fixtures in `test/fixtures/` were never executed.** `status-failed.json`
  described an `error_data` the builder did not emit, and nothing noticed.
  `test/fixtures-contract.test.ts` now rebuilds every fixture from the real
  builders and requires an exact match. Writing it is what surfaced the token
  error prefix above.
- The Express example sends to `v26.0` instead of `v19.0`, which Meta retired
  on 2026-05-21. It also logs the pricing type instead of calling every status
  a "conversation".

## [0.3.2] — 2026-10-23

**zod 3 → 4, with the control API's wording unchanged.**

zod 3 has no fix for GHSA-mrhx-c7xc-m3w5 (unbounded memory on bounded
collections, fixed in zod >= 4.6.6), so wamock moves to `^4.6.7`. Anyone who
pinned an override to keep zod 3 out of their tree can drop it.

The upgrade alone passed every test and still changed what the control API
says. `describeIssues` passed zod's own messages through, and zod 4 rewrote
nearly all of them: `from: Required` became `from: Invalid input: expected
string, received undefined`. The README's own example (`id: Required;
Unrecognized key(s) in object: 'messageId'`) silently stopped being true.
Nothing caught it, because the tests only checked that the offending field was
named.

wamock now words these itself, from each issue's kind and the value that was
sent. `test/control-validation-wording.test.ts` pins 36 invalid bodies across
`/__mock/inbound`, `/__mock/statuses` and `/__mock/scenario`. Every answer was
captured from the published 0.3.1, and every one comes back identical. A further
3,200 generated bodies across all eight control endpoints answer exactly as 0.3.1
did, status and wording both.

zod 4 changed more than wording, and two of those changes are undone on purpose:

- `.int()` now refuses integers past `Number.MAX_SAFE_INTEGER`, which 0.3.1
  accepted as a `seed` or an `ms`. It also stops checking after the first
  failure, so `times: -0.5` lost its second complaint. wamock checks integers
  itself, the way zod 3 did, and both behaviours are back.

One difference is kept, deliberately. A JSON number too large to represent, such
as `1e400`, parses to `Infinity`. 0.3.1 accepted that, so `{"latencyMs":1e400}`
scheduled statuses that never arrived. zod 4 refuses non-finite numbers, and
wamock keeps the refusal. It reports it truthfully as `Expected finite number,
received Infinity` rather than zod's `expected number, received number`. No
realistic call sends one, so this ships as a patch.

## [0.3.1] — 2026-07-30

**Fixed: the documented `docker run` command published a port that answered
nothing.**

`--host=0.0.0.0` lived in the image's `CMD`, and arguments after an image
replace `CMD` rather than adding to it. So the one form the README documents —
`docker run -p 4004:4004 ghcr.io/alrashidmtz/wamock --app-secret shhh` — dropped
that flag, the server bound loopback *inside* the container, and `-p` published
a port nothing was listening on. The Dockerfile's own comment called the flag
"overridable", which is what it was meant to be and is not what `CMD` does.

The flag moves to `ENTRYPOINT`, which arguments append to. The documented
command now works unchanged, `--host` stays overridable because the parser takes
the last occurrence, and the reachable-from-your-network warning still prints.

The README was never wrong; the image did not do what the README said. Same
class as the curl examples in 0.2.11, and hidden the same way: CI's smoke test
spelled out `--port` and `--host` in full, so it exercised a form no reader was
ever told to type. It now runs the documented command instead.

Affects the container image only. The npm package is unchanged.

## [0.3.0] — 2026-07-30

Three defects from field-testing a real integration against wamock (#3, #4,
#5). Two of them were reported as smaller than they turned out to be.

**Behaviour change — the control API now delivers before it answers.** A
webhook with no delay of its own is scheduled at the current instant, and a
frozen clock never reaches an instant by itself. The library helpers always
closed that gap; the HTTP door never did. So `POST /__mock/quality` changed the
rating, returned `200`, and announced nothing — against a README that says it
"announces it". The same held for template transitions, inbound messages and
forced statuses, and `/__mock/time/advance` moved the clock without waiting for
what it had kicked off.

This was filed as a documentation issue. It was not: the delay is real for
delivery statuses (`sent` at +50ms, `delivered` at +500ms, deliberately) and
absent for everything else. The flush now lives on the engine and both front
doors call it, so they cannot answer differently. **If you have a test
asserting that no webhook arrived before an `advance()` following a control-API
call, it will now see one.** Delivery statuses still need the clock to move,
and a test asserts exactly that so the fix cannot over-reach.

The mock's own suite had 11 hand-written `advance(0)` drains after control
calls, which is why the two doors were free to drift. They are gone.

Reads flush *before* they answer rather than after. Draining once the payload
is built is right for a write, whose deliveries do not exist until its handler
runs, and one moment too late for a read: `/__mock/state` briefly reported a
delivery count from before the queue it was about to drain. Same defect as the
`Set` below, found by measuring rather than by reasoning about the hook order.

**Fixed: `GET /__mock/state` reported every WABA as unsubscribed.**
`subscribedApps` is a `Set`, and `JSON.stringify(new Set(['a']))` is `{}` — so
the endpoint whose stated job is to be pasted into bug reports contradicted the
three other signals that say a WABA is subscribed, and pointed anyone debugging
silent inbound at the one cause that had been ruled out. The payload is built in
one place now, and a round-trip assertion guards the whole class rather than
this one field.

**Test quality.** Mutation kills 1846 → 1898, threshold 78 → 79, 526 → 561
tests. Four of the tests these fixes leaned on asserted the wrong thing:
`clock.stop()` was covered by "does not throw", which a `stop()` that clears
nothing satisfies perfectly; `start()` being a no-op on a frozen clock — what
every timing assertion in library mode rests on — was not covered at all; the
new swap guard's leniency cases all passed a JSON body, which satisfies the
guard's second clause on its own and left the half that examines the secret
unobserved; and the bounded settle never asserted that it takes its timeout
back down, so every flush could have left a five-second timer armed.

Two things about the metric itself, now written into `stryker.config.json`
rather than relearned. **The headline score can fall while the suite strictly
improves**: 82.07, then 81.09, then 80.88 across three runs of this branch,
while kills rose 1846 → 1887 the whole way. A timeout counts as a kill, and
those runs had 77, 22 and 8 of them — the early ones were masking survivors.
The release lands at 81.31 with 1898 kills, and every surviving mutant on a
line it changed is provably equivalent. Compare killed and survived counts,
never two headline numbers.

And a survivor is a lead, not a verdict: under `coverageAnalysis: perTest`,
mutants were twice reported as survived that the suite does kill — confirmed
by applying them by hand and watching it go red. Every fix here was verified
that way rather than by trusting the report, which is also how the last two
gaps surfaced: scoping the flush hook away from the Graph routes was
documented for the wrong reason and never asserted, and nothing checked that
a caller's `settleTimeoutMs` reaches the HTTP path at all.

**Fixed: `signBody`/`verifySignature` could be called backwards in silence.**
Both take two strings in a row, so swapping them type-checked and returned a
well-formed `sha256=…` that never verified — sending you to audit your own HMAC
check rather than your call. Both now accept `{ appSecret, body }`, which has no
order to get wrong. The positional form is deprecated but still compiles, so no
correct caller breaks; it throws when the arguments have visibly traded roles.
`verifySignature` still never throws for anything a request can reach — only the
app secret is inspected, and that half is never attacker-controlled.

## [0.2.12] — 2026-07-29

**No behaviour change. `dist/` is byte-identical to 0.2.11** — verified by
diffing a fresh pack against the published tarball. What changed is the suite
that guards it, and this release exists so that record ships with the package.

Mutation score 78.19 → 80.40 (`server.ts` 66.67 → 83.33, `control/routes.ts`
65.22 → 78.26); 498 → 526 tests. The surviving mutants all pointed at one gap:
rejection paths were never exercised. `if (!parsed.success)` survived in six
control routes, and so did `!clientId || !clientSecret || !code`,
`!inputToken || !accessToken`, `!name`, the version pattern, and every
optional-field spread. The suite only ever made correct calls, so nothing
pinned down what happens when a caller does not — which is the case a caller
actually meets.

Three of those mutants survived because assertions matched a symptom two
different causes produce. Checking a 400 does not distinguish "the route
refused this" from "it failed deeper for its own reasons", and in two cases
the deeper failure leaked something it should not: an internal class name, and
the literal string `undefined`, both inside a Meta-shaped error. Those
assertions now pin the message and forbid the leak.

The README's control-API examples and the Express example are now executed by
the suite, so neither can rot the way the pnpm advice in 0.2.10 and the curl
examples in 0.2.11 did. The mutation threshold rises 76 → 78 to hold the gain,
and that job now runs green in CI at 79.65 in 14m41s — its first run ever.

## [0.2.11] — 2026-07-28

**Fixed: every control-API example in the README failed when copy-pasted.**

`curl -d '{...}'` labels the body `application/x-www-form-urlencoded`, which is
curl's default for `-d`. Fastify ships a JSON parser only, so the request died
in the error handler as `(#100) Invalid parameter` — an error that blamed the
parameters for a body that was never read. Four of the README's own commands
did this, and so did anything anyone typed in a terminal.

The control API now reads any body as JSON, whatever the `content-type` claims,
and a body that genuinely is not JSON now says so instead of blaming the
parameters. `text/plain` needed naming separately: Fastify parses it itself and
handed the route a string, which surfaced as "Expected object, received string".
The Graph routes stay strict, where matching Meta is the point.

Found by executing the README rather than reading it, after the same class of
defect turned up in the pnpm advice in 0.2.10. Every other executable claim was
then run too: the TypeScript examples, the `wamock/intercept` subpath, and all
fourteen documented control-API request bodies.

## [0.2.10] — 2026-07-28

Documentation only.

- The README told pnpm users to run `pnpm add -D wamock@latest` to get around
  `minimumReleaseAge`. Measured: it does not work. That setting filters by
  publish age, not by dist-tag, so `@latest` still resolves to 0.1.0. Pinning an
  exact version does, and so does `--config.minimumReleaseAge=0`; the note now
  says that, and says npm and `npx` are unaffected. The README ships inside the
  package, so the wrong advice was on the npm page until this release.
- Added npm version, CI, Node and license badges. All read live state — a
  hardcoded version badge would drift the same way the advice above did.

## [0.2.9] — 2026-07-28

Documentation and release-pipeline fixes; no code changes.

- The container job now waits on npm for a tagged release. 0.2.5 and 0.2.7
  published an image while npm rejected the publish, so a version number meant
  different things depending on which registry you asked. Both entries below now
  say so; previously 0.2.5 read as an ordinary release.
- Corrected eight release dates that were a day ahead.

Published under npm's strictest publishing access — 2FA required, tokens
disallowed — which this release exists partly to prove is compatible with
Trusted Publishing.

## [0.2.8] — 2026-07-28

### Fixed

- **`package.json` declared no `repository`**, so publishing with provenance
  failed: the attestation records the source repo and the registry rejects a
  package whose manifest disagrees. Adding it also gives the npm page its
  Repository and Issues links, which were simply missing. `homepage` and `bugs`
  came along for the same reason.
- The release workflow's failure annotation assumed every publish failure was
  an authentication problem. The provenance rejection above proved otherwise —
  OIDC had already succeeded — so it now points at npm's actual error instead
  of guessing.

## [0.2.7] — 2026-07-28 — **npm publish rejected; container image exists**

The npm publish failed on the provenance check below, but the container job had
already succeeded, so `ghcr.io/alrashidmtz/wamock:0.2.7` exists while
`wamock@0.2.7` does not. Use 0.2.8. The workflow now gates the image on npm for
tagged releases so the two registries cannot disagree about a version again.

### Changed

- **Releases publish through Trusted Publishing (OIDC).** No token is stored
  anywhere, and npm attests which workflow and commit produced the tarball. The
  publish job moved to Node 24 for one reason: OIDC needs npm >= 11.5.1 and
  Node 22 still bundles 10.9.x, which fails with an authentication error that
  never mentions npm's version. Guarded explicitly so a runner-image change
  says so instead of failing cryptically. The README documents the one-time
  setup.

## [0.2.6] — 2026-07-28

### Added

- **A warning when `interceptGraph` was enabled but nothing was ever
  intercepted.** That is the signature of a client which captured
  `globalThis.fetch` before the mock installed its patch — it still holds the
  real one, and its requests reached Meta. Nothing can un-capture that
  reference, but staying silent about it was the dangerous part, and 0.2.5 only
  documented the hazard. The warning names the benign case too, so a test that
  simply makes no Graph calls is not left guessing.

## [0.2.5] — 2026-07-28 — **npm publish failed; container image exists**

Like 0.2.7 below, the npm job failed while the container job succeeded, so
`ghcr.io/alrashidmtz/wamock:0.2.5` exists and `wamock@0.2.5` does not. The
changes described here reached npm in 0.2.6.


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

## [0.2.4] — 2026-07-28

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

## [0.2.3] — 2026-07-28

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

## [0.2.2] — 2026-07-28

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

## [0.2.1] — 2026-07-28 — **broken, use 0.2.2**

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
