// B104: the Markdown link-title scan is linear per link attempt, so a Markdown preview or conversion
// is bounded by the work budget. A reader holding only campaigns:get must not hold up the server:
// a GET sent while a preview renders must answer within a second of being sent.
import { afterEach, expect, test } from "bun:test";
import { campaignsFixture, type CampaignsFixture } from "@/test/campaigns/fixture";
import { previewForm, readerSession, repeat } from "@/test/campaigns/markdown-support";

const fixtures: CampaignsFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await campaignsFixture();
  fixtures.push(f);
  return f;
}

/** A Markdown preview through the router, as the editor posts it. */
function previewRequest(
  f: CampaignsFixture,
  id: number,
  headers: Record<string, string>,
  body: string,
) {
  return f.request(`/api/campaigns/${id}/preview`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: previewForm(body),
  });
}

test("a GET sent while an 8 KiB preview renders answers within a second of being sent", async () => {
  const child = Bun.spawn(
    [process.execPath, new URL("./markdown-serve.ts", import.meta.url).pathname],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const ready = JSON.parse(await firstLine(child.stdout)) as {
      origin: string;
      campaign: number;
      headers: Record<string, string>;
    };
    const previewing = fetch(`${ready.origin}/api/campaigns/${ready.campaign}/preview`, {
      method: "POST",
      headers: { ...ready.headers, "content-type": "application/x-www-form-urlencoded" },
      body: previewForm(repeat("[](", 8192)),
    });
    // The preview is rendering (or about to) when this read is sent.
    await Bun.sleep(5);
    const sentAt = performance.now();
    const read = await fetch(`${ready.origin}/api/campaigns/${ready.campaign}`, {
      headers: ready.headers,
    });
    const readMs = performance.now() - sentAt;
    await read.text();
    const previewed = await previewing;
    expect(previewed.status).toBe(400);
    expect(read.status).toBe(200);
    expect(readMs).toBeLessThan(1000);
  } finally {
    child.kill();
    await child.exited;
  }
}, 120_000);

// One pathological family per link, image, reference, title and emphasis shape that marked scans.
const families: Record<string, string> = {
  "empty link": "[](",
  destination: "[x](y",
  "spaced destination": "[x]( ",
  "glued quote": '[x](y"',
  "glued paren": "[x](y(",
  "title opener": '[x](y "',
  image: "![](",
  reference: "[x][",
  autolink: "<a ",
  "emphasis pairs": "*a ",
  "code span": "`a ",
};

test.each(Object.entries(families))(
  "a 64 KiB Markdown preview of %s answers within a second",
  async (_, unit) => {
    const f = await open();
    const news = await f.list("news");
    const campaign = await f.campaign({ name: "md", subject: "s", lists: [news] });
    const headers = await readerSession(
      f,
      "family-reader",
      ["campaigns:get"],
      [{ id: news, permissions: ["list:get"] }],
    );
    const started = performance.now();
    const response = await previewRequest(f, campaign.id, headers, repeat(unit, 64 * 1024));
    await response.text();
    expect(performance.now() - started).toBeLessThan(1000);
    expect([200, 400]).toContain(response.status);
  },
);

test("a 64 KiB content conversion of link openers is refused within a second", async () => {
  const f = await open();
  const news = await f.list("news");
  const campaign = await f.campaign({ name: "md", subject: "s", lists: [news] });
  const headers = await readerSession(
    f,
    "convert-manager",
    ["campaigns:get", "campaigns:manage"],
    [{ id: news, permissions: ["list:get", "list:manage"] }],
  );
  const started = performance.now();
  const response = await f.request(`/api/campaigns/${campaign.id}/content`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ body: repeat("[](", 64 * 1024), from: "markdown", to: "html" }),
  });
  await response.text();
  expect(performance.now() - started).toBeLessThan(1000);
  expect([200, 400]).toContain(response.status);
});

// D111: a link title must follow whitespace. A title glued to its destination is the destination
// unless it sits after whitespace, so a glued title containing whitespace is no longer a title.
test("a title glued to its destination with whitespace inside is text, not a title (D111)", async () => {
  const f = await open();
  const news = await f.list("news");
  const campaign = await f.campaign({ name: "md", subject: "s", lists: [news] });
  const headers = await readerSession(
    f,
    "title-reader",
    ["campaigns:get"],
    [{ id: news, permissions: ["list:get"] }],
  );
  for (const body of ['[x](u"a b")', '[x](<u>"t")', "[x](u(a b))"]) {
    const html = await (await previewRequest(f, campaign.id, headers, body)).text();
    expect(html).not.toContain(">x</a>");
  }
  const quoted = await (await previewRequest(f, campaign.id, headers, '[x](u"a b")')).text();
  expect(quoted).toContain("[x](u&quot;a b&quot;)");
  const angled = await (await previewRequest(f, campaign.id, headers, '[x](<u>"t")')).text();
  expect(angled).toContain("[x](<u>&quot;t&quot;)");
});

test("a glued title without whitespace stays part of the URL, as before (D111)", async () => {
  const f = await open();
  const news = await f.list("news");
  const campaign = await f.campaign({ name: "md", subject: "s", lists: [news] });
  const headers = await readerSession(
    f,
    "glued-reader",
    ["campaigns:get"],
    [{ id: news, permissions: ["list:get"] }],
  );
  const html = await (
    await previewRequest(f, campaign.id, headers, '[x](https://example.com/a"Titled")')
  ).text();
  expect(html).toContain('<a href="https://example.com/a%22Titled%22">x</a>');
});

test("a normal link title after a space or a newline still applies", async () => {
  const f = await open();
  const news = await f.list("news");
  const campaign = await f.campaign({ name: "md", subject: "s", lists: [news] });
  const headers = await readerSession(
    f,
    "title-reader-2",
    ["campaigns:get"],
    [{ id: news, permissions: ["list:get"] }],
  );
  const spaced = await (
    await previewRequest(f, campaign.id, headers, '[x](https://example.com/a "Titled")')
  ).text();
  expect(spaced).toContain('<a href="https://example.com/a" title="Titled">x</a>');
  const nextLine = await (
    await previewRequest(f, campaign.id, headers, '[x](https://example.com/a\n"Titled")')
  ).text();
  expect(nextLine).toContain('<a href="https://example.com/a" title="Titled">x</a>');
});

/** The first line the child writes to stdout. */
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("served fixture exited before it was ready");
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text.slice(0, text.indexOf("\n"));
}
