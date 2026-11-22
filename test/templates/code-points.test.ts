// `slice`, `truncate` count characters as code points (B135 lead item 4, D23): a character outside the
// Basic Multilingual Plane is one character, and a cut never splits its surrogate pair. Observed through
// POST /api/tx into the loopback SMTP sink. `size` keeps JavaScript's length (a documented exception).
import { afterEach, expect, test } from "bun:test";
import { txFixture } from "@/test/tx/fixture";
import type { JsonObject } from "@/test/json-object";
import type { TxFixture } from "@/test/tx/fixture";
import { asBody } from "@/test/read-body";
import { htmlPart, textPart } from "@/test/messaging/mime";

const fixtures: Array<TxFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function open() {
  const f = await txFixture();
  fixtures.push(f);
  return f;
}

/** Send `body` to a fresh address; the text and HTML parts are decoded from their transfer encoding. */
async function render(f: TxFixture, body: string, data: JsonObject = {}) {
  const template = await f.template(`<p>${body}</p>`);
  const email = `c-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const response = await f.tx({ subscriber_emails: [email], template_id: template, data });
  const row = response.body?.data?.sends?.[0];
  const raw = f.mailTo(email)[0]?.data ?? "";
  const message = [textPart(raw), htmlPart(raw)].join("\n");
  return { http: response.status, status: asBody<string | undefined>(row?.status), message };
}

test("slice takes whole characters, from the front or the end", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ 'a😀b' | slice: 1 }}] [{{ 'a😀b' | slice: 1, 2 }}] [{{ 'a😀b' | slice: -2, 2 }}] " +
      "[{{ '😀😀' | slice: 0, 1 }}]",
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[😀] [😀b] [😀b] [😀]");
});

test("truncate counts characters, so the cut never splits a surrogate pair", async () => {
  const f = await open();
  // Four characters, limit 3 with a one-character ellipsis: two characters and the ellipsis.
  const sent = await render(f, "[{{ '😀😀😀😀' | truncate: 3, '…' }}]");
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[😀😀…]");
});

test("truncate leaves a text of the limit's characters unchanged, and size stays in code units", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ '😀😀' | truncate: 2 }}] [{{ '😀😀' | size }}] [{{ 'héllo' | truncate: 10 }}]",
  );
  expect(sent.status).toBe("sent");
  // Two characters fit exactly; `size` is JavaScript's length, two per emoji (documented in 06).
  expect(sent.message).toContain("[😀😀] [4] [héllo]");
});
