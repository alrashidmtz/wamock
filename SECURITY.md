# Security

## What wamock is

A development and CI tool. It emulates an API; it is **not** hardened
infrastructure and is not meant to face a network.

The `/__mock` control API has **no authentication** by design — needing a token
to say "the customer replied" would make the tool worse at its job. Everything
below follows from that.

## Threat model

wamock assumes it is reachable only by you and by the code under test.

Anyone who can reach the port can:

- read `GET /__mock/messages` — every message the app under test sent,
  recipient numbers and bodies included
- read `GET /__mock/state` — the tenant graph and current virtual time
  (app secrets are deliberately excluded)
- `POST /__mock/inbound` — inject forged customer messages into the app
- `POST /__mock/scenario` — change how the mock behaves under it

That is the intended power of the tool, and the reason it binds loopback.

## Defaults that protect you

| | |
|---|---|
| **Binds `127.0.0.1`** | `--host 0.0.0.0` is an explicit opt-in and prints a warning. The Docker image passes it because the container boundary limits reach. |
| **App secret is generated** | No fixed default, so signatures are not forgeable by anyone who read the source. |
| **Secrets stay out of `/__mock/state`** | The endpoint is meant to be curl-ed and pasted into bug reports. |
| **Outbound HTTP is bounded** | Webhook delivery and the startup handshake time out, so a hung receiver cannot wedge the mock. |
| **Retained history is capped** | Bounded memory, with the dropped count reported rather than truncating silently. |

## Please don't

- Run it on a shared network, or expose it through a tunnel or reverse proxy.
- Point it at production data. It holds everything in memory, in the clear, and
  serves it over an unauthenticated endpoint.
- Use it as a stand-in for WhatsApp in anything that is not a test.

## Reporting a vulnerability

Open a **private security advisory** through GitHub's *Security* tab rather
than a public issue, and give us a chance to fix it before disclosure.

Most valuable: anything that lets a webhook be accepted with an invalid
signature, or that lets the mock reach outside its process in a way its
configuration did not ask for.
