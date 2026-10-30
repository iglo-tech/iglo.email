// M3.5 behavior that needs a failure, the injected clock or a sent message. The shared corpus and
// the compiled executable are in test/contract/media.ts.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { campaignsFixture } from "@/test/campaigns/fixture";
import { runnerFixture } from "@/test/campaigns/runner/fixture";
import { imagePng } from "@/test/media/images";
import { imageSize } from "@/media/image";
import { makeFilename } from "@/media/filesystem";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function open() {
  const f = await campaignsFixture();
  cleanups.push(() => f.close());
  return f;
}
async function openRunner() {
  const f = await runnerFixture();
  cleanups.push(() => f.close());
  return f;
}
type Fixture = Awaited<ReturnType<typeof open>>;
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
  return (await response.json()).data as { id: number; filename: string };
};
const uploads = (f: Fixture) => join(f.directory, "uploads");
const entries = (f: Fixture) => readdirSync(uploads(f)).filter((name) => name !== ".tmp");

test("a database failure removes the file again", async () => {
  const f = await open();
  await stored(f, "first.txt", "first");
  f.db.run(`CREATE TRIGGER refuse BEFORE INSERT ON media
    BEGIN SELECT RAISE(ABORT, 'refused'); END`);
  const response = await upload(f, "second.txt", "second");
  expect(response.status).toBe(500);
  expect(entries(f)).toEqual(["first.txt"]);
  expect(readdirSync(join(uploads(f), ".tmp"))).toEqual([]);
  expect(f.errors).toHaveLength(1);
});

test("a storage failure leaves neither a file nor a row", async () => {
  const f = await open();
  await stored(f, "first.txt", "first");
  chmodSync(join(uploads(f), ".tmp"), 0o500);
  const response = await upload(f, "second.txt", "second");
  chmodSync(join(uploads(f), ".tmp"), 0o700);
  expect(response.status).toBe(500);
  expect(entries(f)).toEqual(["first.txt"]);
  expect((await f.json("/api/media")).body.data.total).toBe(1);
});

test("concurrent uploads of one name get distinct files with their own bytes", async () => {
  const f = await open();
  const parts = Array.from({ length: 6 }, (_, i) => `content ${i}`);
  const media = await Promise.all(parts.map((part) => stored(f, "same.txt", part)));
  expect(new Set(media.map((m) => m.filename)).size).toBe(6);
  for (const [i, m] of media.entries())
    expect(await Bun.file(join(uploads(f), m.filename)).text()).toBe(parts[i]!);
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
  for (const { writer } of held) await writer.close();
  for (const { response } of held) expect((await response).status).toBe(400);
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
  for (const i of [1, 2, 3]) await f.member(`to-${i}@example.com`, [list]);
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
  for (const i of [1, 2, 3]) await f.member(`to-${i}@example.com`, [list]);
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
  for (const raw of ["../../x.png", "..\\..\\x.png", "/etc/x.png", "a/b/x.png", "x.png/"])
    expect(makeFilename(raw)).toBe("x.png");
  expect(makeFilename("a\u0000b\nc‮.png")).toBe("ab-c.png");
  expect(makeFilename(".hidden.png")).toBe("hidden.png");
  for (const raw of ["..", ".", "...", "/", "", "   "])
    expect(makeFilename(raw)).toMatch(/^[0-9A-Za-z]{10}$/);
  const long = makeFilename(`${"ż".repeat(300)}.png`);
  expect(long.endsWith(".png")).toBe(true);
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
});

test("image headers that are cut short give no dimensions", () => {
  for (let length = 0; length < imagePng.length; length += 3)
    expect(() => imageSize(imagePng.subarray(0, length))).not.toThrow();
  expect(
    imageSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xff, 0xff])),
  ).toBeNull();
  expect(imageSize(new Uint8Array(40))).toBeNull();
});
