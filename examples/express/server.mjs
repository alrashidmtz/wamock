/**
 * A webhook receiver that does the three things a real one must, and that a
 * lenient mock lets you get wrong:
 *
 *   1. Verify the signature over the RAW body, not a re-serialized object.
 *   2. Echo hub.challenge on the verification GET.
 *   3. Tolerate webhooks that carry statuses and NO `messages` key.
 *
 * Run:
 *   node examples/express/server.mjs
 *   npx wamock start --app-secret shhh --webhook-url http://localhost:3000/webhook
 *   curl -X POST localhost:4004/__mock/inbound \
 *     -H 'content-type: application/json' -d '{"from":"5215555000001","text":"hola"}'
 */
import express from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'

const APP_SECRET = process.env.WA_APP_SECRET ?? 'shhh'
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN ?? 'wamock-verify-token'
const GRAPH_BASE = process.env.GRAPH_API_BASE_URL ?? 'http://localhost:4004'
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'PNID_DEFAULT'

const app = express()

// Keep the raw bytes. `express.json()` alone gives you a parsed object, and
// signing a re-serialized copy of it is the classic way to ship a receiver
// whose signature check passes only by luck.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }))

function signatureIsValid(req) {
  const header = req.get('x-hub-signature-256') ?? ''
  const expected = 'sha256=' + createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex')
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Meta issues this GET when you register the URL and requires the challenge
// echoed back verbatim. Answering "ok" looks healthy and receives nothing.
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.type('text/plain').send(req.query['hub.challenge'])
  }
  res.sendStatus(403)
})

app.post('/webhook', async (req, res) => {
  if (!signatureIsValid(req)) return res.sendStatus(401)

  // Always ACK first. A slow handler makes Meta retry, and its retries
  // escalate to disabling your webhook.
  res.sendStatus(200)

  for (const entry of req.body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {}

      // Delivery receipts arrive WITHOUT a `messages` key — not an empty
      // array. `value.messages.forEach(...)` would crash on every one.
      for (const status of value.statuses ?? []) {
        console.log(
          `status ${status.id} → ${status.status}` +
            (status.pricing ? ` (${status.pricing.category} conversation)` : ''),
        )
      }

      for (const message of value.messages ?? []) {
        // `from` has NO leading '+'. Whatever you do with it, do the same
        // everywhere, or you will end up with two keys for one person.
        console.log(`inbound from ${message.from}: ${message.text?.body}`)
        await reply(message.from, `You said: ${message.text?.body}`)
      }
    }
  }
})

async function reply(to, text) {
  const response = await fetch(`${GRAPH_BASE}/v19.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  })

  if (!response.ok) {
    const { error } = await response.json()
    // 131047 is permanent: retrying cannot help, you need a template.
    console.error(`send failed (${error.code}): ${error.message}`)
    return
  }
  console.log('sent', (await response.json()).messages[0].id)
}

app.listen(3000, () => console.log('receiver listening on http://localhost:3000/webhook'))
