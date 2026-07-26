# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[semver](https://semver.org/).

## [Unreleased]

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

### Not yet verified

- **Dogfood against a third-party integration test suite.** The acceptance
  criterion of running an existing production integration's tests against
  wamock unchanged (only swapping the Graph base URL) has not been exercised
  yet. Until it has, treat "drop-in replacement" as a design goal rather than a
  demonstrated fact.
