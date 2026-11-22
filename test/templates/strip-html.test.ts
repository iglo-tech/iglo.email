// `strip_html` removes tags and then decodes character references (B135 lead item 5, D134), so the
// output is escaped once: `&amp;` in the source shows as `&`, and `&lt;b&gt;` shows as the text `<b>`.
// Observed through POST /api/tx into the loopback SMTP sink.
import { afterEach, expect, test } from "bun:test";
import { htmlPart } from "@/test/messaging/mime";
import { txFixture } from "@/test/tx/fixture";
import type { JsonObject } from "@/test/json-object";
import type { TxFixture } from "@/test/tx/fixture";

const fixtures: Array<TxFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});

/** Send `body` to a fresh address and return the HTML part as a reader receives it. */
async function html(body: string, data: JsonObject = {}) {
  const f = await txFixture();
  fixtures.push(f);
  const template = await f.template(`<p>${body}</p>`);
  const email = `s-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const response = await f.tx({ subscriber_emails: [email], template_id: template, data });
  expect(response.status).toBe(200);
  return htmlPart(f.mailTo(email)[0]?.data ?? "") ?? "";
}

test("strip_html decodes references after the tags go, and the output is escaped once", async () => {
  expect(await html("{{ '<p>Fish &amp; chips &lt;b&gt;</p>' | strip_html }}")).toContain(
    "Fish &amp; chips &lt;b&gt;",
  );
  // The `&lt;` is text: it is not a tag, so it survives stripping and shows as `<b>`.
  expect(await html("{{ '&lt;b&gt;bold&lt;/b&gt;' | strip_html }}")).toContain(
    "&lt;b&gt;bold&lt;/b&gt;",
  );
});

test("strip_html decodes the named references of the HTML spec", async () => {
  expect(await html("{{ '<b>bold</b> &copy; &fnof;&hellip;' | strip_html }}")).toContain(
    "bold © ƒ…",
  );
});

test("strip_html keeps the text of a stripped element out of the output", async () => {
  expect(
    await html("{{ '<script>var x = 1;</script><style>p{}</style>keep &amp; go' | strip_html }}"),
  ).toContain("keep &amp; go");
});
