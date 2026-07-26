# Fixtures

These are **sanitized** WhatsApp Cloud API payload shapes: no tokens, no real phone
numbers, no customer data. They encode the *shape and behavior* Meta actually
produces, observed across two production integrations, and they are the contract
wamock is tested against.

Everything here is a rewritten synthetic sample. Identifiers follow a fixed
convention so tests read consistently:

| Placeholder | Meaning |
|---|---|
| `5215555000001` | a customer's WhatsApp number — **digits only, no `+`** |
| `+15550001111` | a business `display_phone_number` — Meta *does* include `+` here |
| `PNID_1` | a `phone_number_id` (a Graph object id, not a phone number) |
| `WABA_1` | a WhatsApp Business Account id |
| `wamid.TEST1` | a message id |

## Why the `+` asymmetry matters

Meta sends customer numbers **without** a leading `+` in `contacts[].wa_id`,
`messages[].from` and `statuses[].recipient_id` — but **with** `+` in
`metadata.display_phone_number`. Integrations that normalize one and not the
other end up with two different keys for the same person, which breaks opt-out
lookups, session keys and dedupe. wamock reproduces this asymmetry deliberately.

## Files

| File | What it captures |
|---|---|
| `inbound-text.json` | a customer sends a plain text message |
| `inbound-interactive-reply.json` | a customer taps a reply button / picks a list row |
| `statuses-only.json` | a delivery receipt webhook with **no `messages` key at all** |
| `status-failed.json` | a failed status carrying `errors[]` with a Meta error code |
| `send-text-response.json` | the success body of `POST /{phone_number_id}/messages` |
| `error-*.json` | Graph error bodies for the codes in spec §7 |

## Note on `conversation` / `pricing`

Neither audited integration consumed the `conversation`/`pricing` objects that
Meta attaches to `sent`/`delivered` statuses, so those fields are **modeled from
Meta's public documentation rather than captured from traffic**. They are
faithful in shape and field names; treat exact pricing category semantics as
best-effort until corrected against a real capture.
