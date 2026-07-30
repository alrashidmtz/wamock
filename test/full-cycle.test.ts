import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WamockEngine } from "../src/core/engine.js";
import { createServer } from "../src/server.js";
import { verifySignature } from "../src/webhooks/signature.js";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

/**
 * Spec §13.3 — the acceptance criterion for v1, end to end, with no network:
 *
 *   inbound → app replies → statuses → window expires → free-form text is
 *   refused with 131047 → an approved template gets through.
 *
 * If this test passes, the mock does the thing it exists to do. Everything
 * else is detail.
 */

const EPOCH = 1_750_000_000_000;
const HOUR = 60 * 60 * 1000;
const SECRET = "app-secret";
const CUSTOMER = "5215555000001";

let engine: WamockEngine;
let app: FastifyInstance;
/** What the integration under test would have received. */
let inbox: Array<{ body: string; signature: string | undefined }>;

beforeEach(async () => {
  inbox = [];
  engine = new WamockEngine({
    appSecret: SECRET,
    mode: "frozen",
    start: EPOCH,
    transport: async (d) => {
      inbox.push({ body: d.body, signature: d.signature });
    },
  });
  app = createServer(engine);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const post = async (
  url: string,
  payload: unknown,
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });

const advance = async (ms: number) => {
  await post("/__mock/time/advance", { ms });
  await engine.settle();
};

/** Parse a delivered webhook the way the integration would. */
const valueOf = (raw: { body: string }) =>
  JSON.parse(raw.body).entry[0].changes[0].value;

describe("the full lifecycle, with no network", () => {
  it("walks inbound → reply → statuses → expiry → 131047 → template → OK", async () => {
    const pnid = engine.state.defaultPhoneNumberId;
    const waba = engine.state.defaultWabaId;

    // 1. A template is submitted and approved ahead of time — the escape hatch
    //    for later, once the window has closed.
    await post(`/v19.0/${waba}/message_templates`, {
      name: "order_update",
      language: "es_MX",
      category: "UTILITY",
      components: [
        { type: "BODY", text: "Hola {{1}}, tu pedido va en camino." },
      ],
    });
    await post("/__mock/templates/order_update/es_MX/transition", {
      to: "APPROVED",
    });

    // 2. The customer writes. This is what opens the 24h window.
    await post("/__mock/inbound", {
      from: CUSTOMER,
      text: "hola",
      name: "Ana",
    });
    await advance(0);

    // Select by content, not by index: the approval in step 1 emits its own
    // `message_template_status_update` webhook, and asserting on inbox[0]
    // would silently depend on delivery order.
    const inboundDelivery = inbox.find((raw) => valueOf(raw).messages)!;
    expect(
      verifySignature({
        appSecret: SECRET,
        body: inboundDelivery.body,
        header: inboundDelivery.signature,
      }),
    ).toBe(true);
    expect(valueOf(inboundDelivery).messages[0].from).toBe(CUSTOMER);
    expect(valueOf(inboundDelivery).messages[0].from).not.toContain("+");

    // 3. The app replies with free-form text. Allowed: the window is open.
    inbox.length = 0;
    const reply = await post(`/v19.0/${pnid}/messages`, {
      messaging_product: "whatsapp",
      to: CUSTOMER,
      type: "text",
      text: { body: "Gracias Ana, lo reviso." },
    });
    expect(reply.statusCode).toBe(200);
    const replyWamid = reply.json().messages[0].id;

    // 4. Delivery statuses come back, each in a webhook with no `messages` key.
    await advance(60_000);
    const statuses = inbox.map(valueOf).filter((v) => v.statuses);
    expect(statuses.map((v) => v.statuses[0].status)).toEqual([
      "sent",
      "delivered",
    ]);
    expect(statuses[0].statuses[0].id).toBe(replyWamid);
    expect(statuses.every((v) => !("messages" in v))).toBe(true);

    // 5. A day goes by. The window closes.
    await advance(25 * HOUR);

    // 6. Free-form text is now refused — permanently, with 131047.
    const refused = await post(`/v19.0/${pnid}/messages`, {
      messaging_product: "whatsapp",
      to: CUSTOMER,
      type: "text",
      text: { body: "¿sigues ahí?" },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe(131047);

    // 7. The approved template gets through, which is the entire point of
    //    templates and the reason 131047 is not worth retrying.
    const templated = await post(`/v19.0/${pnid}/messages`, {
      messaging_product: "whatsapp",
      to: CUSTOMER,
      type: "template",
      template: {
        name: "order_update",
        language: { code: "es_MX" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "Ana" }] },
        ],
      },
    });
    expect(templated.statusCode).toBe(200);
    expect(templated.json().messages[0].id).toMatch(/^wamid\./);
  });

  it("refuses the same template in a language that was never approved", async () => {
    // The per-language trap, end to end: es_MX is live, en_US is not, and
    // nothing about the es_MX approval hints at that.
    const pnid = engine.state.defaultPhoneNumberId;
    const waba = engine.state.defaultWabaId;

    await post(`/v19.0/${waba}/message_templates`, {
      name: "order_update",
      language: "es_MX",
      category: "UTILITY",
      components: [],
    });
    await post("/__mock/templates/order_update/es_MX/transition", {
      to: "APPROVED",
    });

    const res = await post(`/v19.0/${pnid}/messages`, {
      messaging_product: "whatsapp",
      to: CUSTOMER,
      type: "template",
      template: {
        name: "order_update",
        language: { code: "en_US" },
        components: [],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(132001);
  });

  it("replays identically after a reset", async () => {
    // Determinism is a feature: the same script produces the same wamids, so
    // assertions on ids do not rot between runs.
    const pnid = engine.state.defaultPhoneNumberId;

    const run = async () => {
      await post("/__mock/inbound", { from: CUSTOMER, text: "hola" });
      const res = await post(`/v19.0/${pnid}/messages`, {
        messaging_product: "whatsapp",
        to: CUSTOMER,
        type: "text",
        text: { body: "hi" },
      });
      return res.json().messages[0].id as string;
    };

    const first = await run();
    await post("/__mock/reset", {});
    const second = await run();

    expect(second).toBe(first);
  });
});
