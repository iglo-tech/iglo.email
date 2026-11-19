// B105 (D112), review of e6fbe3d: a body is at most 64 KiB, but a Liquid loop can expand a short body to
// about 1 MiB of Markdown. The target applies to that expansion too: each shape below, rendered as a
// preview from a short body whose loop emits about 1000 KiB, renders or is refused quickly, and a read
// sent after five concurrent previews is not delayed by more than a second.
import { afterEach, expect, test } from "bun:test";
import { campaignsFixture, type CampaignsFixture } from "@/test/campaigns/fixture";
import { previewForm, readerSession } from "@/test/campaigns/markdown-support";

const fixtures: CampaignsFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

/** A loop of 1000 iterations, each emitting exactly 1 KiB of `unit`: about 1000 KiB of Markdown. */
function expanded(unit: string): string {
  const piece = unit.repeat(Math.ceil(1024 / unit.length)).slice(0, 1024);
  return `x\n{% for i in (1..1000) %}${piece}{% endfor %}`;
}

const shapes: [string, string][] = [
  ["backtick", "`"],
  ["tilde", "~"],
  ["dash", "-"],
  ["star", "*"],
  ["underscore", "_"],
  ["equals", "="],
  ["hash", "#"],
  ["gt", ">"],
  ["pipe", "|"],
  ["plus", "+"],
  ["digit", "1"],
  ["ordered dot", "1."],
  ["ordered paren", "1)"],
  ["block pipe", "|\n-\n"],
  ["block angle", "<\n-\n"],
  ["block dashes", "--\n"],
  ["rule run", "a\n***\n"],
  ["setext run", "a\n-\n"],
  ["emphasis run", "__+"],
  ["tilde run", "w ~"],
  ["table row", "|a|\n"],
  ["empty link", "[]("],
  ["empty image", "![]("],
  ["reference", "[x]["],
  ["escaped bracket", "\\["],
  ["quote run", ">=\n"],
  ["list quote", "- > "],
  ["quote list", "> - "],
];

test.each(shapes)(
  "a 1000 KiB Liquid expansion of %s renders or is refused within a second",
  async (_, unit) => {
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
      body: previewForm(expanded(unit)),
    });
    await response.text();
    expect(performance.now() - started).toBeLessThan(1000);
    expect([200, 400]).toContain(response.status);
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

test("five concurrent 1000 KiB Liquid previews leave a read sent after them answering within a second", async () => {
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
    const units = ["~", "|\n-\n", "__+", "[\n-\n", "a\n***\n"];
    const started = performance.now();
    const previews = units.map((unit) =>
      fetch(`${ready.origin}/api/campaigns/${ready.campaign}/preview`, {
        method: "POST",
        headers: { ...ready.headers, "content-type": "application/x-www-form-urlencoded" },
        body: previewForm(expanded(unit)),
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
