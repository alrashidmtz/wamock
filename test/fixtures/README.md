# Fixtures

These are **sanitized** WhatsApp Cloud API payload shapes: no tokens, no real phone
numbers, no customer data. They encode the *shape and behavior* Meta actually
produces, as observed in two production integrations and checked against Meta's
current reference. They are the contract wamock is tested against, so a value
in them needs a source: captured traffic or Meta's own example, never a guess.

Everything here is a rewritten synthetic sample. Identifiers follow a fixed
convention so tests read consistently:

| Placeholder | Meaning |
|---|---|
| `5215555000001` | a customer's WhatsApp number — **digits only, no `+`** |
| `15550001111` | a business `display_phone_number` in a webhook — **digits only too**; the Graph API formats the same number as `+1 555-000-1111` |
| `PNID_1` | a `phone_number_id` (a Graph object id, not a phone number) |
| `WABA_1` | a WhatsApp Business Account id |
| `wamid.TEST1` | a message id |
| `MX.13491208655302741918` | a business-scoped user ID (BSUID): country code, a period, digits |

## Why the number format matters

Webhooks carry every number as digits only: the customer's `wa_id`, `from` and
`recipient_id`, and the business's own `metadata.display_phone_number`. The Graph
API formats the business number instead (`+1 555-000-1111`). An integration
that stores the Graph form and matches webhooks against it has two keys for one
number.

Until 0.5.0 these fixtures, and wamock, carried a `+` on the webhook's business
number. That came from a hand-written test fixture, not captured traffic.
Meta's examples and public captures say digits only.

## Files

| File | What it captures |
|---|---|
| `inbound-text.json` | a customer sends a plain text message |
| `inbound-interactive-reply.json` | a customer taps a reply button / picks a list row |
| `statuses-only.json` | a delivery receipt webhook with **no `messages` key at all** |
| `status-failed.json` | a failed status carrying `errors[]` with a Meta error code |
| `send-text-response.json` | the success body of `POST /{phone_number_id}/messages` |
| `error-*.json` | Graph error bodies for the codes in spec §7 |

## Note on `pricing`

Neither audited integration consumed the `pricing` object that Meta attaches to
one status per message, so `statuses-only.json` is **modeled from Meta's status
webhook reference rather than captured from traffic**. It follows per-message
pricing (`pricing_model: "PMP"`, in force since 2025-07-01). The `conversation`
object is absent on purpose: v24.0 omits it outside free entry point windows.

## These files are executed

`test/fixtures-contract.test.ts` rebuilds every fixture from the real builders
and requires an exact match. Changing a fixture changes what wamock claims Meta
sends, so the builder has to change with it.
