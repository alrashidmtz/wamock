# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[semver](https://semver.org/).

## [0.6.1] — 2026-10-24

### Fixed

- **`POST /{waba_id}/phone_numbers` tells whether `phone_number` includes its
  calling code by its length.** A national number that happened to start with
  the code (a Brazilian `55912345678` with `cc: "55"`) was read as already
  including it, and stored as `55912345678` instead of `5555912345678`. The
  lengths a fixed-line or mobile number has in each country, from
  libphonenumber's metadata, now decide; where both readings fit (34 of the
  206 calling codes, Germany and China among them), Meta's own example still
  does, and a number that includes its code is read as such. See
  `THIRD_PARTY_NOTICES.md`.

## [0.6.0] — 2026-10-24

### Breaking

- **A number from Embedded Signup starts unregistered.** Signup verifies the
  customer's number; registering it is the partner's step, and until then
  every send fails with `133010`, as in production. Call `POST
  /{phone_number_id}/register` as your code does, or pass `registered: true`
  to `createSignup` / `/__mock/embedded-signup` for a test that is not about
  registration. A Business app (coexistence) number is already registered.
  An unregistered number receives nothing either: `/__mock/inbound` refuses
  it.

### Added

- **Registering a number, the partner's step.** `POST /{waba_id}/phone_numbers`
  (a new, unverified number), `request_code`, `verify_code`, `register` and
  `deregister`, as Meta's "Registering business phone numbers" describes:
  `133006` before verifying, the first PIN becomes the number's (`133005`
  after), 10 register/deregister calls per 72 hours (`133016`), `136024` for
  a code requested for a verified number, and a coexistence number cannot be
  deregistered. A test reads the code "sent" with `mock.verificationCode()` or
  `GET /__mock/verification-code`. `GET /{phone_number_id}` reports the real
  `code_verification_status` and `verified_name`.
- **Embedded Signup finishes as Meta's does since v3:** with a verified
  number, an unverified one, or none (`phone: "unverified"` / `"none"`, which
  answers no `phone_number_id`).
- **Authentication-international rates.** An authentication template to a
  user in one of the 18 markets on Meta's page bills as
  `authentication_international` once the portfolio is eligible, past its
  start time (or its country's exception), and the user is not in the country
  the business is based in; each market counts only from its launch (the last
  nine on October 1, 2026). `POST /__mock/auth-international` plays Meta
  deeming a portfolio eligible, with `account_update`
  `AUTH_INTL_PRICE_ELIGIBILITY_UPDATE` and
  `BUSINESS_PRIMARY_LOCATION_COUNTRY_UPDATE`, and `GET /{waba_id}` answers
  `auth_international_rate_eligibility` and `primary_business_location`. Meta
  spells the category with an underscore in its payload example and a hyphen
  in one list; wamock follows the example. Kazakhstan shares +7 with Russia,
  so a Kazakh number is not told apart.
- **The Block Users API.** `POST`, `DELETE` and `GET
  /{phone_number_id}/block_users`, as Meta's "Block users" page describes
  them: only a customer who wrote in the last 24 hours can be blocked, at most
  1,000 a request and 64,000 in all, and a request where some users fail
  answers them one by one in `failed_users` (`131047`, `131021` for the
  business's own number, `139101`) beside a top-level `139100`. A message to
  a blocked customer is accepted and fails on its status with `130403`, as
  integrators report it, unbilled; a blocked customer's message never
  arrives, so `/__mock/inbound` refuses it. Not documented by Meta, and
  inferred: the HTTP status of a partly failed request (400, since its body
  carries an `error`), and that unblocking needs no recent message (a
  blocked customer cannot write, so it would make every block permanent).

### Fixed

- **A missing permission answers Graph's `(#200) Permissions error`, HTTP
  403**, as Meta's error code reference (200-299) and its registration page
  give it. 0.5.0 answered `(#100)` with a 400. Registering and deregistering
  need both `whatsapp_business_management` and `whatsapp_business_messaging`.
- **A fault inside wamock answers HTTP 500, code 1,** with `wamock internal
  error: …` in its details. Every error that was not a Graph error used to be
  rendered `(#100) Invalid parameter`, so a bug in the mock read as a mistake
  in the request. A body that cannot be read is still Graph's 100, and so is
  an out-of-range scenario value on the control API.
- **The control API reads a multipart body as JSON too**, as it does every
  other content type; it answered "Malformed multipart/form-data body".
- **A JSON request with no body is read as no parameters.** Meta's examples
  call `request_code`, `verify_code` and `deregister` with a query alone, and
  clients that still send `content-type: application/json` got a 400.
- **Inputs that broke the mock are refused as the caller's 100:** a query
  parameter given twice (a repeated `access_token` used to skip the token
  check), a template component that is not an object, a Host header that is
  no host, and a clock advance past the last instant a date can hold (it left
  every later send failing on an Invalid Date, even after a reset).
- **A token in the `access_token` parameter is checked** like one in the
  Authorization header. Only the header was read, so a token in the query
  went unchecked: an expired one passed, and a tenant's token reached another
  tenant.
- **Through the interceptor, wamock hands out Meta's URLs.** A media URL from
  `GET /{media_id}` pointed at the mock's own address, and so did
  `paging.next`; a client that allows only Meta's hosts (an SSRF guard on
  downloads) refused them. Intercepted requests now get
  `lookaside.fbsbx.com` and `graph.facebook.com`, which the interceptor routes
  back to the mock. Without the interceptor, the mock's own address, which is
  the one that works.

## [0.5.0] — 2026-10-24

**A field-by-field audit against Meta's current references, done with Codex
as a second reviewer.** The aim is that a test passing against wamock means
the same code works against Meta. Every gap the audit found was a case where
the two disagreed: wamock accepted something Meta refuses, refused something
Meta accepts, or left out behaviour an integration depends on. Each one below
cites the page it comes from in a comment beside the code.

**The business number carried a `+` in every webhook. Meta sends digits
only.**

`metadata.display_phone_number` was `+15550001111` on every webhook wamock has
ever sent. Meta's examples show `15550783881`, in all of the roughly fifteen
webhook references, and so do public captures from other integrations: 107
repositories send digits only, against 6 with a `+`, one of which was wamock
itself. Several of the 107 are n8n workflow exports, which record real
executions. The `+` came from a hand-written test fixture that the README then
described as verified in production. It was not.

The quirk wamock meant to reproduce is real, but it sits elsewhere. The
**Graph API** formats the same number: `GET
/{phone_number_id}?fields=display_phone_number` now answers `+1 555-000-1111`,
where it used to answer `+15550001111`. An integration that stores the Graph
form at connect time and matches webhooks against it holds two keys for one
number. North American numbers are grouped exactly as in Meta's examples.
Elsewhere wamock writes `+{calling code} {national number}` without Meta's
per-country grouping, which would need a phone number library.

### Added

- **Every message type the Messages API accepts:** `image`, `audio`, `video`,
  `document` and `sticker` (by `id` or `link`), `location`, `contacts`,
  `reaction` and the `cta_url` interactive. Sending one used to fail with
  (#100). The per-type rules are checked: one of `id`/`link`, caption only on
  image, video and document and at most 1024 characters, coordinates in range,
  `name.formatted_name` on every contact, `display_text` up to 20 characters.
  A media `id` must be one this mock holds and that has not expired, wherever
  it appears: the media of the message, the media header of an interactive
  message, or a media parameter of a template. Otherwise the send fails with
  131009. Media of a type that kind of message cannot carry (a PDF sent as
  an image) fails the send with 131053, as Meta's per-type message pages say
  an unsupported format fails the request. A `link` that is not an http(s)
  URL is accepted and then fails on its status with 131053, the way Meta
  reports media it could not fetch. The type is judged by its base, so a
  received voice note (`audio/ogg; codecs=opus`) can be sent back as audio. A reaction gets only a `sent` status and is not
  priced. A reaction to a message from another chat, over 30 days old, or that
  is itself a reaction fails on its status with 131009.
- **Media as Meta handles it.** Upload is `multipart/form-data` with
  `messaging_product`, `type` and `file`, checked against Meta's supported
  types and their size limits. `type` may also come only on the file part,
  as in Meta's own example (`-F 'file=@video.mp4;type=video/mp4'`). The id lives 30 days. Each `GET /{media_id}`
  answers a fresh download URL that lives 5 minutes and really downloads:
  `GET` it with a bearer token and you get the bytes and their MIME type, or a
  404 once it has expired. `DELETE /{media_id}` works, and `phone_number_id`
  limits both calls to the number that uploaded the media. `sha256` is base64,
  as in Meta's examples. The interceptor routes `lookaside.fbsbx.com` to the
  mock too.
- **Form bodies on Graph routes.** `application/x-www-form-urlencoded`, with
  nested objects as JSON-valued fields, is accepted like JSON, as Meta accepts
  it.
- **Inbound messages of every kind** through `POST /__mock/inbound` and
  `mock.inbound()`: `image`, `video`, `document`, `audio` (with `voice`) and
  `sticker` (with `animated`), each with a real media id that lives 7 days and
  downloads the bytes the test supplied (`data` as base64, or `bytes`).
  Also `location`, `contacts`, `reaction`, a template quick-reply tap
  (`type: "button"`), and `unsupported` with Meta's 131051 error. Any inbound
  can reply to a message with `context_id` / `contextId`, delivered as
  `context: {from, id}`. A reaction without `emoji` is a removed reaction,
  as Meta reports it. Inbound audio always carries `voice` and stickers
  `animated`, `false` when not set.
- **Webhook retries.** A delivery that fails is tried again, a minute later and
  then at doubling intervals, for up to 7 days, as Meta retries.
  `engine.reset()` drops pending retries. A webhook the app unsubscribed from
  while it was being delivered is cancelled, not failed: nothing logged,
  nothing retried. One whose WABA changed its callback meanwhile goes to the
  new callback. A custom transport can cancel the same way by throwing the
  exported `DeliveryCancelled`, and is handed a `DeliveryAttempt` to ask
  whether it still counts.
- **`DELETE /{waba_id}/subscribed_apps`**, and `override_callback_uri` with
  `verify_token` on `POST`. The URL must pass the handshake with that token
  before the subscription is accepted; otherwise Meta's 422, `Webhook callback
  URL is not reachable or invalid` (a malformed URI gets the 400 `Invalid
  callback URI format`, as does one over Meta's 200 characters). The WABA's
  webhooks then go there, and `GET` reports the override. Unsubscribing stops
  deliveries at once, retries included. Only the fields Meta's overrides page
  lists follow an override (`messages`, the coexistence fields…): template and
  account-level webhooks always go to the app's own URL, as with Meta.
- **A phone number's own callback URL.** `POST /{phone_number_id}` with
  `webhook_configuration: {override_callback_uri, verify_token}` sends that
  number's webhooks there, ahead of its WABA's override, after the same
  handshake; an empty `override_callback_uri` removes it. The WABA must be
  subscribed first, as Meta requires. `GET
  /{phone_number_id}?fields=webhook_configuration` reports `phone_number`,
  `whatsapp_business_account` and `application`, each only when set.
- **The `played` status** Meta has sent since March 17, 2026 the first time a
  customer plays a voice message: `POST /__mock/statuses` takes it for an
  `audio` message sent with `voice: true`, and refuses it for anything else,
  since Meta never sends it there. Library mode gets `mock.status({ id,
  status, error? })`, which forces any status and waits for its webhook, as
  the other helpers do.
- **`debug_token` answers every field of Meta's reference:**
  `data_access_expires_at`, `issued_at`, `user_id` and `granular_scopes`, whose
  `target_ids` name the customer's WABA for a business token. `application` is
  the app's name. The app token is also accepted as a bearer token.
- **Business tokens reach only their own customer.** A token from Embedded
  Signup that touches another WABA, its numbers or its media gets Graph's
  unsupported-request error, as with Meta. Tokens wamock did not issue are
  still not checked.
- **Permissions per endpoint.** Sending and media need
  `whatsapp_business_messaging`; templates, phone numbers and subscriptions
  need `whatsapp_business_management`. Before, only subscribing checked one.
- **Phone-number fields from the reference:** `status`, `name_status`,
  `unified_cert_status`, `account_mode`, `host_platform`,
  `is_official_business_account`, `country_code` and `country_dial_code`. A
  quality rating can be `UNKNOWN`.
- **`GET /{waba_id}/phone_numbers`**, the call Embedded Signup's final step
  makes to find the number it just connected. Meta's default fields
  (`verified_name`, `display_phone_number`, `id`, `quality_rating`) come back,
  or exactly the `fields` asked for, including `is_on_biz_app` and
  `platform_type` for coexistence. Newest number first, or oldest first with
  `sort=['last_onboarded_time_ascending']` or `sort=last_onboarded_time.asc`
  (Meta's pages spell it both ways). It pages like every Graph edge: `limit`
  (1 to 100), `after` and `before` cursors, and `paging.next` / `previous`.
- **`GET /{waba_id}/message_templates` pages.** 25 templates a page unless
  `limit` says otherwise (the default integrators report from Meta), with
  `after`/`before` cursors and `paging.next`/`previous`; `?name=` filters. A
  cursor that names no template answers `131059` from v24, as Meta's
  changelog says; the message is wamock's, since Meta documents only the
  code. `132018`, Meta's catch-all template validation error, is in the
  catalogue with Meta's wording, for scenarios that force it.
- **A Coexistence customer edits or deletes a message**, as the `edit` and
  `revoke` messages webhooks Meta added for Coexistence in November 2025:
  `POST /__mock/inbound` and `mock.inbound()` take `edit: {message_id, text |
  caption}` within 15 minutes and `revoke: {message_id}` within two days. An
  edit carries the whole message as it now reads, media and reply context
  included. Neither opens or renews the service window; Meta's pages describe
  the window as opened by the user writing, and say nothing of edits.
- **`PARTNER_ADDED` on every signup.** Meta sends `account_update` "whenever a
  customer successfully completes the Embedded Signup flow". `account_update`
  belongs to the partner, so it arrives before the partner subscribes to the
  customer's WABA.

### Fixed

- **Templates are checked as Meta checks them.** The category is
  case-insensitive (Meta's own examples write `utility`); the name is at most
  512 characters; the language must be one of the 111 Meta supports. A send
  whose parameters do not match the template's placeholders (header text and
  body; the exact set of names for a named template) fails with 132000, and
  one whose value is not in its type's form (`text` without a string, an
  empty object) with 132012. A copy code button's code is at most 20
  characters, its `example` at creation and its `coupon_code` at send.
  `mock.approveTemplate()` takes `components` so a test can declare them.
- **Interactive limits:** body at most 1024 characters for buttons and 4096 for
  lists, header text and footer at most 60, button id at most 256 and titles
  unique, row id at most 200, at most 10 sections, and a title on each section
  when there is more than one. A footer needs its text, and a header the
  content of its type: text, image, video or document for buttons and CTA URL
  messages, text only for lists. A CTA URL button needs a real http(s) URL.
  Text messages are capped at 4096, a contacts message at 257 contacts.
- **Only a template opens a conversation.** Every other type now needs the 24h
  window, not just text and interactive.
- **`recipient_type`** must be `individual`; `group` is refused as not
  emulated.
- **`biz_opaque_callback_data`** comes back on every status of the message,
  and is a string of at most 512 characters, the limit Meta's changelog sets.
- **Graph's error for an object that is not there.** An unknown WABA, number or
  media id answers `Unsupported get request. Object with ID '…' does not
  exist, cannot be loaded due to missing permissions, or does not support this
  operation…`: code 100, subcode 33, `GraphMethodException`, as Graph words it.
- **`mock.time.advance()` waits for everything the advance led to**, not
  just the first deliveries: a reply your handler sends, or a webhook
  rerouted to a new callback, arrives before the helper returns. One
  exception: a call made while another helper or control request is still
  delivering (from your handler, or concurrently) waits only for the
  deliveries it fired itself, and leaves follow-ups that come due later to
  the call already delivering. That is what keeps a handler that calls back
  into the mock, in-process or over HTTP, from waiting on its own delivery.
- **No helper or control request waits on a delivery that was already
  running when it was called.** A handler calling back into the mock — even
  a duplicate of the same webhook, or over HTTP — no longer waits for itself
  until the timeout, and a long queue of earlier deliveries no longer counts
  against a later request's 100-round limit.
- **`settleTimeoutMs` bounds the whole call.** Each round of a flush used to
  get the full budget, so a receiver that never answered held a helper or
  control request for at least twice `settleTimeoutMs`, and one that hung on
  every reply for up to 100 times it. A control `GET` flushed twice (before
  answering and again after), and so did a mistyped `/__mock/` path on its
  way to the 404, each spending a second budget.
- **`engine.reset()` starts webhook delivery afresh.** A delivery still in
  flight when the mock was reset no longer lands in the new log, and the HTTP
  transport forgets which URLs it verified, so the next test runs the
  handshake again.
- **Only an HTTP 200 counts as delivered.** A receiver answering 201, 202 or
  204 had its webhook counted as delivered; Meta retries it.
- **The verification handshake is exact.** It needs a 200 whose body is the
  challenge and nothing more: no 2xx other than 200, no trailing newline.
  And nothing is delivered to a URL that has not passed it. The CLI used to
  warn and deliver anyway; now webhooks wait, retried, and the handshake runs
  again first. `createWamock({ webhookUrl, verifyToken })` does the same, and
  library mode now sends the same headers as the server.

- **An expired token now fails on every Graph route.** Only the send route and
  app subscription checked a wamock-issued token. The template, media,
  phone-number and `smb_app_data` routes answered an expired one with success,
  so expired-token handling could only be exercised on sends.
- **The calling-code table covers the whole E.164 plan:** 206 geographic codes,
  matching libphonenumber's set. A Serbian or Finnish number had no country, so
  its BSUID got the `ZZ` prefix and its Graph number missed the separating space.
  Inmarsat's non-geographic 870 maps to no country.

### Changed

- **The Docker image runs on Node 26**, the line that becomes LTS on
  2026-10-28 (it was Node 22, now in maintenance). The npm package still
  supports Node 22 and later, and CI now tests 22, 24 and 26.
- **fastify 5.12**, the only runtime dependency that moved. The toolchain is
  current too: TypeScript 6.0, ESLint 10, Vitest 5, Stryker 10.
  TypeScript stops at 6.0 because typescript-eslint supports nothing newer
  yet.

### Breaking

- **A tenant from Embedded Signup starts unsubscribed.** Subscribing your app
  to the customer's WABA is a step of its own with Meta, and an integration
  that forgets it receives nothing in production. Call
  `POST /{waba_id}/subscribed_apps` as your code does in production, or pass
  `subscribed: true` to `/__mock/embedded-signup` / `engine.createSignup()`
  for a test that is not about subscription. (Before, it was subscribed unless
  you passed `subscribed: false`.)
- **Media is uploaded as `multipart/form-data`**, with the file. A JSON upload
  carries no file and fails, as with Meta. Media ids live 30 days and the URL
  from `GET /{media_id}` lives 5 minutes, where before the id itself expired
  after 5 minutes. `sha256` is base64.
- **A media id sent in a message must exist.** One nobody uploaded fails with
  131009.
- **Every non-template message needs an open window**, media and location
  included.
- **A wamock-issued token is checked for permission and ownership on every
  Graph route.** A token without `whatsapp_business_messaging` can no longer
  send, and a business token can no longer reach another customer.
- **A webhook your receiver rejected comes back.** Throwing in `onWebhook`, or
  answering anything but 200, used to leave a failed entry in the log and
  nothing more. Now it is retried, as Meta retries it: a minute later, then at
  doubling intervals for 7 days of virtual time. A test that advances the
  clock (say 24h, to expire the window) receives those webhooks again, so a
  handler that is not idempotent shows duplicates it did not before. That is
  the production behaviour; make the handler idempotent, or have it answer
  200.
- **Only a 200 counts, and an unverified URL receives nothing** over HTTP.
- **Template sends must match the template's parameters** (132000), once the
  template declares its components. A placeholder is written as Meta writes
  it, `{{1}}` or `{{first_name}}`: `{{ 1 }}` with spaces is text, not a
  parameter.
- **`biz_opaque_callback_data` that is not a string, or longer than 512
  characters, fails the send with (#100).** It used to be dropped silently, so
  the statuses lacked what the app expected echoed.
- `GET /{phone_number_id}` without `fields` answers Meta's four default fields
  (`id`, `display_phone_number`, `verified_name`, `quality_rating`), not every
  field wamock knows.
- `GET /{waba_id}/phone_numbers` includes `paging`.
- **A forced status takes an `error` code only with `failed`.** `POST
  /__mock/statuses` with `{status: "read", error: …}` used to send a `read`
  webhook carrying `errors`, which Meta never sends; it is now refused. And
  `failed` needs its `error`, since every failed status Meta sends carries
  one.
- `GET /{waba_id}/message_templates` answers 25 templates a page; follow
  `paging.next` for the rest, as production requires.
- `metadata.display_phone_number` on every webhook (`messages`, statuses,
  `user_preferences`, coexistence) is digits only. A receiver that strips the
  `+` keeps working. One that compares it as-is to `+…` stops matching, and it
  stops matching in production too.
- `GET /{phone_number_id}?fields=display_phone_number` answers in Meta's
  formatted style (`+1 555-000-1111`).

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
