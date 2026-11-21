// B120 (D118): an HTML message without an explicit alt body is sent as multipart/alternative with a
// generated text/plain part. Read through the HTTP API and the loopback SMTP sink only.
import { afterEach, expect, test } from "bun:test";
import { campaignsFixture } from "@/test/campaigns/fixture";
import { htmlPart, parseMail, textPart } from "@/test/messaging/mime";
import { schedulerFixture } from "@/test/scheduler/fixture";
import { txFixture } from "@/test/tx/fixture";

const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function tx() {
  const f = await txFixture();
  fixtures.push(f);
  return f;
}
async function scheduler() {
  const f = await schedulerFixture();
  fixtures.push(f);
  return f;
}
async function campaigns() {
  const f = await campaignsFixture();
  fixtures.push(f);
  return f;
}

// The preheader shape a newsletter uses: hidden text, then invisible padding (U+034F, ZWNJ, NBSP).
const PADDING = "&#847;&zwnj;&nbsp;".repeat(90);
const PREHEADER = `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Buy a pack only when you need an export.${PADDING}</div>`;
const BODY = `<h1>Your export is ready</h1><p>Hello {{ subscriber.first_name }}, <a href="https://shop.example.test/packs?ref=7">open the pack shop</a> for more.</p>`;
const INVISIBLE = /[͏​-‍﻿  ­]/;

/** The first text/plain line is the visible body; the hidden preheader and padding are absent. */
function expectPreheaderGone(data: string) {
  const text = textPart(data);
  expect(text).toBeDefined();
  expect(text!.split("\n")[0]).toBe("Your export is ready");
  expect(text).not.toMatch(INVISIBLE);
  expect(text).not.toContain("Buy a pack");
  return text!;
}

test("a sequence step mail with the adopter's preheader is multipart/alternative with clean text", async () => {
  const f = await scheduler();
  const template = await f.template(`${PREHEADER}${BODY}`, "Export ready");
  const sequence = await f.sequence({
    steps: [{ wait: "PT0S", kind: "transactional", template_id: template }],
  });
  const subscriberId = await f.subscriber("ada@example.test");
  const enrolled = await f.json("/api/enrollments", "POST", {
    sequence_id: sequence.id,
    subscriber_id: subscriberId,
  });
  expect(enrolled.status).toBe(200);
  await f.pass(0);
  await f.until(() => f.sink.messages.length === 1, "the step mail");
  const data = f.sink.messages[0]!.data;
  expect(parseMail(data).top.type).toBe("multipart/alternative");
  const text = expectPreheaderGone(data);
  expect(text).toMatch(
    /^Your export is ready\n\nHello[^\n]*, open the pack shop <https:\/\/shop\.example\.test\/packs\?ref=7> for more\.$/,
  );
  // The text part names the link exactly as the HTML part does, tracked or not.
  const href = /href="([^"]+)"/.exec(htmlPart(data)!)![1]!.replaceAll("&amp;", "&");
  expect(text).toContain(`<${href}>`);
});

test("a transactional send without altbody is multipart/alternative with generated text", async () => {
  const f = await tx();
  const template = await f.template(`${PREHEADER}${BODY}`, "Export ready");
  const id = await f.subscriber("ada@example.test", "Ada Lovelace");
  const response = await f.tx({ subscriber_id: id, template_id: template });
  expect(response.status).toBe(200);
  expect(f.sink.messages).toHaveLength(1);
  const data = f.sink.messages[0]!.data;
  expect(parseMail(data).top.type).toBe("multipart/alternative");
  expectPreheaderGone(data);
  expect(htmlPart(data)).toContain("Buy a pack only when you need an export.");
});

test("an explicit altbody on a transactional send is the text part, unchanged", async () => {
  const f = await tx();
  const template = await f.template(`${PREHEADER}${BODY}`, "Export ready");
  const id = await f.subscriber("ada@example.test", "Ada Lovelace");
  const altbody = "Exact words, kept as given.\n\nSecond line stays put.";
  const response = await f.tx({ subscriber_id: id, template_id: template, altbody });
  expect(response.status).toBe(200);
  const data = f.sink.messages[0]!.data;
  expect(parseMail(data).top.type).toBe("multipart/alternative");
  expect(textPart(data)).toBe(altbody);
});

test("a campaign test send without altbody is multipart/alternative with generated text", async () => {
  const f = await campaigns();
  const list = (
    await f.json("/api/lists", "POST", { name: "News", type: "public", optin: "single" })
  ).body.data.id as number;
  await f.subscriber("ada@example.test", [list]);
  const campaign = await f.campaign({
    name: "Weekly",
    subject: "Export",
    lists: [list],
    body: `${PREHEADER}${BODY}`,
    content_type: "html",
  });
  const sent = await f.json(`/api/campaigns/${campaign.id}/test`, "POST", {
    name: "Weekly",
    subject: "Export",
    lists: [list],
    messenger: "email",
    content_type: "html",
    body: `${PREHEADER}${BODY}`,
    subscribers: ["ada@example.test"],
  });
  expect(sent.status).toBe(200);
  const [message] = await f.mail(1);
  expect(message).toBeDefined();
  expect(parseMail(message!.data).top.type).toBe("multipart/alternative");
  expectPreheaderGone(message!.data);
});

test("an explicit campaign altbody is the text part, unchanged", async () => {
  const f = await campaigns();
  const list = (
    await f.json("/api/lists", "POST", { name: "News", type: "public", optin: "single" })
  ).body.data.id as number;
  await f.subscriber("ada@example.test", [list]);
  const altbody = "Campaign text, as the editor wrote it.";
  const sent = await f.json(
    `/api/campaigns/${(await f.campaign({ name: "Weekly", subject: "Export", lists: [list], body: BODY, content_type: "html", altbody })).id}/test`,
    "POST",
    {
      name: "Weekly",
      subject: "Export",
      lists: [list],
      messenger: "email",
      content_type: "html",
      body: BODY,
      altbody,
      subscribers: ["ada@example.test"],
    },
  );
  expect(sent.status).toBe(200);
  const [message] = await f.mail(1);
  expect(textPart(message!.data)).toBe(altbody);
});

test("a link is written as its text and its URL, and a URL that is its own text appears once", async () => {
  const f = await tx();
  const template = await f.template(
    '<p><a href="https://example.test/guide">the guide</a> and <a href="https://example.test/home">https://example.test/home</a></p>',
    "Links",
  );
  const id = await f.subscriber("ada@example.test", "Ada Lovelace");
  expect((await f.tx({ subscriber_id: id, template_id: template })).status).toBe(200);
  // The second link's text is its URL, so the URL is written once and nothing is appended.
  expect(textPart(f.sink.messages[0]!.data)).toBe(
    "the guide <https://example.test/guide> and <https://example.test/home>",
  );
});

test("a hidden span inside a paragraph is dropped and the words on either side join with one space", async () => {
  const f = await tx();
  const template = await f.template(
    '<p>Visible <span style="DISPLAY : NONE">secret words</span>text here</p><img style="display:none" src="https://example.test/p.png"><p>Next</p>',
    "Spans",
  );
  const id = await f.subscriber("ada@example.test", "Ada Lovelace");
  expect((await f.tx({ subscriber_id: id, template_id: template })).status).toBe(200);
  const text = textPart(f.sink.messages[0]!.data)!;
  expect(text).not.toContain("secret");
  expect(text).toMatch(/^Visible text here\n\n?Next$/);
});

test("references decode once, invisible characters go, lists and cells keep their shape, skipped and hidden content is dropped", async () => {
  const f = await tx();
  const template = await f.template(
    "<title>Hidden title</title><style>p{color:red}</style><script>var x=1</script><!-- hidden comment -->" +
      "<p>Tom&amp;Jerry &amp;nbsp; &#8364;5 &eacute;t&eacute; &unknown; a&nbsp;&nbsp;b wo&shy;rd</p>" +
      '<div style="visibility:hidden">no one</div><div style="mso-hide:all">no two</div>' +
      '<div style="max-height:0px; overflow:hidden">no three</div><div style="DISPLAY:NONE !important">no four</div>' +
      "<ul><li>one</li><li>two</li></ul><table><tr><td>c1</td><td>c2</td></tr></table>",
    "Shapes",
  );
  const id = await f.subscriber("ada@example.test", "Ada Lovelace");
  expect((await f.tx({ subscriber_id: id, template_id: template })).status).toBe(200);
  const data = f.sink.messages[0]!.data;
  expect(textPart(data)).toBe(
    "Tom&Jerry &nbsp; €5 été &unknown; a b word\n\n- one\n- two\n\nc1 c2",
  );
  for (const hidden of [
    "Hidden title",
    "color",
    "var x",
    "hidden comment",
    "no one",
    "no two",
    "no three",
    "no four",
  ])
    expect(textPart(data)).not.toContain(hidden);
});

test("a large realistic newsletter converts to a text part no longer than its HTML", async () => {
  const f = await tx();
  // Template bodies are capped at 64 KiB (templates/store.ts), so the newsletter is near that cap.
  const blocks = Array.from(
    { length: 300 },
    (_, n) =>
      `<tr><td style="padding:8px">Story ${n} with <a href="https://example.test/n/${n}">read more ${n}</a>&nbsp;&nbsp;today &amp; tomorrow</td></tr>`,
  ).join("");
  const html = `${PREHEADER}<table>${blocks}</table>`;
  expect(Buffer.byteLength(html)).toBeLessThanOrEqual(64 * 1024);
  const template = await f.template(html, "Big");
  const id = await f.subscriber("ada@example.test", "Ada Lovelace");
  expect((await f.tx({ subscriber_id: id, template_id: template })).status).toBe(200);
  const data = f.sink.messages[0]!.data;
  const text = textPart(data)!;
  expect(text.split("\n")[0]).toMatch(
    /^Story 0 with read more 0 <https?:\/\/[^\s<>]+> today & tomorrow$/,
  );
  expect(text).not.toMatch(INVISIBLE);
  expect(text.length).toBeLessThan(htmlPart(data)!.length);
});
