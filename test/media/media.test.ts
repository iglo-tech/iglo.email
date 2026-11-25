// M3.5 behavior that needs a failure, the injected clock or a sent message. The shared corpus and
// the compiled executable are in test/contract/media.ts.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { campaignsFixture } from "@/test/campaigns/fixture";
import { runnerFixture } from "@/test/campaigns/runner/fixture";
import { imagePng } from "@/test/media/images";
import { startStalledSink } from "@/test/tx/sink";
import { imageSize } from "@/media/image";
import { makeFilename } from "@/media/filesystem";
import type { JsonObject } from "@/test/json-object";
import { readJson } from "@/test/read-body";
import { untilState } from "@/test/wait";

// A 10 s stall fails by name before this timeout, not after a single-file run's 5 s default.
setDefaultTimeout(30_000);

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) {
    await close();
  }
});
async function open() {
  const f = await campaignsFixture();
  cleanups.push(() => f.close());
  return f;
}
async function openRunner(options: Parameters<typeof runnerFixture>[0] = {}) {
  const f = await runnerFixture(options);
  cleanups.push(() => f.close());
  return f;
}
type Fixture = Awaited<ReturnType<typeof open>>;
type RunnerFixture = Awaited<ReturnType<typeof openRunner>>;
const upload = (
  f: Pick<Fixture, "request" | "sessionHeaders">,
  name: string,
  content: BlobPart,
) => {
  const body = new FormData();
  body.append("file", new File([content], name, { type: "application/pdf" }));
  return f.request("/api/media", { method: "POST", headers: f.sessionHeaders, body });
};
const stored = async (
  f: Pick<Fixture, "request" | "sessionHeaders">,
  name: string,
  content: BlobPart,
) => {
  const response = await upload(f, name, content);
  expect(response.status).toBe(200);
  return (await readJson<{ data: { id: number; filename: string } }>(response)).data;
};
const uploads = (f: Pick<Fixture, "directory">) => join(f.directory, "uploads");
const TEMPORARY = ".iglo-email-uploading";
const entries = (f: Fixture) => readdirSync(uploads(f)).filter((name) => name !== TEMPORARY);

test("a database failure removes the file again", async () => {
  const f = await open();
  await stored(f, "first.txt", "first");
  f.db.run(`CREATE TRIGGER refuse BEFORE INSERT ON media
    BEGIN SELECT RAISE(ABORT, 'refused'); END`);
  const response = await upload(f, "second.txt", "second");
  expect(response.status).toBe(500);
  expect(entries(f)).toEqual(["first.txt"]);
  expect(readdirSync(join(uploads(f), TEMPORARY))).toEqual([]);
  expect(f.errors).toHaveLength(1);
});

test("a storage failure leaves neither a file nor a row", async () => {
  const f = await open();
  await stored(f, "first.txt", "first");
  chmodSync(join(uploads(f), TEMPORARY), 0o500);
  const response = await upload(f, "second.txt", "second");
  chmodSync(join(uploads(f), TEMPORARY), 0o700);
  expect(response.status).toBe(500);
  expect(entries(f)).toEqual(["first.txt"]);
  expect((await f.json("/api/media")).body.data.total).toBe(1);
});

test("concurrent uploads of one name get distinct files with their own bytes", async () => {
  const f = await open();
  const parts = Array.from({ length: 6 }, (_, i) => `content ${i}`);
  const media = await Promise.all(parts.map((part) => stored(f, "same.txt", part)));
  expect(new Set(media.map((m) => m.filename)).size).toBe(6);
  for (const [i, m] of media.entries()) {
    expect(await Bun.file(join(uploads(f), m.filename)).text()).toBe(parts[i]!);
  }
});

test("uploads held in memory are bounded", async () => {
  const f = await open();
  const held = Array.from({ length: 8 }, () => {
    const body = new TransformStream<Uint8Array>();
    const response = f.request("/api/media", {
      method: "POST",
      headers: { ...f.sessionHeaders, "content-type": "multipart/form-data; boundary=x" },
      body: body.readable,
    });
    return { writer: body.writable.getWriter(), response };
  });
  await Bun.sleep(10);
  const refused = await upload(f, "ninth.txt", "x");
  expect(refused.status).toBe(429);
  expect(refused.headers.get("retry-after")).toBe("1");
  for (const { writer } of held) {
    await writer.close();
  }
  for (const { response } of held) {
    expect((await response).status).toBe(400);
  }
  expect((await upload(f, "ninth.txt", "x")).status).toBe(200);
});

test("a file already gone does not fail the delete, and the row goes", async () => {
  const f = await open();
  const media = await stored(f, "gone.txt", "x");
  rmSync(join(uploads(f), media.filename));
  expect((await f.json(`/api/media/${media.id}`, "DELETE")).status).toBe(200);
  expect((await f.json(`/api/media/${media.id}`)).status).toBe(404);
});

test("a row keeps the file a different row names as its thumbnail", async () => {
  const f = await open();
  const image = await stored(f, "image.png", imagePng);
  const other = await stored(f, "other.png", imagePng);
  // As imported from listmonk: a thumbnail of its own, whose name is another upload's.
  f.db.run("UPDATE media SET thumb = ? WHERE id = ?", [other.filename, image.id]);
  expect((await f.json(`/api/media/${image.id}`, "DELETE")).status).toBe(200);
  expect(existsSync(join(uploads(f), other.filename))).toBe(true);
});

test("a campaign's media goes out with every message, read once", async () => {
  const f = await openRunner();
  const media = await stored(f, "guide.pdf", "%PDF-1.4 guide");
  const list = await f.list("attachments");
  for (const i of [1, 2, 3]) {
    await f.member(`to-${i}@example.com`, [list]);
  }
  const campaign = await f.campaign({
    name: "With a file",
    subject: "S",
    lists: [list],
    content_type: "plain",
    type: "regular",
    messenger: "fixture",
    body: "B",
    media: [media.id],
  });
  f.start();
  await f.status(campaign.id, "running");
  await f.until(campaign.id, "finished");
  expect(f.pushes).toHaveLength(3);
  for (const push of f.pushes) {
    const [file] = push.message.attachments!;
    expect(file!.name).toBe("guide.pdf");
    expect(file!.contentType).toBe("application/pdf");
    expect(Buffer.from(file!.content).toString()).toBe("%PDF-1.4 guide");
  }
});

test("media deleted before the send is not attached", async () => {
  const f = await openRunner();
  const media = await stored(f, "old.pdf", "x");
  const list = await f.list("deleted");
  await f.member("to@example.com", [list]);
  const campaign = await f.campaign({
    name: "Deleted file",
    subject: "S",
    lists: [list],
    content_type: "plain",
    type: "regular",
    messenger: "fixture",
    body: "B",
    media: [media.id],
  });
  await f.json(`/api/media/${media.id}`, "DELETE");
  f.start();
  await f.status(campaign.id, "running");
  await f.until(campaign.id, "finished");
  expect(f.pushes[0]!.message.attachments).toBeUndefined();
});

test("a missing file pauses the campaign unsent, and resuming sends everyone once", async () => {
  const f = await openRunner();
  const media = await stored(f, "lost.pdf", "%PDF");
  const list = await f.list("missing");
  for (const i of [1, 2, 3]) {
    await f.member(`to-${i}@example.com`, [list]);
  }
  const campaign = await f.campaign({
    name: "Lost file",
    subject: "S",
    lists: [list],
    content_type: "plain",
    type: "regular",
    messenger: "fixture",
    body: "B",
    media: [media.id],
  });
  const path = join(f.directory, "uploads", media.filename);
  rmSync(path);
  f.start();
  await f.status(campaign.id, "running");
  await f.until(campaign.id, "paused");
  expect(f.pushes).toHaveLength(0);
  expect(String(f.errors.at(-1))).toContain("error fetching attachments");
  expect(f.db.query("SELECT COUNT(*) AS n FROM campaign_deliveries").get()).toEqual({ n: 0n });
  await Bun.write(path, "%PDF");
  await f.status(campaign.id, "running");
  await f.until(campaign.id, "finished");
  expect(f.pushes.map((push) => push.to).sort()).toEqual([
    "to-1@example.com",
    "to-2@example.com",
    "to-3@example.com",
  ]);
});

test("attachments over the bound pause the campaign instead of holding them in memory", async () => {
  const f = await openRunner();
  const first = await stored(f, "a.pdf", new Uint8Array(6 * 1024 * 1024));
  const second = await stored(f, "b.pdf", new Uint8Array(5 * 1024 * 1024));
  const list = await f.list("large");
  await f.member("to@example.com", [list]);
  const campaign = await f.campaign({
    name: "Too large",
    subject: "S",
    lists: [list],
    content_type: "plain",
    type: "regular",
    messenger: "fixture",
    body: "B",
    media: [first.id, second.id],
  });
  f.start();
  await f.status(campaign.id, "running");
  await f.until(campaign.id, "paused");
  expect(f.pushes).toHaveLength(0);
});

const mebibytes = (count: number, fill = 0) => new Uint8Array(count * 1024 * 1024).fill(fill);
/**
 * Distinct attachment buffers this test's messages carried. Each buffer is counted once, by
 * identity, so the count is the number of distinct buffers that reached a message: a cache hit
 * adds nothing. With one message per batch, it counts reads of the file, not repeated reads within
 * a batch. It does not depend on when a collection runs. The count of buffers still reachable after `Bun.gc(true)`, which this test used before
 * B103, varied between identical runs (one or two for the same campaigns; see
 * docs/perf/B103-release-flakes.md), and its cause was not established, so it is not used. The test
 * does not use process-wide `arrayBuffers`: a worker process runs several test files in turn. The
 * WeakSet keeps nothing alive.
 */
function carriedBuffers() {
  const seen = new WeakSet<object>();
  let count = 0;
  return {
    note(buffer: ArrayBufferLike) {
      if (seen.has(buffer)) {
        return;
      }
      seen.add(buffer);
      count++;
    },
    /** Distinct buffers carried so far. */
    carried: () => count,
  };
}
const campaignInput = (lists: Array<number>, extra: JsonObject) => ({
  subject: "S",
  lists,
  content_type: "plain",
  type: "regular",
  messenger: "fixture",
  body: "B",
  ...extra,
});
/** Lets `count` messages go out, each held and then forgotten by the test, and the next held. */
async function sendHeld(
  f: RunnerFixture,
  count: number,
  carried: ReturnType<typeof carriedBuffers>,
) {
  const seen: Array<string> = [];
  for (let sent = 0; sent < count; sent++) {
    await f.drive(() => f.pushes.length > sent);
    const push = f.pushes[sent]!;
    carried.note(push.message.attachments![0]!.content.buffer);
    seen.push(Buffer.from(push.message.attachments![0]!.content.subarray(0, 1)).toString("hex"));
    delete push.message.attachments;
    push.settle();
  }
  return seen;
}

test("two campaigns sharing attachments hold them once, one recipient per batch", async () => {
  const f = await openRunner({ hold: true });
  f.control.grant = 1;
  const media = await stored(f, "brochure.pdf", mebibytes(8));
  const list = await f.list("shared");
  for (const i of [1, 2, 3]) {
    await f.member(`to-${i}@example.com`, [list]);
  }
  for (const name of ["First", "Second"]) {
    const c = await f.campaign(campaignInput([list], { name, media: [media.id] }));
    await f.status(c.id, "running");
  }
  const carried = carriedBuffers();
  f.start();
  await sendHeld(f, 4, carried);
  await f.drive(() => f.pushes.length === 5);
  carried.note(f.pushes[4]!.message.attachments![0]!.content.buffer);
  // Both campaigns carried one file, and it was read once: the cache served every later batch.
  expect(carried.carried()).toBe(1);
});

test("attachments over the cache budget are evicted and read again for the next batch", async () => {
  const reads: Array<string> = [];
  const f = await openRunner({
    hold: true,
    attachmentCacheBytes: 9 * 1024 * 1024,
    attachmentReads: reads,
  });
  f.control.grant = 1;
  const list = await f.list("evicted");
  for (const i of [1, 2, 3]) {
    await f.member(`to-${i}@example.com`, [list]);
  }
  const campaigns: Array<number> = [];
  for (const fill of [1, 2]) {
    const media = await stored(f, `file-${fill}.pdf`, mebibytes(8, fill));
    const c = await f.campaign(campaignInput([list], { name: `C${fill}`, media: [media.id] }));
    campaigns.push(c.id);
    await f.status(c.id, "running");
  }
  const carried = carriedBuffers();
  f.start();
  const seen = await sendHeld(f, 5, carried);
  await f.drive(() => f.pushes.length === 6);
  carried.note(f.pushes[5]!.message.attachments![0]!.content.buffer);
  // Six batches alternate between two 8 MiB files under a 9 MiB budget, so the cache holds one
  // file at a time and each batch carries a buffer from a read of its file: six distinct buffers.
  // A cache hit would carry a buffer already counted, so the count would be lower. This does not
  // see a batch that read its file twice and carried one buffer, since a one-slot grant carries one
  // buffer per batch either way.
  expect(carried.carried()).toBe(6);
  // The same claim, counted at the disk: six batches, six reads of the two files, three each. A
  // batch that took its file from the cache would not appear here, and a cache that never evicts
  // would read each file once (B101 r1: assert re-reads directly).
  expect(reads).toHaveLength(6);
  expect(new Set(reads).size).toBe(2);
  for (const path of new Set(reads)) {
    expect(reads.filter((read) => read === path)).toHaveLength(3);
  }
  f.control.hold = false;
  for (const push of f.pushes) {
    push.settle();
  }
  for (const id of campaigns) {
    await f.until(id, "finished");
  }
  // Every message of both campaigns went out, with its file.
  for (const id of campaigns) {
    expect((await f.read(id)).sent).toBe(3);
  }
  expect(new Set(seen)).toEqual(new Set(["01", "02"]));
});

test("a file lost between batches pauses the campaign, and resuming sends the rest once", async () => {
  const f = await openRunner({ hold: true });
  f.control.grant = 1;
  const media = await stored(f, "lost.pdf", "%PDF");
  const list = await f.list("between");
  for (const i of [1, 2, 3]) {
    await f.member(`to-${i}@example.com`, [list]);
  }
  const c = await f.campaign(campaignInput([list], { name: "Later", media: [media.id] }));
  await f.status(c.id, "running");
  f.start();
  await f.drive(() => f.pushes.length === 1);
  const path = join(uploads(f), media.filename);
  rmSync(path);
  f.pushes[0]!.settle();
  await f.until(c.id, "paused");
  expect(f.pushes).toHaveLength(1);
  await Bun.write(path, "%PDF");
  f.control.hold = false;
  await f.status(c.id, "running");
  await f.until(c.id, "finished");
  expect(f.pushes.map((push) => push.to).sort()).toEqual([
    "to-1@example.com",
    "to-2@example.com",
    "to-3@example.com",
  ]);
});

test("claims left by a crash in the attachment step stay unknown and are not sent", async () => {
  const f = await openRunner();
  const media = await stored(f, "crash.pdf", "%PDF");
  const list = await f.list("crash");
  const first = await f.member("to-1@example.com", [list]);
  await f.member("to-2@example.com", [list]);
  const c = await f.campaign(campaignInput([list], { name: "Crash", media: [media.id] }));
  await f.status(c.id, "running");
  // A process that died before returning the batch left its claims and cursor committed.
  const at = f.clock.now().toISOString();
  const id = BigInt(c.id);
  f.runnerStore.claim(id, BigInt(first.id), at);
  f.db.run("UPDATE campaigns SET last_subscriber_id = ? WHERE id = ?", [first.id, c.id]);
  f.start();
  await f.until(c.id, "finished");
  expect(f.pushes.map((push) => push.to)).toEqual(["to-2@example.com"]);
  expect(
    f.db.query("SELECT status FROM campaign_deliveries WHERE subscriber_id = ?").get(first.id),
  ).toEqual({ status: "unknown" });
});

test("queued test sends keep their slots until they settle, and the next is refused", async () => {
  const smtp = await startStalledSink();
  const f = await campaignsFixture({ smtpPort: smtp.port });
  cleanups.push(
    () => f.close(),
    () => smtp.close(),
  );
  const list = await f.list("stalled");
  await f.subscriber("test@example.com", [list]);
  const input = {
    name: "Stalled",
    subject: "S",
    lists: [list],
    content_type: "plain",
    type: "regular",
    messenger: "fixture",
    body: "B",
    from_email: "Fixture <noreply@fixture.test>",
  };
  const campaign = await f.campaign(input);
  const send = async (i: number) => {
    const media = await stored(f, `queued-${i}.pdf`, mebibytes(1));
    return f.json(`/api/campaigns/${campaign.id}/test`, "POST", {
      ...input,
      media: [media.id],
      subscribers: ["test@example.com"],
    });
  };
  const statuses: Array<number> = [];
  for (let i = 0; i < 6; i++) {
    statuses.push((await send(i)).status);
  }
  expect(statuses).toEqual([200, 200, 200, 200, 429, 429]);
  // The emailer's own deadline settles them, and the slots come back.
  f.clock.advance(60_000);
  let next = 0;
  let attempt = 0;
  await untilState(
    async () => {
      next = (await send(6 + attempt++)).status;
      return next === 200;
    },
    {
      label: "the test-send slots come back",
      progress: () => String(next),
      stallMs: 10_000,
      intervalMs: 5,
    },
  ).catch(() => undefined);
  expect(next).toBe(200);
});

const embedded = (src: string) => `<p><img alt="Logo" src="${src}" data-embed="true"></p>`;
const inlineParts = (raw: string) => {
  const text = raw.replaceAll("=\r\n", "").replaceAll("=3D", "=");
  return {
    text,
    cids: [...text.matchAll(/^Content-ID: <([^>]+)>/gim)].map((m) => m[1]!),
    sources: [...text.matchAll(/<img[^>]*\ssrc="(cid:[^"]*)"/g)].map((m) => m[1]!),
  };
};

test("data-embed images in a body and a template go out as inline parts of a campaign", async () => {
  const f = await openRunner({ realEmailer: true });
  const logo = await stored(f, "logo.png", imagePng);
  const header = await stored(f, "header.png", imagePng);
  const template = await f.json("/api/templates", "POST", {
    name: "Embedded",
    type: "campaign",
    body: `${embedded("header.png")}{{ content | raw }}`,
  });
  expect(template.status).toBe(200);
  const list = await f.list("embedded");
  await f.member("to@example.com", [list]);
  const c = await f.campaign(
    campaignInput([list], {
      name: "Embedded",
      content_type: "richtext",
      messenger: "email",
      template_id: template.body.data.id,
      body: embedded(`http://fixture.test/uploads/${logo.filename}?v=1`),
    }),
  );
  f.start();
  await f.status(c.id, "running");
  await f.until(c.id, "finished");
  const [mail] = await f.mail(1);
  const { text, cids, sources } = inlineParts(mail!.data);
  expect(text).toContain("multipart/related");
  expect(text).toMatch(/^Content-Disposition: inline/im);
  expect(new Set(cids).size).toBe(2);
  expect(sources.sort()).toEqual(cids.map((cid) => `cid:${cid}`).sort());
  expect(text.replaceAll("\r\n", "")).toContain(
    Buffer.from(imagePng).toString("base64").replace(/=+$/, ""),
  );
  expect(text).toContain(`filename=${header.filename}`);
});

const unresolved = [
  `<img src="https://cdn.example.com/customer.png" data-embed="true">`,
  `<img src="{{ subscriber.attribs.logo }}" data-embed="true">`,
].join("");

test("data-embed images with no media row go out with their source unchanged", async () => {
  const f = await openRunner({ realEmailer: true });
  const list = await f.list("embed-external");
  await f.member("to@example.com", [list], "confirmed", {
    attribs: { logo: "https://cdn.example.com/personal.png" },
  });
  const c = await f.campaign(
    campaignInput([list], {
      name: "External",
      content_type: "richtext",
      messenger: "email",
      body: unresolved,
    }),
  );
  f.start();
  await f.status(c.id, "running");
  await f.until(c.id, "finished");
  const [mail] = await f.mail(1);
  const { text, cids } = inlineParts(mail!.data);
  expect(cids).toEqual([]);
  expect(text).toContain(`src="https://cdn.example.com/customer.png"`);
  expect(text).toContain(`src="https://cdn.example.com/personal.png"`);
  expect(String(f.errors.at(-1))).toContain("not embedded");
});

test("a test send keeps a source with no media row, as a campaign does", async () => {
  const f = await open();
  const list = await f.list("test-external");
  await f.subscriber("test@example.com", [list], {
    attribs: { logo: "https://cdn.example.com/personal.png" },
  });
  const input = {
    name: "Test",
    subject: "S",
    lists: [list],
    content_type: "richtext",
    type: "regular",
    messenger: "fixture",
    body: unresolved,
    from_email: "Fixture <noreply@fixture.test>",
  };
  const campaign = await f.campaign(input);
  const sent = await f.json(`/api/campaigns/${campaign.id}/test`, "POST", {
    ...input,
    subscribers: ["test@example.com"],
  });
  expect(sent.status).toBe(200);
  const [mail] = await f.mail(1);
  const { text, cids } = inlineParts(mail!.data);
  expect(cids).toEqual([]);
  expect(text).toContain(`src="https://cdn.example.com/customer.png"`);
  expect(text).toContain(`src="https://cdn.example.com/personal.png"`);
});

test("a test send embeds data-embed images, and fails on one whose file is gone", async () => {
  const f = await open();
  const logo = await stored(f, "logo.png", imagePng);
  const list = await f.list("test-embed");
  await f.subscriber("test@example.com", [list]);
  const input = {
    name: "Test",
    subject: "S",
    lists: [list],
    content_type: "richtext",
    type: "regular",
    messenger: "fixture",
    body: embedded(logo.filename),
    from_email: "Fixture <noreply@fixture.test>",
  };
  const campaign = await f.campaign(input);
  const send = (body: string) =>
    f.json(`/api/campaigns/${campaign.id}/test`, "POST", {
      ...input,
      body,
      subscribers: ["test@example.com"],
    });
  expect((await send(input.body)).status).toBe(200);
  const [mail] = await f.mail(1);
  const { cids, sources } = inlineParts(mail!.data);
  expect(cids).toHaveLength(1);
  expect(sources).toEqual([`cid:${cids[0]}`]);
  expect((await send(`<img data-embed src="cid:already">${input.body}`)).status).toBe(200);
  rmSync(join(uploads(f), logo.filename));
  expect((await send(input.body)).status).toBe(500);
});

test("an embedded image that lost its file pauses the campaign unsent", async () => {
  const f = await openRunner();
  const image = await stored(f, "lost.png", imagePng);
  rmSync(join(uploads(f), image.filename));
  const list = await f.list("embed-missing");
  await f.member("to@example.com", [list]);
  const c = await f.campaign(
    campaignInput([list], {
      name: "No image",
      content_type: "richtext",
      body: embedded(image.filename),
    }),
  );
  f.start();
  await f.status(c.id, "running");
  await f.until(c.id, "paused");
  expect(f.pushes).toHaveLength(0);
  expect(String(f.errors.at(-1))).toContain("has no file");
});

test("a root that stopped qualifying pauses a campaign with media and says why", async () => {
  const f = await openRunner();
  const file = await stored(f, "kept.pdf", "kept");
  const list = await f.list("refused-root");
  await f.member("to@example.com", [list]);
  const c = await f.campaign(
    campaignInput([list], { name: "Refused", media: [file.id], messenger: "email" }),
  );
  const elsewhere = `${f.directory}-elsewhere`;
  cleanups.push(() => rmSync(elsewhere, { recursive: true, force: true }));
  renameSync(uploads(f), elsewhere);
  symlinkSync(elsewhere, uploads(f));
  f.start();
  await f.status(c.id, "running");
  await f.until(c.id, "paused");
  expect(f.pushes).toHaveLength(0);
  expect(String(f.errors.at(-1))).toContain("data directory");
});

test("embedded images count toward a campaign's size limit", async () => {
  const f = await openRunner();
  const image = await stored(f, "large.png", mebibytes(6));
  const file = await stored(f, "large.pdf", mebibytes(5));
  const list = await f.list("embed-large");
  await f.member("to@example.com", [list]);
  const c = await f.campaign(
    campaignInput([list], {
      name: "Large",
      content_type: "richtext",
      body: embedded(image.filename),
      media: [file.id],
    }),
  );
  f.start();
  await f.status(c.id, "running");
  await f.until(c.id, "paused");
  expect(f.pushes).toHaveLength(0);
});

test("a plain campaign keeps data-embed as text", async () => {
  const f = await openRunner();
  const logo = await stored(f, "logo.png", imagePng);
  const list = await f.list("embed-plain");
  await f.member("to@example.com", [list]);
  const body = embedded(logo.filename);
  const c = await f.campaign(campaignInput([list], { name: "Plain", body }));
  f.start();
  await f.status(c.id, "running");
  await f.until(c.id, "finished");
  expect(Buffer.from(f.pushes[0]!.message.body).toString()).toContain(body);
  expect(f.pushes[0]!.message.attachments).toBeUndefined();
});

test("a test send carries the request's media through SMTP", async () => {
  const f = await open();
  const media = await stored(f, "guide.pdf", "%PDF-1.4 guide");
  const list = await f.list("tests");
  await f.subscriber("test@example.com", [list]);
  const input = {
    name: "Test",
    subject: "S",
    lists: [list],
    content_type: "plain",
    type: "regular",
    messenger: "fixture",
    body: "B",
    from_email: "Fixture <noreply@fixture.test>",
  };
  const campaign = await f.campaign(input);
  const sent = await f.json(`/api/campaigns/${campaign.id}/test`, "POST", {
    ...input,
    subscribers: ["test@example.com"],
    media: [media.id],
  });
  expect(sent.status).toBe(200);
  const [mail] = await f.mail(1);
  const text = JSON.stringify(mail);
  expect(text).toContain("guide.pdf");
  expect(text).toContain(Buffer.from("%PDF-1.4 guide").toString("base64"));
  const refused = await f.json(`/api/campaigns/${campaign.id}/test`, "POST", {
    ...input,
    subscribers: ["test@example.com"],
    media: [media.id + 1],
  });
  expect(refused.status).toBe(500);
});

test("makeFilename leaves one visible path component", () => {
  for (const raw of ["../../x.png", String.raw`..\..\x.png`, "/etc/x.png", "a/b/x.png", "x.png/"]) {
    expect(makeFilename(raw)).toBe("x.png");
  }
  expect(makeFilename("a\u0000b\nc‮.png")).toBe("ab-c.png");
  expect(makeFilename(".hidden.png")).toBe("hidden.png");
  for (const raw of ["..", ".", "...", "/", "", "   "]) {
    expect(makeFilename(raw)).toMatch(/^[0-9A-Za-z]{10}$/);
  }
  const long = makeFilename(`${"ż".repeat(300)}.png`);
  expect(long.endsWith(".png")).toBe(true);
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
});

test("image headers that are cut short give no dimensions", () => {
  for (let length = 0; length < imagePng.length; length += 3) {
    expect(() => imageSize(imagePng.subarray(0, length))).not.toThrow();
  }
  expect(
    imageSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xff, 0xff])),
  ).toBeNull();
  expect(imageSize(new Uint8Array(40))).toBeNull();
});
