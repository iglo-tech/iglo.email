// The boundary of the upload directory, through the settings and media HTTP routes. What the
// compiled executable does at startup is in test/media/startup.test.ts.
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { campaignsFixture } from "@/test/campaigns/fixture";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function open() {
  const f = await campaignsFixture();
  cleanups.push(() => f.close());
  return f;
}
function outside() {
  const directory = mkdtempSync(join(tmpdir(), "iglo-outside-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
/** The upload's own directory, as in src/media/filesystem.ts. */
const TEMPORARY = ".iglo-email-uploading";
type Fixture = Awaited<ReturnType<typeof open>>;
const setRoot = (f: Fixture, value: string) =>
  f.json("/api/settings/upload.filesystem.upload_path", "PUT", JSON.stringify(value));
const upload = (f: Fixture, name: string, content: BlobPart) => {
  const body = new FormData();
  body.append("file", new File([content], name, { type: "text/plain" }));
  return f.request("/api/media", { method: "POST", headers: f.sessionHeaders, body });
};
const stored = async (f: Fixture, name: string, content: BlobPart) => {
  const response = await upload(f, name, content);
  expect(response.status).toBe(200);
  return (await response.json()).data as { id: number; filename: string };
};
/** As an anonymous client: the path of a stored file is public. */
const served = (f: Fixture, name: string) => f.request(`/uploads/${name}`);

test("a symlinked root reaching the data directory is refused and the database stays private", async () => {
  const f = await open();
  symlinkSync(f.directory, join(f.directory, "data-alias"));
  const saved = await setRoot(f, "data-alias");
  expect(saved.status).toBe(400);
  expect(saved.body.message).toContain("data directory");
  expect((await f.json("/api/settings")).body.data["upload.filesystem.upload_path"]).toBe(
    "uploads",
  );
  expect((await served(f, "iglo-email.db")).status).toBe(404);
});

test("a root outside the data directory is refused, by path or through a link", async () => {
  const f = await open();
  const elsewhere = outside();
  await Bun.write(join(elsewhere, "secret.txt"), "secret");
  symlinkSync(elsewhere, join(f.directory, "elsewhere"));
  for (const path of [
    elsewhere,
    "elsewhere",
    "elsewhere/deeper",
    "..",
    ".",
    f.directory,
    "/",
    join(f.directory, ".."),
  ]) {
    expect({ path, status: (await setRoot(f, path)).status }).toEqual({ path, status: 400 });
    expect((await served(f, "secret.txt")).status).toBe(404);
  }
});

test("a broken link and a file are not roots", async () => {
  const f = await open();
  symlinkSync(join(f.directory, "not-there"), join(f.directory, "broken"));
  await Bun.write(join(f.directory, "plain"), "x");
  for (const path of ["broken", "broken/deeper", "plain", "plain/deeper"])
    expect({ path, status: (await setRoot(f, path)).status }).toEqual({ path, status: 400 });
});

test("a file in the root without a media row is not served", async () => {
  const f = await open();
  const media = await stored(f, "listed.txt", "listed");
  await Bun.write(join(f.directory, "uploads", "unrelated.txt"), "unrelated");
  expect((await served(f, "unrelated.txt")).status).toBe(404);
  expect((await served(f, media.filename)).status).toBe(200);
});

test("a root replaced by a link after it was saved serves and accepts nothing", async () => {
  const f = await open();
  const media = await stored(f, "listed.txt", "listed");
  const elsewhere = join(outside(), "moved");
  renameSync(join(f.directory, "uploads"), elsewhere);
  symlinkSync(elsewhere, join(f.directory, "uploads"));
  expect((await served(f, media.filename)).status).toBe(404);
  const refused = await upload(f, "next.txt", "next");
  expect(refused.status).toBe(503);
  expect((await refused.json()).message).toContain("data directory");
  expect(existsSync(join(elsewhere, "next.txt"))).toBe(false);
  // Settings stay reachable, and a test send says why it has no file.
  const all = (await f.json("/api/settings")).body.data;
  expect((await f.json("/api/settings", "PUT", all)).status).toBe(200);
  const list = await f.list("refused");
  await f.subscriber("test@example.com", [list]);
  const input = {
    name: "Refused",
    subject: "S",
    lists: [list],
    content_type: "plain",
    type: "regular",
    messenger: "fixture",
    body: "B",
    from_email: "Fixture <noreply@fixture.test>",
  };
  const campaign = await f.campaign(input);
  const send = await f.json(`/api/campaigns/${campaign.id}/test`, "POST", {
    ...input,
    media: [media.id],
    subscribers: ["test@example.com"],
  });
  expect(send.status).toBe(500);
  expect(send.body.message).toContain("data directory");
});

test("a change of root while a body is still streaming is refused", async () => {
  const f = await open();
  const body = new TransformStream<Uint8Array>();
  const boundary = "fixture-boundary";
  const pending = f.request("/api/media", {
    method: "POST",
    headers: {
      ...f.sessionHeaders,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body: body.readable,
  });
  await Bun.sleep(10);
  expect((await setRoot(f, "other")).status).toBe(200);
  const writer = body.writable.getWriter();
  await writer.write(
    new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="late.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\nlate\r\n--${boundary}--\r\n`,
    ),
  );
  await writer.close();
  expect((await pending).status).toBe(409);
  expect((await f.json("/api/media")).body.data.total).toBe(0);
});

test("an empty store can move to another directory inside the data directory", async () => {
  const f = await open();
  expect((await setRoot(f, "custom/place")).status).toBe(200);
  const media = await stored(f, "placed.txt", "placed");
  expect(existsSync(join(f.directory, "custom/place", media.filename))).toBe(true);
  expect(await (await served(f, media.filename)).text()).toBe("placed");
});

test("the root cannot change while media exists, and unchanged settings still save", async () => {
  const f = await open();
  const media = await stored(f, "same.txt", "original");
  mkdirSync(join(f.directory, "other"));
  const unrelated = join(f.directory, "other", "same.txt");
  await Bun.write(unrelated, "unrelated");

  const refused = await setRoot(f, "other");
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain("media");
  expect(await (await served(f, media.filename)).text()).toBe("original");

  expect((await setRoot(f, "uploads")).status).toBe(200);
  expect((await setRoot(f, " ./uploads ")).status).toBe(200);
  const all = (await f.json("/api/settings")).body.data;
  expect((await f.json("/api/settings", "PUT", all)).status).toBe(200);
  expect(
    (await f.json("/api/settings", "PUT", { ...all, "upload.filesystem.upload_path": "other" }))
      .status,
  ).toBe(400);

  expect((await f.json(`/api/media/${media.id}`, "DELETE")).status).toBe(200);
  expect(existsSync(join(f.directory, "uploads", "same.txt"))).toBe(false);
  expect(await Bun.file(unrelated).text()).toBe("unrelated");
  expect((await setRoot(f, "other")).status).toBe(200);
});

test("an upload that outlives a root change is refused and leaves nothing behind", async () => {
  const f = await open();
  const uploads = join(f.directory, "uploads");
  const temporary = join(uploads, TEMPORARY);
  const content = new Uint8Array(24 * 1024 * 1024);
  const pending = upload(f, "race.bin", content);
  const writing = () => existsSync(temporary) && readdirSync(temporary).length > 0;
  for (let i = 0; i < 20_000 && !writing(); i++) await Bun.sleep(0);
  expect(writing()).toBe(true);
  expect((await setRoot(f, "other")).status).toBe(200);
  const created = await pending;
  expect(created.status).toBe(409);
  expect(existsSync(join(uploads, "race.bin"))).toBe(false);
  expect((await f.json("/api/media")).body.data.total).toBe(0);
});
