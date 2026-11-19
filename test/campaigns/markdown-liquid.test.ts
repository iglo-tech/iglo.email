// B105 (D112). A body is at most 64 KiB, but a Liquid loop can expand it. The Markdown source after
// expansion is capped at 128 KiB (r2): each shape below, expanded to 128 KiB as a preview, renders or is
// refused within a second; the same shapes expanded to 1000 KiB are refused at once by the cap, with its
// message; and a read sent after five concurrent previews is not delayed by more than a second.
import { afterEach, expect, test } from "bun:test";
import { campaignsFixture, type CampaignsFixture } from "@/test/campaigns/fixture";
import { previewForm, readerSession } from "@/test/campaigns/markdown-support";

const CAP_MESSAGE = "Markdown is larger than 128 KiB after template expansion";

const fixtures: CampaignsFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

/** A loop of `kib` iterations, each emitting exactly 1 KiB of `unit` after `prefix`. */
function expanded(prefix: string, unit: string, kib: number): string {
  const piece = unit.repeat(Math.ceil(1024 / unit.length)).slice(0, 1024);
  return `${prefix}{% for i in (1..${kib}) %}${piece}{% endfor %}`;
}

/** Exactly 128 KiB of expanded Markdown: 127 loop pieces, then a literal pad that fills the last KiB. */
function exact128(prefix: string, unit: string): string {
  const piece = unit.repeat(Math.ceil(1024 / unit.length)).slice(0, 1024);
  const pad = piece.slice(0, 1024 - prefix.length);
  return `${prefix}{% for i in (1..127) %}${piece}{% endfor %}${pad}`;
}

const shapes: [string, string, string][] = [
  // [name, prefix before the loop, unit repeated by the loop]
  ["backtick", "x\n", "`"],
  ["tilde", "x\n", "~"],
  ["dash", "x\n", "-"],
  ["star", "x\n", "*"],
  ["underscore", "x\n", "_"],
  ["equals", "x\n", "="],
  ["hash", "x\n", "#"],
  ["gt", "x\n", ">"],
  ["pipe", "x\n", "|"],
  ["plus", "x\n", "+"],
  ["digit", "x\n", "1"],
  ["ordered dot", "x\n", "1."],
  ["ordered paren", "x\n", "1)"],
  ["block pipe", "x\n", "|\n-\n"],
  ["block angle", "x\n", "<\n-\n"],
  ["block dashes", "x\n", "--\n"],
  ["rule run", "x\n", "a\n***\n"],
  ["setext run", "x\n", "a\n-\n"],
  ["emphasis run", "x\n", "__+"],
  ["tilde run", "x\n", "w ~"],
  ["table row", "x\n", "|a|\n"],
  ["empty link", "x\n", "[]("],
  ["empty image", "x\n", "![]("],
  ["reference", "x\n", "[x]["],
  ["escaped bracket", "x\n", "\\["],
  ["quote run", "x\n", ">=\n"],
  ["list quote", "x\n", "- > "],
  ["quote list", "x\n", "> - "],
  // B105 r2: a table, a quote or a paragraph line followed by a long run of an emphasis or rule marker
  ["table then underscore", "| a |\n|---|\n| b |\n", "_"],
  ["table then star", "| a |\n|---|\n| b |\n", "* *"],
  ["table then dash", "| a |\n|---|\n| b |\n", "-"],
  ["quote then dash", "> a\n", "-"],
  ["quote then star", "> a\n", "* *"],
  ["paragraph then star", "x\n", "* *"],
  ["paragraph then underscore", "x\n", "_"],
  ["numbered then code", "1. ", "`\n"],
  ["bullet then tilde", "- ", "~\n"],
];

test.each(shapes)(
  "a 128 KiB Liquid expansion of %s renders or is refused within a second",
  async (_, prefix, unit) => {
    const f = await campaignsFixture();
    fixtures.push(f);
    const news = await f.list("news");
    const campaign = await f.campaign({ name: "md", subject: "s", lists: [news] });
    const headers = await readerSession(
      f,
      `liquid-${fixtures.length}`,
      ["campaigns:get"],
      [{ id: news, permissions: ["list:get"] }],
    );
    const started = performance.now();
    const response = await f.request(`/api/campaigns/${campaign.id}/preview`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: previewForm(exact128(prefix, unit)),
    });
    const text = await response.text();
    expect(performance.now() - started).toBeLessThan(1000);
    expect([200, 400]).toContain(response.status);
    // Exactly 128 KiB is accepted by the cap, so a refusal can only come from a Markdown budget.
    expect(text).not.toContain(CAP_MESSAGE);
  },
);

test.each(shapes)(
  "a 1000 KiB Liquid expansion of %s is refused by the 128 KiB cap at once",
  async (_, prefix, unit) => {
    const f = await campaignsFixture();
    fixtures.push(f);
    const news = await f.list("news");
    const campaign = await f.campaign({ name: "md", subject: "s", lists: [news] });
    const headers = await readerSession(
      f,
      `cap-${fixtures.length}`,
      ["campaigns:get"],
      [{ id: news, permissions: ["list:get"] }],
    );
    const started = performance.now();
    const response = await f.request(`/api/campaigns/${campaign.id}/preview`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: previewForm(expanded(prefix, unit, 1000)),
    });
    const text = await response.text();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(response.status).toBe(400);
    expect(text).toContain(CAP_MESSAGE);
  },
);

/** The first line the served fixture writes to stdout. */
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

test("five concurrent 128 KiB Liquid previews of the slowest forms leave a read sent after them answering within a second", async () => {
  const child = Bun.spawn(
    [process.execPath, new URL("./markdown-serve.ts", import.meta.url).pathname],
    { stdout: "pipe", stderr: "pipe" },
  );
  const logged = new Response(child.stderr).text();
  try {
    const ready = JSON.parse(await firstLine(child.stdout)) as {
      origin: string;
      campaign: number;
      headers: Record<string, string>;
    };
    const forms: [string, string][] = [
      ["| a |\n|---|\n| b |\n", "_"],
      ["| a |\n|---|\n| b |\n", "* *"],
      ["x\n", "__+"],
      ["x\n", "[\n-\n"],
      ["x\n", "a\n***\n"],
    ];
    const started = performance.now();
    const previews = forms.map(([prefix, unit]) =>
      fetch(`${ready.origin}/api/campaigns/${ready.campaign}/preview`, {
        method: "POST",
        headers: { ...ready.headers, "content-type": "application/x-www-form-urlencoded" },
        body: previewForm(exact128(prefix, unit)),
      }),
    );
    const read = await fetch(`${ready.origin}/api/campaigns/${ready.campaign}`, {
      headers: ready.headers,
    });
    const readMs = performance.now() - started;
    await read.text();
    const statuses = (await Promise.all(previews)).map((r) => r.status);
    expect(statuses.every((code) => code === 200 || code === 400)).toBe(true);
    expect(read.status).toBe(200);
    expect(readMs).toBeLessThan(1000);
  } finally {
    child.kill();
    await child.exited;
    expect(await logged, "served fixture stderr").toBe("");
  }
}, 120_000);
