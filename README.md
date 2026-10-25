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
age rather than by tag, so **`wamock@latest` does not get around it**. It
silently resolves to whatever release happens to be old enough — an arbitrarily
old one, and if none is yet, the install fails outright. An exact version gets
past it, as does `--config.minimumReleaseAge=0` if you would rather not pin.
npm and a plain `npx wamock@latest` are unaffected. Landing on some ancient
release and wondering where a documented feature went is a bad first ten
minutes.</sub>

```bash
curl -X POST localhost:4004/__mock/inbound \
  -d '{"from":"5215555000001","text":"hola"}'
```

Your app receives a webhook with a valid `X-Hub-Signature-256`. That's the
whole setup.

Before the first webhook, wamock runs Meta's verification handshake against the
URL: `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`, expecting a
`200` whose body is the challenge and nothing else. Until your endpoint passes
it, webhooks wait and are retried, as Meta delivers nothing to an unverified
URL. The token is `wamock-verify-token` unless you pass `--verify-token`.

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

### Your own number comes in two formats

Meta writes the business number differently depending on where you meet it:

```jsonc
// Graph API — GET /{phone_number_id}?fields=display_phone_number
{ "display_phone_number": "+1 555-000-1111" }                 // + and grouped

// every webhook
{ "metadata": { "display_phone_number": "15550001111" },      // digits only
  "contacts": [{ "wa_id": "5215555000001" }] }                // customers too
```

The usual path is to store the formatted number from the Graph lookup when a
business connects, then match incoming webhooks against it. That gives one
number two keys, and routing, dedupe and opt-out lookups break without an error.
Normalize both sides to digits.

wamock got this wrong until 0.5.0 and sent a `+` on the webhook side. Meta's
examples, and public captures 107 to 6, say digits only.

### The customer's phone number may not be there at all

Since April 2026 every message webhook carries a **business-scoped user ID**
(`user_id`, e.g. `MX.13491208655302741918`). A customer who adopts a WhatsApp
username stops disclosing their phone number: unless your number was in contact
with that phone number in the last 30 days, `wa_id` and `from` are simply absent.

```jsonc
{
  "contacts": [{ "profile": { "username": "pablomorales" }, "user_id": "MX.1349…" }],
  "messages": [{ "from_user_id": "MX.1349…", "type": "text" }]   // no "from"
}
```

Key customers on `wa_id` and these messages have no owner. The BSUID is the one
identifier that is always there. It is scoped to the business portfolio, and it
changes when the customer changes numbers (announced as a `system` message). Send
to it with `recipient` instead of `to`:

```bash
curl -X POST localhost:4004/__mock/inbound \
  -d '{"from":"5215555000001","text":"hola","username":"pablomorales"}'
```

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

Meta retries any webhook your receiver did not answer with a `200` — a `204`
counts as a failure — "with decreasing frequency" for up to 7 days. wamock
does the same: a minute later, then at doubling intervals, on the virtual
clock, so `time.advance` replays an outage in milliseconds. A handler that is
not idempotent processes the retry twice.

`delivered` can also arrive before `sent`, and the same webhook can arrive
twice. Turn both on:

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

### Billing is per message, and `pricing` rides on one status

Since July 2025 Meta prices every delivered **message** (`pricing_model:
"PMP"`). The `pricing` object appears on **one** status per message (`sent`,
or one of `delivered`/`read`), never on each. wamock puts it on `delivered`, so
code that reads it off `sent` alone finds nothing. The `conversation` object is
gone too: v24.0 omits it outside free entry point windows, and billing keyed on
`conversation.id` quietly counts zero.

```jsonc
"pricing": { "billable": false, "pricing_model": "PMP",
             "type": "free_customer_service", "category": "service" }
```

Since October 1, 2026 replies are no longer free without limit. Each business
number gets 1,000 free service messages a month (`free_customer_service`), and
the 1,001st is `regular`, billable. Templates are always `regular`, utility
included.

An **authentication** template can bill as `authentication_international`:
to a user in one of the 18 markets with that rate, once your portfolio is
eligible and past its start time for that country, and never in the country
your business is based in. (Kazakhstan shares +7 with Russia, which wamock
reads as Russia, so a Kazakh number bills as `authentication`.) Meta announces
both on `account_update`
(`AUTH_INTL_PRICE_ELIGIBILITY_UPDATE`, `BUSINESS_PRIMARY_LOCATION_COUNTRY_UPDATE`)
and on `GET /{waba_id}?fields=auth_international_rate_eligibility,primary_business_location`.
`POST /__mock/auth-international` plays Meta deeming you eligible:

```bash
curl -X POST localhost:4004/__mock/auth-international \
  -d '{"start_time":1767225600,"primary_business_location":"MX"}'
```

A customer who writes in from a **Click-to-WhatsApp ad** changes the picture:
your reply inside the service window opens a 7-day free entry point window in
which everything is free, marketing included (`type: "free_entry_point"`), and
the only place v24.0 still sends a `conversation` object.

Unlike the quirks above, this one comes from Meta's documentation, not from
production traffic. See the caveat under [Fidelity](#fidelity).

### A stopped customer fails on the status, not on the send

A customer who taps "Stop" on your marketing sends you a `user_preferences`
webhook, and nothing else. Marketing templates to them are still **accepted**,
then fail on their status with `131050`. An integration that only checks the
send response keeps paying for campaigns nobody receives.

### Paused templates come back on their own, until the third time

A template Meta pauses for quality returns by itself after 3 hours the first
time and 6 hours the second (`other_info.title: "UNPAUSE"`). The third pause
disables it for good (`132016`). Meta may also **recategorize** an approved
template, utility to marketing say. It warns 24 hours ahead with a
`template_category_update` in which `new_category` still holds the *current*
category, then switches. The template stays APPROVED and nothing fails: only the
bill changes.


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

### Webhooks with a delay need the clock to move

A webhook due *later* is due at a virtual instant that never arrives on its own,
because the clock is frozen. Delivery statuses are the case you meet first:
Meta sends `sent` and `delivered` as webhooks after the send, never as its
response, so asserting right after `send()` finds nothing and reads like a
broken mock rather than a stopped clock:

```ts
await mock.send({ to: CUSTOMER, text: 'hola' })
// no statuses yet — they are due at +50ms and +500ms of virtual time

await mock.time.advance(60_000)   // now `sent` and `delivered` have arrived
```

This is deliberate: real statuses do not arrive synchronously either, and a
mock that delivered them instantly would hide every ordering bug.

Anything with **no** delay of its own — an inbound message, a messaging-limit
change, a template transition — arrives before the call that caused it returns, whether
you made it through a helper or with `curl` against the control API. You never
have to advance the clock to see those.

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
| `webhookUrl` | — | Also POST webhooks here, for an app that cannot take a callback. Only a `200` counts as delivered |
| `verifyToken` | — | Run Meta's verification handshake against `webhookUrl` first, and deliver nothing until it passes |
| `interceptGraph` | `false` | Redirect `graph.facebook.com` here; restored on `close()` |
| `start` | now | Starting virtual time. Pin it for byte-identical runs |
| `windowMs` | 24h | Shorten the service window so expiry tests are cheap |
| `settleTimeoutMs` | 5000 | How long each helper waits for your receiver before giving up |
| `phoneNumberId` | `200000000000004` | Override the seeded number, to match your app's config |
| `wabaId` | `200000000000003` | Override the seeded WABA |
| `displayPhoneNumber` | `15550001111` | The business number, digits only |

Graph object ids are numeric strings, as Meta's are: portfolios, WABAs and
numbers get 15 digits, media and templates longer ones. (Message ids keep
Meta's `wamid.` shape, and BSUIDs theirs.) Read them from
`mock.engine.state` (`defaultPhoneNumberId`, `defaultWabaId`…) or from what
the call returned, rather than writing them into a test.

The returned `mock`:

| Member | What it does |
|---|---|
| `inbound({ from, text \| image \| video \| document \| audio \| sticker \| location \| contacts \| reaction \| button \| buttonReply \| listReply, contextId?, name?, username?, referral?, phoneNumberId? })` | A customer writes; opens the 24h window. Media gets a real id that downloads (`bytes`, or a placeholder); `button` is a template quick-reply tap; `contextId` makes it a reply; `username` hides their phone number; `referral` marks a Click-to-WhatsApp ad |
| `send({ to \| recipient, text \| template \| interactive, phoneNumberId? })` | Send as your app would, to a phone number or a BSUID; rejects with Meta's error code |
| `time.advance(ms)` · `time.now()` | Move virtual time; everything due fires |
| `approveTemplate({ name, language, category?, components? })` | Create a template already APPROVED. With `components`, sends must match its placeholders (132000) |
| `transitionTemplate({ name, language, to })` | Play Meta's reviewer: APPROVED, PAUSED, REJECTED… Pauses lift themselves; the third disables |
| `recategorizeTemplate({ name, language, to, notice? })` | Meta's automated recategorization: a notice now, the change 24h later |
| `setUserPreference({ from, value })` | A customer stops or resumes marketing (`stop` \| `resume`) |
| `changeUserNumber({ from, to })` | A customer changes numbers; their BSUID changes with it |
| `status({ id, status, error? })` | Move a sent message to `sent`, `delivered`, `read`, `played` (voice messages only) or `failed` (which needs `error`, a numeric code; no other status takes one) |
| `expectSent(criteria)` | Assert on sent traffic; returns the match, throws with what *was* sent |
| `messages()` | Everything sent, for custom assertions |
| `readReceipts()` | Every mark-as-read, with whether it asked for a typing indicator |
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
| Per-message pricing objects (PMP, monthly free tier) | ✅ | ❌ | partial |
| Messaging limits shared across the business portfolio | ✅ | ❌ | ❌ |
| Business-scoped user IDs, usernames, sends to a BSUID | ✅ | ❌ | partial |
| Free entry point windows (Click-to-WhatsApp ads) | ✅ | ❌ | ❌ |
| Marketing opt-out (`user_preferences`, `131050`) | ✅ | ❌ | partial |
| Mark as read and typing indicators | ✅ | partial | ✅ |
| Coexistence with the WhatsApp Business app | ✅ | ❌ | partial |
| Interactive limits enforced (3 buttons, 10 rows) | ✅ | ❌ | ✅ |
| Every message type, inbound and outbound | ✅ | partial | ✅ |
| Media: multipart upload, 5-minute URLs that download, 30-day ids | ✅ | ❌ | ✅ |
| Webhook retries for 7 days; only `200` counts | ✅ | ❌ | partial |
| Business tokens limited to their own customer | ✅ | ❌ | ❌ |
| Works offline, in CI | ✅ | ✅ | ❌ |
| Vendor-neutral | ✅ | ✅ | ❌ |

**wamock emulates Meta as it runs today, whatever date its clock starts
at.** The virtual clock measures windows, expiries and retries; it does not
select which year's rules apply. A test that starts the clock in January 2026
still gets October 2026's pricing (a utility template inside the service
window is billable, and only 1,000 service messages a month are free).

**Honest caveat:** the `pricing` object, the portfolio messaging limits,
business-scoped user IDs, free entry point windows, `user_preferences`, the
template pause and recategorization flows, and coexistence are modeled from
Meta's documentation rather than captured from production traffic, and so are
the webhook retry schedule (Meta publishes only "decreasing frequency, up to 7
days"; wamock doubles from one minute), media URLs (signed by wamock, not
Meta's format) and the phone-number cursors (opaque, but wamock's own). One
choice is inferred rather than documented: a media `link` that is not a URL
is accepted and fails on its status with 131053, like a link Meta could not
fetch; Meta's pages do not say whether it fails the send instead. Field names
and values follow Meta's reference. A BSUID's digits come from a hash of the
portfolio and phone number, so they are stable across runs but not what Meta
would issue. Two simplifications are deliberate: the free tier resets at
midnight UTC (Meta uses the account's timezone), and it is counted at send time
(Meta counts deliveries). Where Meta's own reference contradicts itself, wamock
picks one form and says so in the code. For example, `business_capability_update`
sends the limit as a number (`2000`, `-1` for unlimited), following Meta's
example over its prose.

The rest was built from two production integrations. Their test fixtures were
partly hand-written, though, and one of them gave wamock the `+` it put on the
business number in webhooks until 0.5.0. When wamock and Meta disagree, Meta is
right: report it as a fidelity bug.

---

## Emulated surface

### Graph API

| Endpoint | Notes |
|---|---|
| `POST /{version}/{phone_number_id}/messages` | `text`, `template`, `interactive` (button, list, `cta_url`), `image`, `audio`, `video`, `document`, `sticker`, `location`, `contacts`, `reaction`, addressed by `to` or `recipient` (BSUID), with `context` and `biz_opaque_callback_data` (a string, at most 512 characters). Also mark-as-read, with an optional typing indicator: `{status:"read", message_id, typing_indicator?}` |
| `POST /{version}/{waba_id}/message_templates` | → `PENDING`; duplicates return "already exists"; `parameter_format` `named`\|`positional` |
| `GET /{version}/{waba_id}/message_templates` | Meta's shape: `name`, `parameter_format`, `components`, `language`, `status`, `category`, `id`; `?name=` filters; paged 25 at a time unless `limit` (1 to 100), with `after`/`before` cursors and `paging.next`/`previous`; a cursor naming no template is `131059` from v24 |
| `DELETE /{version}/{waba_id}/message_templates?name=` | deletes every language |
| `POST /{version}/{phone_number_id}/media` | `multipart/form-data`: `messaging_product`, `type`, `file`; Meta's types and size limits; → `{id}`, valid 30 days |
| `GET /{version}/{media_id}` | `{url, mime_type, sha256, file_size, id}`; a fresh URL each time, valid 5 minutes; optional `phone_number_id` |
| `GET <media url>` | the bytes, with a bearer token; 404 once the URL has expired |
| `DELETE /{version}/{media_id}` | `{success: true}`; optional `phone_number_id` |
| `POST` · `DELETE /{version}/{phone_number_id}/block_users` | block or unblock `{messaging_product, block_users:[{user}]}` (at most 1,000): only customers who wrote in the last 24h can be blocked; per-user `failed_users` beside Meta's `139100`. A message to a blocked customer fails on its status with `130403`, and nothing comes in from them |
| `GET /{version}/{phone_number_id}/block_users` | the blocked customers, paged with `limit`, `after`, `before` |

Graph routes take JSON, `application/x-www-form-urlencoded` (nested objects as
JSON-valued fields, as Meta reads them) and, for media, `multipart/form-data`.

Any `vNN.N` version segment is accepted — real integrations are scattered
across v17 through v26, the latest.

### Control API — what Meta doesn't give you

Every body here is read as JSON whatever the `content-type` says, so a plain
`curl -d '{...}'` works — curl labels that `x-www-form-urlencoded`, and requiring
the header turned every copy-pasted example into `(#100) Invalid parameter`. The
Graph routes read a body as what it is labelled, as Meta does.

| Endpoint | Request body | What it does |
|---|---|---|
| `POST /__mock/inbound` | `{from, text}` · or one of `image` / `video` / `document` / `audio` / `sticker` (`{caption?, filename?, mime_type?, voice?, animated?, data?}`, `data` the file as base64), `location`, `contacts`, `reaction:{message_id,emoji}`, `button:{payload,text}` (template quick reply), `button_reply:{id,title}`, `list_reply:{id,title,description?}`, `unsupported:{type}`, and on a Coexistence number `edit:{message_id, text | caption}` (within 15 minutes) or `revoke:{message_id}` (within two days), which do not touch the window — plus optional `context_id`, `name`, `username`, `referral`, `phone_number_id` | a customer writes; opens/renews the 24h window |
| `POST /__mock/users/preferences` | `{from, value}` — `stop\|resume`; optional `phone_number_id` | a customer stops or resumes marketing; announces `user_preferences` |
| `POST /__mock/users/change-number` | `{from, to}`; optional `phone_number_id` | a customer changes numbers; announces a `system` message with the new BSUID |
| `POST /__mock/statuses` | `{id, status}` where `status` is `sent\|delivered\|read\|played\|failed` (`played` only for audio sent with `voice: true`); `error` (a numeric code) with `failed`, and only with it | force a message to a status Meta would not produce on its own |
| `POST /__mock/time/advance` | `{ms}` | move the virtual clock; fires everything due |
| `POST /__mock/templates/{name}/{language}/transition` | `{to}` — `APPROVED\|REJECTED\|PAUSED\|PENDING\|DISABLED`; optional `?waba_id=` | play Meta's reviewer; a pause lifts after 3h, then 6h, and the third disables |
| `POST /__mock/templates/{name}/{language}/recategorize` | `{to, notice?}` — `UTILITY\|MARKETING\|AUTHENTICATION`; optional `?waba_id=` | Meta's automated recategorization: notice now, change in 24h |
| `POST /__mock/scenario` | `{seed?, latencyMs?, sendFailureRate?, webhookFailureRate?, duplicateWebhooks?, outOfOrderStatuses?, nextError?:{code,times?}}` | latency, failure rates, duplication, ordering |
| `POST /__mock/embedded-signup` | `{subscribed?, registered?, phone?, business_id?, coexistence?}` | mint a signup code; the WABA starts unsubscribed and its number unregistered, as with Meta (`subscribed: true` and `registered: true` skip those steps). An unregistered number neither sends (`133010`) nor receives: `/__mock/inbound` to it is refused. `phone` is how the customer finished: `verified` (default), `unverified` (which `registered: true` cannot register: it must be verified first) or `none` (no `phone_number_id`). A `coexistence` number is already registered. Optionally under an existing business portfolio |
| `POST /__mock/throughput-upgrade` | `{phone_number_id?}` | Meta upgrades the number to higher throughput: every Graph request on it answers `131057` for a minute, then `phone_number_quality_update` `THROUGHPUT_UPGRADE`. Needs an unlimited portfolio and a quality of YELLOW or better |
| `POST /__mock/auth-international` | `{business_id?, start_time?, exception_countries?:[{country_code, start_time}], primary_business_location?}` (unix seconds; start 30 days out by default) | Meta deems the portfolio eligible for authentication-international rates, and says so on `account_update` |
| `GET /__mock/verification-code?phone_number_id=` | — | the code `request_code` "sent" to a number, as its SMS would read (`mock.verificationCode(id)` in a test) |
| `POST /__mock/tokens` | `{kind?, scopes?}` — `permanent\|short\|long` | mint a token to exercise expiry and missing scopes |
| `POST /__mock/phone-status` | `{status}` — a value of Meta's enum for a number's status (`CONNECTED`, `DISCONNECTED`, `PENDING`, `FLAGGED`, `RESTRICTED`, `RATE_LIMITED`, `MESSAGING_LIMIT_TIER_0`…`4`); optional `phone_number_id` | change what `?fields=status` reads, silently. The values are inferred: Meta's reference gives this enum to a status update's `connection_status`, not to the field a read returns. Meta does not document what each status does to sends, so wamock only reports it |
| `POST /__mock/quality` | `{quality_rating}` — `RED\|YELLOW\|GREEN\|NA\|UNKNOWN` (Meta spells a number not rated yet both `NA` and `UNKNOWN`); optional `phone_number_id` | change a number's quality rating, silently (see below) |
| `POST /__mock/tier` | `{tier}` — `TIER_250\|TIER_2K\|TIER_10K\|TIER_100K\|TIER_UNLIMITED`, or wamock's `TIER_1\|TIER_2`; optional `phone_number_id` | set the messaging limit of that number's business portfolio; announces `business_capability_update` |
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
| `GET /{version}/debug_token` | every field of Meta's reference: `is_valid`, `expires_at` (`0` = never expires), `data_access_expires_at`, `issued_at`, `scopes`, `granular_scopes` (with the customer's WABA as `target_ids`), `user_id`; the app token in the query or as a bearer token |
| `POST /{version}/{waba_id}/subscribed_apps` | without it, webhooks never arrive; `override_callback_uri` (at most 200 characters) + `verify_token` send this WABA's webhooks elsewhere, after the handshake. Only the fields Meta lets an override take (`messages`, the coexistence fields…) follow it; template and account webhooks stay on the app's URL |
| `GET /{version}/{waba_id}/subscribed_apps` | list subscriptions, with `override_callback_uri` when set |
| `DELETE /{version}/{waba_id}/subscribed_apps` | unsubscribe; deliveries stop at once |
| `POST /{version}/{waba_id}/phone_numbers` | `{cc, phone_number, verified_name}`: a new, unverified number → `{id}` |
| `POST /{version}/{phone_number_id}/request_code` · `verify_code` | `code_method` (`SMS`\|`VOICE`) and `language`, then `code`, in the query or the body; `136024` for a number already verified |
| `POST /{version}/{phone_number_id}/register` · `deregister` | `{messaging_product, pin}`: the first PIN becomes the number's (`133005` after); `133006` until verified; 10 calls per 72h (`133016`). A coexistence number cannot be deregistered |
| `GET /{version}/{waba_id}/phone_numbers` | every number on the WABA, as Embedded Signup's last step reads them: `verified_name`, `display_phone_number`, `id`, `quality_rating` by default, or `?fields=`; newest first, or oldest with `sort=['last_onboarded_time_ascending']` / `last_onboarded_time.asc`; paged with `limit`, `after`, `before` |
| `GET /{version}/{phone_number_id}?fields=` | by default `id`, `display_phone_number`, `verified_name`, `quality_rating`; also `status`, `name_status`, `unified_cert_status`, `code_verification_status`, `account_mode`, `host_platform`, `platform_type`, `is_on_biz_app`, `country_code`, `country_dial_code`, `is_official_business_account`, `whatsapp_business_manager_messaging_limit` (and the deprecated `messaging_limit_tier`, same value), `throughput`, `webhook_configuration` |
| `POST /{version}/{phone_number_id}` | `webhook_configuration: {override_callback_uri, verify_token}`: the number's own callback URL, ahead of its WABA's; `""` removes it. Needs the WABA subscribed. The other settings this call takes in production are not emulated |

Control endpoints: `POST /__mock/embedded-signup`, `POST /__mock/tokens`,
`POST /__mock/quality`, `POST /__mock/phone-status`, `POST /__mock/tier`,
`POST /__mock/throughput-upgrade`.

A token wamock issued is checked on every Graph route. Expired or revoked, it
fails with `190` wherever it is used, not only on sends. It needs
`whatsapp_business_messaging` to send or handle media and
`whatsapp_business_management` for templates, numbers and subscriptions. A
business token from Embedded Signup reaches only its own customer: another
WABA, its numbers or its media answer Graph's unsupported-request error. A call
with no token, or with a token wamock did not issue, is let through, so real
clients work unchanged.

Embedded Signup tells the partner about the new customer with `account_update`
`PARTNER_ADDED`. That field is the partner's own, so it arrives before the
partner subscribes to the customer's WABA; nothing else does.

**The five scenarios worth reproducing:**

1. **The Graph Explorer token.** Someone pastes a ~2h token into your connect
   form. It works. Two hours later every send is a 401 and nothing says why.
   ```bash
   curl -X POST localhost:4004/__mock/tokens -d '{"kind":"short"}'
   # ...send with that Bearer token, advance 3h, watch it become 190
   ```
2. **The unsubscribed WABA.** The number connects, the dashboard looks correct,
   and inbound messages simply never arrive — no error anywhere. Every signup
   starts this way, as with Meta, until your code subscribes (`registered:
   true` sets aside the next scenario, so this one is all you see):
   ```bash
   curl -X POST localhost:4004/__mock/embedded-signup -d '{"registered":true}'
   curl -X POST localhost:4004/v26.0/$WABA_ID/subscribed_apps
   ```
3. **The unregistered number.** Embedded Signup verifies the customer's
   number but never registers it: that is your step, and until you take it
   every send fails with `133010`. A customer can also finish with an
   unverified number, or none (`phone: "unverified"` / `"none"`), and then
   your code creates, verifies and registers it:
   ```bash
   curl -X POST localhost:4004/v26.0/$PHONE_NUMBER_ID/register \
     -H 'content-type: application/json' -d '{"messaging_product":"whatsapp","pin":"123456"}'
   ```
4. **Cross-signing.** You host numbers for your own app *and* for customers who
   bring their own. Verifying everything with one secret works right up until
   the second app exists. wamock signs each tenant's webhooks with that
   tenant's secret.
5. **Asynchronous template approval.** Approval lands hours later as a
   `message_template_status_update` webhook, never as a response to your
   submission. Integrations that only react to their own calls never see it.

`expires_at: 0` means **never expires**, not "expired in 1970". Code that
compares it numerically against the clock rejects exactly the System User
tokens that are safe to use.

Messaging limits cap **unique recipients reached outside a customer service
window per rolling 24 hours**, not messages, so metering message volume tells
you nothing about how close you are. Replies to customers who wrote first never
count. Since October 2025 the limit belongs to the **business portfolio**: every
number in it draws on the same cap, and one busy number can block its siblings.

No webhook announces a number's **quality rating** any more.
`phone_number_quality_update` now reports throughput changes only (`event`
`ONBOARDING` or `THROUGHPUT_UPGRADE`), so a receiver waiting on it for a
downgrade waits forever. Poll `?fields=quality_rating,status` instead;
`POST /__mock/quality` and `POST /__mock/phone-status` change what it reads.
`POST /__mock/throughput-upgrade` plays Meta upgrading a number to 1,000
messages per second: every Graph request on the number answers `131057` for
the minute the upgrade takes,
then sends `THROUGHPUT_UPGRADE`, and `?fields=throughput` reads `HIGH` (the
level Meta documents is `STANDARD`; `HIGH` is what third-party guides report).

### Coexistence — the WhatsApp Business app and Cloud API on one number

A business already on the **WhatsApp Business app** can onboard its number to
Cloud API and keep using the app. Half of every conversation then happens where
your integration cannot see it.

```bash
curl -X POST localhost:4004/__mock/embedded-signup \
  -d '{"coexistence":true,"contacts":[{"phone":"5215555000001","full_name":"Pablo Morales"}]}'
```

What wamock reproduces:

- **Replies from the app arrive only as `smb_message_echoes`.** They open no
  service window and cost nothing, so a customer answered from the app still
  needs a template from Cloud API.
- **Contacts and chat history sync once each, within 24 hours.** Call
  `POST /{phone_number_id}/smb_app_data` with `sync_type` `smb_app_state_sync`
  or `history`. A second call fails with `2593107` and a late one with
  `2593108`. History arrives in phases by age (`phase` 0, 1, 2; `progress` up
  to 100), or as `2593109` if the business declined to share it. Customers seen
  only in history have no open window.
- **Throughput is fixed at 20 messages per second** (`130429` past it).
- **About 14 days without the app in use disconnects the number**
  (`PARTNER_REMOVED`, `PRIMARY_INACTIVITY`). Sends then fail with `133010`, and
  `is_on_biz_app` reads `false`. A device change offboards the number
  (`ACCOUNT_OFFBOARDED`) until it reconnects (`ACCOUNT_RECONNECTED`).

| Endpoint | Request body | What it does |
|---|---|---|
| `POST /{version}/{phone_number_id}/smb_app_data` | `{messaging_product, sync_type}` | Graph: request contacts or history |
| `POST /__mock/embedded-signup` | `{coexistence: true, share_history?, contacts?, history?}` | onboard a Business app number; announces `PARTNER_ADDED`. `history` is `[{phone, messages:[{direction:"in"\|"out", text, ago_ms}]}]` |
| `POST /__mock/app/send` | `{phone_number_id, to, text}` | the business replies from the app |
| `POST /__mock/inbound` with `edit` / `revoke` | `{from, phone_number_id, edit:{message_id, text \| caption}}` · `{…, revoke:{message_id}}` | the customer edits (15 minutes) or deletes (two days) a message: Meta's `edit` and `revoke` messages webhooks |
| `POST /__mock/app/contacts` | `{phone_number_id, phone, full_name?, first_name?, action?}` | a contact is added, edited or removed in the app |
| `POST /__mock/app/offboard` | `{phone_number_id, reconnect?}` | the business changes device |

In a test, the same is `mock.engine.createSignup({ coexistence: true, … })` and
`mock.businessApp.send / contact / offboard`. Not emulated: media in history,
group chats, companion devices, and Embedded Signup's popup itself. wamock hands
you its result.

### Error catalogue

| Code | Case | Retry? |
|---|---|---|
| `131047` | free-form outside the 24h window | no — send a template |
| `132001` | no template for that name + language | no |
| `132015` | template paused by Meta | no, until it transitions back |
| `132016` | template disabled for good after repeated pauses | no — create a new template |
| `131026` | recipient cannot receive | no |
| `131050` | the customer stopped your marketing — on the **status**, not the send | no |
| `132000` | template parameters do not match its placeholders | no |
| `133005` / `133006` / `133016` | `register` with the wrong PIN, before verifying, or more than 10 times in 72h | no |
| `130403` | a message to a customer the business blocked — on the **status**, not the send | no — unblock them first |
| `139100` | some users in a block or unblock request could not be; the per-user errors (`131047`, `131021`, `139101`) come beside it | no |
| `131057` | a number mid throughput upgrade (the minute it takes) | yes, once the upgrade is done |
| `131059` | listing templates with a `before`/`after` cursor that names no template (v24+). Meta documents the code but not its message; wamock's restates the changelog | no — retry without the cursor |
| `132012` | a template parameter's value is not in the form its type needs | no |
| `132018` | Meta's catch-all for invalid template parameters; wamock answers the specific `132000`/`132012`, and gives `132018` its wording when a scenario forces it | no |
| `131053` | media of a type that kind of message cannot carry (on the send), or a `link` that is not http(s) (on the **status**) | no |
| `131009` | parameter value not valid: a media id nobody uploaded or past its 30 days, a reaction to a message it cannot react to, marking an unknown message as read, a BSUID from another portfolio | no |
| `131062` | sending an authentication template to a BSUID | no — use the phone number |
| `133010` | sending from a number not registered on Cloud API: after Embedded Signup until your code calls `register`, after `deregister`, or a coexistence number that was disconnected or offboarded | no — register it, or the business reconnects |
| `2593107` / `2593108` | `smb_app_data` called twice, or 24h or more after onboarding | no — offboard and onboard again |
| `131048` | spam / quality rate limit, or the portfolio's messaging limit | yes, with backoff |
| `130429` | throughput rate limit | yes |
| `100` | invalid parameter (incl. interactive limits) | no |
| `190` / `0` | token expired or invalid | no — re-auth |
| `131000` | transient Meta-side failure | yes |

Each returns Meta's real HTTP status too: `429` for `130429`, `401` for `190`
and `0`, `403` for a missing permission (`200`), `422` when an override
callback fails its handshake, `500` for `131000` and for a fault in wamock
itself (`1`), `400` for the rest. Token errors (`190`, `0`) carry no `(#code)` prefix in their
message, unlike every messaging error, so a log parser keyed on `(#190)` never
sees an expired token.

On a `failed` status, each error carries `code`, `title`, `message` (the same as
`title`), `error_data.details` and `href`. The explanation is in `details`.

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

Two tags: `:latest` / `:x.y.z` are published from a version tag, and `:edge` is
rebuilt from `main` on demand — so it is only as current as the last manual run,
never automatically ahead of the newest release.

Both images are `linux/amd64` and `linux/arm64`, and both are smoke-tested by
pulling back what was just pushed and running it — the amd64 one through a full
message lifecycle, ending in the `131047` a closed 24h window should produce;
the arm64 one booted under emulation and checked that it reports its
architecture and accepts an inbound, because QEMU is too slow to be worth more
than that. The push happens first, so a failing smoke test fails the release
loudly rather than un-publishing anything: check that the release run is green
before trusting a tag.

The image passes `--host 0.0.0.0` from its `ENTRYPOINT`, which it needs to be
reachable through `-p`, and your own arguments are added to it rather than
replacing it. See `examples/docker-compose` for a CI-shaped setup.

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

No GUI, no disk persistence (media lives in memory), no multi-tenant auth, no
WhatsApp Flows, calling, groups or the Marketing Messages API, and no Embedded
Signup popup (wamock gives you its result, the code). See
`CHANGELOG.md` for what changed.

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
