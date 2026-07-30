# wamock

[![npm](https://img.shields.io/npm/v/wamock)](https://www.npmjs.com/package/wamock)
[![ci](https://img.shields.io/github/actions/workflow/status/alrashidmtz/wamock/ci.yml?branch=main&label=ci)](https://github.com/alrashidmtz/wamock/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/wamock)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/wamock)](./LICENSE)

**Test your WhatsApp Cloud API integration without a WABA.**

A faithful, standalone mock of Meta's WhatsApp Cloud API. It plays both sides:
it answers your Graph API calls *and* delivers signed webhooks back to your app —
so you can drive the full cycle (inbound → your logic → outbound → delivery
statuses) in a test, with no Meta account, no approved templates, and no network.

MIT licensed. Node 22+. Two runtime dependencies.

```bash
npx wamock@latest start --app-secret shhh --webhook-url http://localhost:3000/webhook
```

<sub>**pnpm users:** pin the exact version — `pnpm add -D wamock@<version>`,
using the version in the npm badge above. pnpm's `minimumReleaseAge` skips
recently published packages as a supply-chain measure, and it filters by publish
age rather than by tag, so **`wamock@latest` does not get around it** — it
resolves to whatever is old enough, which today means 0.1.0. An exact version
does, as does `--config.minimumReleaseAge=0` if you would rather not pin.
npm and a plain `npx wamock@latest` are unaffected. Landing on 0.1.0 and
wondering where `interceptGraph` went is a bad first ten minutes.</sub>

```bash
curl -X POST localhost:4004/__mock/inbound \
  -d '{"from":"5215555000001","text":"hola"}'
```

Your app receives a webhook with a valid `X-Hub-Signature-256`. That's the
whole setup.

---

## Why this exists

Testing a WhatsApp integration normally means a real WhatsApp Business Account,
templates approved by Meta, a limited pool of test numbers — and finding out
about the serious bugs **in production**, because they only appear against real
traffic: phone number formats, the 24-hour window, per-language template
approval, redeliveries.

Existing OSS mocks cover the happy path of sending a message. BSP sandboxes tie
you to a vendor. wamock reproduces the failures.

## Battle-tested quirks

These are the behaviours wamock reproduces **on purpose**, because each one has
caused a real production incident and none of them show up against a lenient
mock.

### Customer numbers have no `+`. Business numbers do.

```jsonc
{
  "metadata": { "display_phone_number": "+15550001111" },  // with +
  "contacts": [{ "wa_id": "5215555000001" }],              // without
  "messages": [{ "from": "5215555000001" }]                // without
}
```

Normalize one and forget the other and you end up with two different keys for
the same human — which quietly breaks opt-out lookups, session keys and dedupe.

### Template approval is **per language**

`order_update` being APPROVED in `es_MX` tells you nothing about `en_US`.
wamock keys templates by `name` + `language` with no fallback, so a send in an
unapproved language fails with **132001** here instead of in production.

### Delivery receipts arrive with no `messages` key at all

Not an empty array — absent:

```jsonc
{ "value": { "metadata": {...}, "statuses": [...] } }   // no "messages"
```

`value.messages.forEach(...)` crashes on every status callback.

### At-least-once, and out of order

Meta retries. `delivered` can arrive before `sent`. Turn both on:

```bash
curl -X POST localhost:4004/__mock/scenario \
  -d '{"duplicateWebhooks":true,"outOfOrderStatuses":true}'
```

### The 24-hour window is not a suggestion

Free-form messages outside it fail with **131047**, permanently. The fix is a
template, not a retry. wamock lets you cross that boundary instantly:

```bash
curl -X POST localhost:4004/__mock/time/advance -d '{"ms":90000000}'
```

### Billing is per conversation, not per message

Statuses carry `conversation` and `pricing`. Ten messages inside one 24-hour
window are **one** billable conversation. Counting messages over-reports cost.

### Signatures cover the raw bytes

Verify against `JSON.stringify(req.body)` and you'll pass every test, then fail
the first time key order or whitespace differs. wamock signs exactly what it
sends.

The same helpers wamock signs with are exported, so your receiver can be tested
against them directly:

```ts
import { verifySignature } from 'wamock'

verifySignature({ appSecret, body: rawBody, header: signature })
```

Name the fields. The positional form — `verifySignature(appSecret, rawBody,
signature)` — still works and is deprecated, because two adjacent strings have
no safe order: `createHmac(alg, key)` puts the key first, most `sign(payload,
secret)` helpers put it second, and getting it backwards used to return a
well-formed `sha256=…` that simply never verified. wamock now refuses that call
instead of handing you a signature to distrust your own HMAC check over.

---

## Use it as a library

No ports, no network, no waiting:

```ts
import { createWamock } from 'wamock'

const mock = await createWamock({
  appSecret: 'test-secret',
  onWebhook: (delivery) => myApp.handleWebhook(delivery.body, delivery.signature),
})

await mock.inbound({ from: '5216691112233', text: 'hola' })   // note: no '+'
await mock.send({ to: '5216691112233', text: 'buenas' })

await mock.time.advance(25 * 60 * 60 * 1000)                  // the window expires

await expect(mock.send({ to: '5216691112233', text: 'sigues?' }))
  .rejects.toMatchObject({ code: 131047 })

await mock.approveTemplate({ name: 'recordatorio_24h', language: 'es_MX' })
await mock.send({ to: '5216691112233', template: { name: 'recordatorio_24h', language: 'es_MX' } })

mock.expectSent({ type: 'template', name: 'recordatorio_24h', language: 'es_MX' })
await mock.reset()
```

Time is virtual and frozen by default, so tests are deterministic — the same
script produces the same message ids on every run.

### Delivery statuses need the clock to move

Meta sends `sent` and `delivered` as webhooks *after* the send, never as its
response — and here they are due at a virtual instant that never arrives on its
own, because the clock is frozen. Asserting right after `send()` finds nothing
and reads like a broken mock rather than a stopped clock:

```ts
await mock.send({ to: CUSTOMER, text: 'hola' })
// no statuses yet — they are due at +50ms and +500ms of virtual time

await mock.time.advance(60_000)   // now `sent` and `delivered` have arrived
```

This is deliberate: real statuses do not arrive synchronously either, and a
mock that delivered them instantly would hide every ordering bug.

### Your app's clock is not wamock's clock

`time.advance()` moves **wamock's** clock. It cannot move the `Date.now()`
inside the code under test — nothing can reach into another module's notion of
time.

That matters whenever your app decides something from the current time. wamock
will refuse a free-form send with `131047` after 24 virtual hours, but if your
app also tracks the window itself, it still believes the conversation is open.
Age both sides:

```ts
await mock.time.advance(25 * 60 * 60 * 1000)
vi.setSystemTime(new Date(Date.now() + 25 * 60 * 60 * 1000))  // or your app's own clock
```

The durable fix is on your side: inject a clock rather than calling `Date.now()`
directly. wamock does exactly that internally, for the same reason.

`mock.baseUrl` also serves real HTTP, so an app that only knows how to talk to a
URL can be pointed at it in the same test.

### API reference

`createWamock(options)`:

| Option | Default | What it does |
|---|---|---|
| `appSecret` | *required* | Signs outgoing webhooks; your app verifies against it |
| `onWebhook` | — | Called with every webhook. This is what replaces a listening server |
| `webhookUrl` | — | Also POST webhooks here, for an app that cannot take a callback |
| `interceptGraph` | `false` | Redirect `graph.facebook.com` here; restored on `close()` |
| `start` | now | Starting virtual time. Pin it for byte-identical runs |
| `windowMs` | 24h | Shorten the service window so expiry tests are cheap |
| `settleTimeoutMs` | 5000 | How long each helper waits for your receiver before giving up |
| `phoneNumberId` | `PNID_DEFAULT` | Override the seeded number, to match your app's config |
| `wabaId` | `WABA_DEFAULT` | Override the seeded WABA |
| `displayPhoneNumber` | `15550001111` | The business number, digits only |

The returned `mock`:

| Member | What it does |
|---|---|
| `inbound({ from, text \| buttonReply \| listReply, name?, phoneNumberId? })` | A customer writes; opens the 24h window |
| `send({ to, text \| template \| interactive, phoneNumberId? })` | Send as your app would; rejects with Meta's error code |
| `time.advance(ms)` · `time.now()` | Move virtual time; everything due fires |
| `approveTemplate({ name, language, category? })` | Create a template already APPROVED |
| `transitionTemplate({ name, language, to })` | Play Meta's reviewer: APPROVED, PAUSED, REJECTED… |
| `expectSent(criteria)` | Assert on sent traffic; returns the match, throws with what *was* sent |
| `messages()` | Everything sent, for custom assertions |
| `scenario(config)` | Latency, failure rates, duplication, ordering, forced errors |
| `reset()` | Back to the seed state |
| `close()` | Stop everything and restore anything it patched |
| `baseUrl` · `phoneNumberId` · `wabaId` | Point a URL-only app at the mock |
| `engine` | The full engine, for anything the helpers do not cover |

`settleTimeoutMs` exists because every helper waits for the webhooks it
triggered, and that wait is on *your* receiver. A receiver that never resolves
would otherwise freeze the call with no output at all.

### If your client hardcodes `graph.facebook.com`

Most do. Nobody adds configuration for a hostname that never changes — we
checked two production integrations and **neither** had a base-URL setting.

So swap the destination underneath instead, without touching the client:

```ts
const mock = await createWamock({ appSecret: 'test-secret', interceptGraph: true })

await myApp.sendWhatsAppMessage(...)   // still calls graph.facebook.com

await mock.close()                     // restores the global fetch
```

Tying it to the mock means a forgotten cleanup cannot leave `fetch` patched for
every test that follows. If you need it without `createWamock`, the underlying
helper is still there and returns its own restore function:

```ts
import { installGraphInterceptor } from 'wamock/intercept'
const restore = installGraphInterceptor({ baseUrl: mock.baseUrl })
```

This patches the global `fetch`. It covers code that uses `fetch`; it does
**not** cover `axios`, `node-fetch` or raw `http.request` — those need their own
base URL or an HTTP proxy.

> **Build your client AFTER the mock, and assert the traffic arrived.**
>
> Patching a global only reaches code that reads it **on every call**. A client
> that captures it once — `constructor(private transport = globalThis.fetch)`,
> a very common dependency-injection default in TypeScript — keeps the original
> `fetch` if it was constructed first. The interception then does nothing, and
> nothing tells you: your requests go to the real `graph.facebook.com`. With a
> valid token in the environment, **a test sends real WhatsApp messages to real
> numbers.**
>
> ```ts
> const mock = await createWamock({ appSecret: 's', interceptGraph: true })
> const client = new MyWhatsAppClient()   // built after — captures the patched fetch
>
> await client.send(...)
>
> // Assert the traffic actually landed here. If it escaped, this is empty —
> // and that is the only signal you get.
> expect(mock.messages()).toHaveLength(1)
> ```
>
> If you cannot control construction order, pass the mock's `fetch` in
> explicitly, or point the client at `mock.baseUrl` instead of intercepting.

---

## Fidelity

| | wamock | typical OSS mock | BSP sandbox |
|---|---|---|---|
| Send messages | ✅ | ✅ | ✅ |
| Signed webhooks back to your app | ✅ | partial | ✅ |
| 24h window enforcement (131047) | ✅ | ❌ | partial |
| Per-language template approval | ✅ | ❌ | partial |
| Template state machine (paused/rejected) | ✅ | ❌ | ❌ |
| Virtual clock — expire the window instantly | ✅ | ❌ | ❌ |
| Duplicate / out-of-order webhooks | ✅ | ❌ | ❌ |
| Faithful error codes and HTTP statuses | ✅ | partial | ✅ |
| Conversation + pricing objects | ✅ | ❌ | partial |
| Interactive limits enforced (3 buttons, 10 rows) | ✅ | ❌ | ✅ |
| Works offline, in CI | ✅ | ✅ | ❌ |
| Vendor-neutral | ✅ | ✅ | ❌ |

**Honest caveat:** the `conversation` and `pricing` objects are modeled from
Meta's public documentation rather than captured from production traffic. The
shape and field names are faithful; treat the finer points of category
assignment as best-effort. Everything else was verified against two production
integrations.

---

## Emulated surface

### Graph API

| Endpoint | Notes |
|---|---|
| `POST /{version}/{phone_number_id}/messages` | `text`, `template`, `interactive` (button + list) |
| `POST /{version}/{waba_id}/message_templates` | → `PENDING`; duplicates return "already exists" |
| `GET /{version}/{waba_id}/message_templates` | list with per-language status |
| `DELETE /{version}/{waba_id}/message_templates?name=` | deletes every language |
| `POST /{version}/{phone_number_id}/media` | stub — valid id, no bytes |
| `GET /{version}/{media_id}` | URL that expires after ~5 minutes |

Any `vNN.N` version segment is accepted — real integrations are scattered
across v17 through v23.

### Control API — what Meta doesn't give you

Every body here is read as JSON whatever the `content-type` says, so a plain
`curl -d '{...}'` works — curl labels that `x-www-form-urlencoded`, and requiring
the header turned every copy-pasted example into `(#100) Invalid parameter`. The
Graph routes stay strict, where matching Meta is the point.

| Endpoint | Request body | What it does |
|---|---|---|
| `POST /__mock/inbound` | `{from, text}` · or `{from, button_reply:{id,title}}` · or `{from, list_reply:{id,title,description?}}` — plus optional `name`, `phone_number_id` | a customer writes; opens/renews the 24h window |
| `POST /__mock/statuses` | `{id, status}` where `status` is `sent\|delivered\|read\|failed`; optional `error` (a numeric code) | force a message to a status Meta would not produce on its own |
| `POST /__mock/time/advance` | `{ms}` | move the virtual clock; fires everything due |
| `POST /__mock/templates/{name}/{language}/transition` | `{to}` — `APPROVED\|REJECTED\|PAUSED\|PENDING\|DISABLED`; optional `?waba_id=` | play Meta's reviewer |
| `POST /__mock/scenario` | `{seed?, latencyMs?, sendFailureRate?, webhookFailureRate?, duplicateWebhooks?, outOfOrderStatuses?, nextError?:{code,times?}}` | latency, failure rates, duplication, ordering |
| `POST /__mock/embedded-signup` | `{subscribed?}` | mint a signup code, optionally with the WABA unsubscribed |
| `POST /__mock/tokens` | `{kind?, scopes?}` — `permanent\|short\|long` | mint a token to exercise expiry and missing scopes |
| `POST /__mock/quality` | `{quality_rating}` — `RED\|YELLOW\|GREEN`; optional `phone_number_id` | change a number's quality and announce it |
| `POST /__mock/tier` | `{tier}` — `TIER_250\|TIER_1K\|…`; optional `phone_number_id` | set the messaging limit tier |
| `POST /__mock/reset` | `{}` | back to the seed state |
| `GET /__mock/state` · `GET /__mock/messages` | — | inspect |

Every body is validated strictly: an unexpected key is rejected and named, so a
typo does not look like it worked. `{messageId, status}` on `/__mock/statuses`
answers `id: Required; Unrecognized key(s) in object: 'messageId'` rather than
leaving you to guess.

### Tech Provider mode

If you onboard *other* businesses onto your own Meta app, this is the surface
that breaks and that no other mock covers.

| Endpoint | Notes |
|---|---|
| `GET /{version}/oauth/access_token` | exchange an Embedded Signup code; single-use |
| `GET /{version}/debug_token` | `is_valid` + `expires_at` (`0` = never expires) |
| `POST /{version}/{waba_id}/subscribed_apps` | without it, webhooks never arrive |
| `GET /{version}/{waba_id}/subscribed_apps` | list subscriptions |
| `GET /{version}/{phone_number_id}?fields=` | `display_phone_number`, `quality_rating`, `messaging_limit_tier` |

Control endpoints: `POST /__mock/embedded-signup`, `POST /__mock/tokens`,
`POST /__mock/quality`, `POST /__mock/tier`.

**The four scenarios worth reproducing:**

1. **The Graph Explorer token.** Someone pastes a ~2h token into your connect
   form. It works. Two hours later every send is a 401 and nothing says why.
   ```bash
   curl -X POST localhost:4004/__mock/tokens -d '{"kind":"short"}'
   # ...send with that Bearer token, advance 3h, watch it become 190
   ```
2. **The unsubscribed WABA.** The number connects, the dashboard looks correct,
   and inbound messages simply never arrive — no error anywhere.
   ```bash
   curl -X POST localhost:4004/__mock/embedded-signup -d '{"subscribed":false}'
   ```
3. **Cross-signing.** You host numbers for your own app *and* for customers who
   bring their own. Verifying everything with one secret works right up until
   the second app exists. wamock signs each tenant's webhooks with that
   tenant's secret.
4. **Asynchronous template approval.** Approval lands hours later as a
   `message_template_status_update` webhook, never as a response to your
   submission. Integrations that only react to their own calls never see it.

`expires_at: 0` means **never expires**, not "expired in 1970". Code that
compares it numerically against the clock rejects exactly the System User
tokens that are safe to use.

Messaging tiers cap **unique recipients per rolling 24 hours**, not messages —
so metering message volume tells you nothing about how close you are.

### Error catalogue

| Code | Case | Retry? |
|---|---|---|
| `131047` | free-form outside the 24h window | no — send a template |
| `132001` | no template for that name + language | no |
| `132015` | template paused by Meta | no, until it transitions back |
| `131026` | recipient cannot receive | no |
| `131048` | spam / quality rate limit | yes, with backoff |
| `130429` | throughput rate limit | yes |
| `100` | invalid parameter (incl. interactive limits) | no |
| `190` / `0` | token expired or invalid | no — re-auth |
| `131000` | transient Meta-side failure | yes |

Each returns Meta's real HTTP status too: `429` for `130429`, `401` for `190`,
`400` for the rest.

---

## Scenario knobs

```jsonc
POST /__mock/scenario
{
  "seed": 42,                    // all randomness is seeded — runs replay exactly
  "latencyMs": { "min": 100, "max": 800 },
  "sendFailureRate": 0.1,        // POST /messages fails; your app finds out
  "webhookFailureRate": 0.1,     // the send succeeds and the webhook never arrives
  "duplicateWebhooks": true,
  "outOfOrderStatuses": true,
  "nextError": { "code": 130429, "times": 3 }
}
```

The two failure rates are separate on purpose. "The send failed" is visible
immediately. "The webhook never arrived" is invisible until something times out
— and that's the one that costs money.

---

## Docker

```bash
docker run -p 4004:4004 ghcr.io/alrashidmtz/wamock:edge \
  --app-secret shhh --webhook-url http://host.docker.internal:3000/webhook
```

Two tags: `:edge` tracks `main`, and `:latest` / `:x.y.z` appear once a version
is released. Images are `linux/amd64` and `linux/arm64`, and each one is
smoke-tested in CI — pulled, started, and driven through a full message
lifecycle — before it is considered published.

The image already passes `--host 0.0.0.0`, which it needs to be reachable
through `-p`. See `examples/docker-compose` for a CI-shaped setup.

---

## A note on exposure

wamock binds **127.0.0.1 by default**. The `/__mock` control API has no
authentication — appropriate for a local tool, and the reason the default
matters: anyone who can reach the port can read `/__mock/messages` (every
message your app sent, recipients and bodies included) and POST
`/__mock/inbound` to inject forged customer messages into it.

`--host 0.0.0.0` exists for containers, where the boundary does the limiting.
The CLI prints a warning when you use it. Don't run it that way on a shared
network, and never point it at production data.

---

## Not in v1

No GUI, no disk persistence, no multi-tenant auth, no real media storage, no
WhatsApp Flows or calling. See `CHANGELOG.md` for what's planned.

### It emulates Meta directly, not a BSP wrapper

If your code talks to **Twilio, 360dialog, MessageBird or any other BSP**, this
is not your mock. Those are different APIs, not a different flavour of the same
one — different hosts, different auth, form-encoded bodies instead of JSON, and
`X-Twilio-Signature` (HMAC-SHA1 over URL and params) instead of
`X-Hub-Signature-256` (HMAC-SHA256 over the raw body).

wamock speaks `graph.facebook.com` with a bearer token. That is deliberate:
being tied to no vendor is the point. If you talk to Meta through a BSP, your
BSP's sandbox is the right tool.

---

## Is a hosted version worth building?

A hosted version — conversation UI, shareable scenarios, team workspaces — is
an idea, not a plan. If you'd use one, say so in
[Discussions](https://github.com/alrashidmtz/wamock/discussions); if enough
people would, it gets built.

No email form. Starring the repo and opening issues tells us more than a
signup would, and you get the tool either way.

## Releasing

`git tag vX.Y.Z && git push origin vX.Y.Z` publishes both npm and the container
image. The npm half authenticates through **Trusted Publishing** (OIDC) — no
token is stored anywhere, and npm attests which workflow and commit produced
the tarball.

Configured once, at
[npmjs.com/package/wamock/access](https://www.npmjs.com/package/wamock/access) →
*Trusted Publisher*:

| Field | Value |
|---|---|
| Repository | `alrashidmtz/wamock` |
| Workflow filename | `release.yml` |
| Environment | *(leave empty)* |

One requirement that is easy to miss: OIDC needs **npm ≥ 11.5.1**, and Node 22
still bundles 10.9.x. The publish job runs on Node 24 for that reason alone, and
guards the version explicitly so a regression says so instead of failing with an
authentication error that never mentions npm's version.

## Contributing

Bug reports about **fidelity** are the most valuable kind: if wamock accepts
something Meta rejects, or returns a different code than Meta does, that's a
bug worth filing with the real payload attached (sanitized). See
`CONTRIBUTING.md`.

## License

MIT
