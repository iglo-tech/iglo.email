// Reference: listmonk cmd/media.go, internal/core/media.go, the filesystem provider and the Static
// route of cmd/init.go at 6fcd95f. The shared corpus runs against both targets. Where this project
// differs deliberately (07-api-and-ui.md) the check is on `reference`.
import { existsSync, lstatSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Credentials, Mode } from "@/test/contract/types";
import { imagePng, imagePngSize, imageGif, imageJpeg } from "@/test/media/images";

export async function runMediaContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
  restart?: () => Promise<void>;
  dataDir?: string;
}) {
  const reference = target.mode === "reference";
  const suffix = crypto.randomUUID().slice(0, 8);
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL media-${label}`);
  };
  const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = { authorization },
  ) => {
    const form = body instanceof FormData;
    const response = await fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined || form ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: form ? (body as FormData) : JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* Not JSON. */
    }
    return { status: response.status, headers: response.headers, body: parsed, text };
  };
  const form = (name: string, content: BlobPart, type: string, field = "file") => {
    const data = new FormData();
    data.append(field, new File([content], name, { type }));
    return data;
  };
  const upload = (
    name: string,
    content: BlobPart = imagePng,
    type = "image/png",
    headers?: Record<string, string>,
  ) => call("/api/media", "POST", form(name, content, type), headers);
  const stored = async (name: string, content?: BlobPart, type?: string) => {
    const created = await upload(name, content, type);
    check(created.status === 200, `upload-${name}`);
    return created.body.data as Record<string, any> & { id: number; filename: string };
  };
  const setting = async (key: string, value: unknown) => {
    check((await call(`/api/settings/${key}`, "PUT", value)).status === 200, `setting-${key}`);
    if (reference) {
      await Bun.sleep(1200);
      for (const deadline = Date.now() + 15_000; Date.now() < deadline; await Bun.sleep(100)) {
        try {
          if ((await fetch(`${target.baseUrl}/health`)).ok) break;
        } catch {
          /* Still reloading. */
        }
      }
    }
  };
  /** A served file, by the path of its URL: the host differs between root URL and test target. */
  const served = (url: string, init?: RequestInit) =>
    fetch(`${target.baseUrl}${new URL(url).pathname}`, init);
  const roles: number[] = [],
    users: number[] = [];
  const apiUser = async (name: string, permissions: string[]) => {
    const role = await call("/api/roles/users", "POST", {
      name: `${name}-${suffix}`,
      permissions,
    });
    check(role.status === 200, `role-${name}`);
    roles.push(role.body.data.id);
    const user = await call("/api/users", "POST", {
      username: `${name}-${suffix}`,
      name,
      type: "api",
      status: "enabled",
      user_role_id: role.body.data.id,
    });
    check(user.status === 200, `user-${name}`);
    users.push(user.body.data.id);
    return {
      authorization: `Basic ${btoa(`${name}-${suffix}:${user.body.data.password}`)}`,
    };
  };
  const originals = (await call("/api/settings")).body.data as Record<string, any>;
  const created: number[] = [];
  const keep = <T extends { id: number }>(item: T) => (created.push(item.id), item);
  try {
    // Permissions.
    const reader = await apiUser("media-read", ["media:get"]);
    const manager = await apiUser("media-manage", ["media:manage"]);
    check((await call("/api/media", "GET", undefined, {})).status === 403, "get-anonymous");
    check((await call("/api/media", "GET", undefined, manager)).status === 403, "get-denied");
    check((await call("/api/media/1", "GET", undefined, manager)).status === 403, "one-denied");
    check((await call("/api/media", "GET", undefined, reader)).status === 200, "get-permitted");
    check((await upload(`x-${suffix}.png`, imagePng, "image/png", {})).status === 403, "post-anon");
    check((await upload(`x-${suffix}.png`, imagePng, "image/png", reader)).status === 403, "post");
    check((await call("/api/media/1", "DELETE", undefined, reader)).status === 403, "del-denied");
    const managed = await upload(`managed-${suffix}.png`, imagePng, "image/png", manager);
    check(managed.status === 200, "post-permitted");
    keep(managed.body.data);

    // Upload, with its envelope and values.
    const name = `photo-${suffix}.png`;
    const image = keep(await stored(name));
    check(
      JSON.stringify(Object.keys(image).sort()) ===
        JSON.stringify(
          [
            "content_type",
            "created_at",
            "filename",
            "id",
            "meta",
            "provider",
            "thumb_url",
            "url",
            "uuid",
          ].sort(),
        ),
      `shape-${Object.keys(image)}`,
    );
    check(image.filename === name, "filename");
    check(image.content_type === "image/png", "content-type");
    check(image.provider === "filesystem", "provider");
    check(/^[0-9a-f-]{36}$/.test(image.uuid), "uuid");
    check(!Number.isNaN(Date.parse(image.created_at)), "created-at");
    check(
      image.meta.width === imagePngSize.width && image.meta.height === imagePngSize.height,
      `meta-${JSON.stringify(image.meta)}`,
    );
    check(new URL(image.url).pathname === `/uploads/${name}`, `url-${image.url}`);
    if (reference) check(image.thumb_url.endsWith(`/uploads/thumb_${name}`), "thumb-url");
    else check(image.thumb_url === image.url, "thumb-url");
    check(new URL(image.url).origin === originals["app.root_url"], "url-root");

    // Names made safe and unique.
    const spaced = keep(await stored(`  my photo ${suffix}.png `));
    check(spaced.filename === `my-photo-${suffix}.png`, `spaces-${spaced.filename}`);
    const twin = keep(await stored(name));
    check(
      new RegExp(`^photo-${suffix}_[0-9A-Za-z]{6}\\.png$`).test(twin.filename),
      `unique-${twin.filename}`,
    );

    // Other kinds of file.
    const gif = keep(await stored(`anim-${suffix}.gif`, imageGif, "image/gif"));
    check(gif.meta.width === 2 && gif.meta.height === 1, "gif-meta");
    const jpeg = keep(await stored(`shot-${suffix}.JPG`, imageJpeg, "image/jpeg"));
    check(
      jpeg.meta.width === 1 && jpeg.meta.height === 1,
      `jpeg-meta-${JSON.stringify(jpeg.meta)}`,
    );
    const text = keep(await stored(`notes-${suffix}.txt`, "plain notes", "text/plain"));
    check(text.thumb_url === null, "text-thumb");
    check(JSON.stringify(text.meta) === "{}", "text-meta");
    const svgSource = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>`;
    const svg = keep(await stored(`vector-${suffix}.svg`, svgSource, "image/svg+xml"));
    check(svg.thumb_url === svg.url, "svg-thumb");
    check(JSON.stringify(svg.meta) === "{}", "svg-meta");

    // Extensions.
    await setting("upload.extensions", ["png"]);
    const refused = await upload(`tool-${suffix}.exe`, "MZ", "application/octet-stream");
    check(refused.status === 400, `extension-${refused.status}`);
    check(refused.body.message === "Unsupported file type (exe)", "extension-message");
    check((await upload(`upper-${suffix}.PNG`)).status === 200, "extension-case");
    created.push((await call(`/api/media?query=upper-${suffix}`)).body.data.results[0].id);
    await setting("upload.extensions", ["*"]);
    keep(await stored(`tool-${suffix}.exe`, "MZ", "application/octet-stream"));

    // Malformed.
    check((await call("/api/media", "POST", { file: 1 })).status === 400, "not-multipart");
    const wrong = await call(
      "/api/media",
      "POST",
      form(`w-${suffix}.png`, imagePng, "image/png", "x"),
    );
    check(wrong.status === 400, "wrong-field");

    // Reads.
    const found = await call(`/api/media/${image.id}`);
    check(found.status === 200, "one");
    check(found.body.data.url === image.url && found.body.data.id === image.id, "one-values");
    check(JSON.stringify(found.body.data.meta) === JSON.stringify(image.meta), "one-meta");
    check((await call("/api/media/999999999")).status === 404, "one-missing");
    check((await call("/api/media/abc")).status === 400, "one-invalid");
    const all = (await call(`/api/media?query=${suffix}&per_page=2`)).body.data;
    check(all.results.length === 2 && all.per_page === 2 && all.page === 1, "page");
    check(all.total === created.length, `total-${all.total}-${created.length}`);
    check("search" in all && "query" in all, "page-fields");
    const second = (await call(`/api/media?query=${suffix}&per_page=2&page=2`)).body.data;
    check(second.page === 2 && second.results[0].id !== all.results[0].id, "second-page");
    const cased = (await call(`/api/media?query=PHOTO-${suffix.toUpperCase()}`)).body.data;
    check(cased.results.length === 3, `query-case-${cased.results.length}`);
    const none = (await call("/api/media?query=no-such-file-at-all&page=3&per_page=5")).body.data;
    check(none.total === 0 && JSON.stringify(none.results) === "[]", "none");
    check(none.page === 3 && none.per_page === 5, `none-page-${none.page}-${none.per_page}`);
    const defaults = (await call("/api/media")).body.data;
    check(defaults.per_page === 20 && defaults.page === 1, "defaults");

    // Serving is public.
    const file = await served(image.url);
    check(file.status === 200, `serve-${file.status}`);
    check(file.headers.get("content-type") === "image/png", "serve-type");
    check(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(imagePng)), "serve-bytes");
    const head = await served(image.url, { method: "HEAD" });
    if (!reference) check(head.status === 200, `head-${head.status}`);
    check((await served(image.thumb_url)).status === 200, "serve-thumb");
    check((await served(`${image.url}.missing`)).status === 404, "serve-missing");
    check(
      (await served(svg.url)).headers.get("content-type")?.startsWith("image/svg+xml"),
      "svg-type",
    );

    // Deletion keeps the campaign's shape.
    const attached = keep(await stored(`brochure-${suffix}.png`));
    const list = await call("/api/lists", "POST", {
      name: `media-${suffix}`,
      type: "private",
      optin: "single",
    });
    const campaign = await call("/api/campaigns", "POST", {
      name: `media-${suffix}`,
      subject: "Media subject",
      lists: [list.body.data.id],
      content_type: "plain",
      type: "regular",
      messenger: "email",
      body: "Body",
      media: [attached.id],
    });
    check(campaign.status === 200, "campaign");
    check(
      JSON.stringify(campaign.body.data.media) ===
        JSON.stringify([{ id: attached.id, filename: attached.filename }]),
      `campaign-media-${JSON.stringify(campaign.body.data.media)}`,
    );
    const deleted = await call(`/api/media/${attached.id}`, "DELETE");
    check(deleted.status === 200 && deleted.body.data === true, "delete");
    created.splice(created.indexOf(attached.id), 1);
    check((await call(`/api/media/${attached.id}`)).status === 404, "deleted-row");
    check((await served(attached.url)).status === 404, "deleted-file");
    const kept = await call(`/api/campaigns/${campaign.body.data.id}`);
    check(
      JSON.stringify(kept.body.data.media) ===
        JSON.stringify([{ id: null, filename: attached.filename }]),
      `campaign-after-${JSON.stringify(kept.body.data.media)}`,
    );
    await call(`/api/campaigns/${campaign.body.data.id}`, "DELETE");
    await call(`/api/lists/${list.body.data.id}`, "DELETE");
    const missing = await call("/api/media/999999999", "DELETE");
    // Upstream answers its generic creation error; a missing row is simply not found here.
    check(missing.status === (reference ? 500 : 404), `delete-missing-${missing.status}`);

    if (reference) return;
    const dataDir = target.dataDir!;
    const uploads = join(dataDir, "uploads");
    const raw = (path: string, init?: RequestInit) =>
      fetch(new URL(path, target.baseUrl), { redirect: "manual", ...init });
    const temporary = ".iglo-email-uploading";
    const names = () => readdirSync(uploads).sort();

    // Paths stay inside the upload directory.
    await Bun.write(join(dataDir, "secret.txt"), "secret");
    for (const hostile of [
      "../secret.txt",
      "../../secret.txt",
      "/etc/passwd",
      "..\\..\\secret.txt",
      `sub/../../secret-${suffix}.txt`,
    ]) {
      const item = keep(await stored(hostile, "x", "text/plain"));
      check(
        !/[/\\]/.test(item.filename) && !item.filename.startsWith("."),
        `name-${item.filename}`,
      );
      check(lstatSync(join(uploads, item.filename)).isFile(), "name-stored");
    }
    const encoded = keep(await stored(`..%2f..%2fencoded-${suffix}.txt`, "x", "text/plain"));
    check((await served(encoded.url)).status === 200, "encoded-name-served");
    check(
      names().every((entry) => !entry.includes("/")),
      "flat",
    );
    for (const path of [
      "/uploads/..%2fsecret.txt",
      "/uploads/..%2F..%2Fsecret.txt",
      "/uploads/%2e%2e/secret.txt",
      "/uploads/..%5csecret.txt",
      "/uploads/%2e%2e%2fsecret.txt",
      "/uploads/.iglo-email-uploading",
      "/uploads/.iglo-email-uploading/x",
      "/uploads/",
      "/uploads/%00",
    ]) {
      const response = await raw(path);
      check(response.status === 404, `path-${path}-${response.status}`);
      check(!(await response.text()).includes("secret"), `path-body-${path}`);
    }
    symlinkSync(join(dataDir, "secret.txt"), join(uploads, `link-${suffix}.txt`));
    check((await raw(`/uploads/link-${suffix}.txt`)).status === 404, "symlink-served");
    // An existing symlink is not written through, and takes a suffixed name.
    const beside = keep(await stored(`link-${suffix}.txt`, "replaced", "text/plain"));
    check(beside.filename !== `link-${suffix}.txt`, "symlink-name");
    check((await Bun.file(join(dataDir, "secret.txt")).text()) === "secret", "symlink-write");

    // Upload size. A refused body leaves nothing behind.
    const before = names();
    const large = new Uint8Array(25 * 1024 * 1024 + 1);
    const oversized = await upload(`large-${suffix}.png`, large).catch(() => null);
    check(oversized === null || oversized.status === 413, `oversized-${oversized?.status}`);
    const chunked = await fetch(`${target.baseUrl}/api/media`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "multipart/form-data; boundary=x",
      },
      body: new Blob([large, new Uint8Array(1024 * 1024)]).stream(),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    check(chunked === null || chunked.status === 413, `chunked-${chunked?.status}`);
    const exact = await upload(`exact-${suffix}.bin`, new Uint8Array(25 * 1024 * 1024));
    check(exact.status === 200, `exact-${exact.status}`);
    check(lstatSync(join(uploads, exact.body.data.filename)).size === 25 * 1024 * 1024, "exact");
    keep(exact.body.data);
    check(
      JSON.stringify(names().filter((entry) => entry !== exact.body.data.filename)) ===
        JSON.stringify(before),
      "oversized-left-files",
    );
    check(readdirSync(join(uploads, temporary)).length === 0, "temporary-left");

    // Files cannot run as this origin.
    const script = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>`;
    const scripted = keep(await stored(`script-${suffix}.svg`, script, "image/svg+xml"));
    const shown = await served(scripted.url);
    check(shown.status === 200 && shown.headers.get("content-type") === "image/svg+xml", "svg");
    check(/(^|;\s*)sandbox/.test(shown.headers.get("content-security-policy") ?? ""), "svg-csp");
    check(/default-src 'none'/.test(shown.headers.get("content-security-policy")!), "svg-default");
    check(shown.headers.get("x-content-type-options") === "nosniff", "svg-nosniff");
    const page = keep(await stored(`page-${suffix}.html`, "<script>1</script>", "image/png"));
    const opened = await served(page.url);
    check(opened.headers.get("content-disposition")?.startsWith("attachment"), "html-attachment");
    check(/sandbox/.test(opened.headers.get("content-security-policy") ?? ""), "html-csp");
    check(opened.headers.get("content-type")?.startsWith("text/html"), "html-type");
    // Not a script the admin's `script-src 'self'` would run (D71).
    const code = keep(await stored(`code-${suffix}.js`, "globalThis.ran = 1", "image/png"));
    const codeFile = await served(code.url);
    check(codeFile.headers.get("content-type") === "application/octet-stream", "script-type");
    check(codeFile.headers.get("x-content-type-options") === "nosniff", "script-nosniff");
    const lying = keep(await stored(`claims-${suffix}.png`, "<script>1</script>", "text/html"));
    check((await served(lying.url)).headers.get("content-type") === "image/png", "stored-type");
    const unknown = keep(await stored(`data-${suffix}.zzz`, "<script>1</script>", "text/html"));
    check((await served(unknown.url)).headers.get("content-disposition"), "unknown-attachment");
    const upper = keep(await stored(`CAMERA-${suffix}.JPG`, imageJpeg, "image/jpeg"));
    const camera = await served(upper.url);
    check(camera.headers.get("content-type") === "image/jpeg", "upper-type");
    check(!camera.headers.get("content-disposition"), "upper-inline");

    // Caching.
    const cached = await served(image.url);
    check(cached.headers.get("cache-control")?.includes("max-age"), "cache-control");
    const tag = cached.headers.get("etag")!;
    const again = await served(image.url, { headers: { "if-none-match": tag } });
    check(again.status === 304, `not-modified-${again.status}`);

    // Settings apply live, and an upload URI cannot shadow the application.
    await setting("upload.filesystem.upload_uri", "/files/");
    const moved = (await call(`/api/media/${image.id}`)).body.data;
    check(new URL(moved.url).pathname === `/files/${name}`, `moved-${moved.url}`);
    check((await served(moved.url)).status === 200, "moved-served");
    check((await raw(`/uploads/${name}`)).status === 404, "moved-old");
    await setting("upload.filesystem.upload_uri", "/api");
    check((await call("/api/media")).status === 200, "reserved-uri");
    await setting("upload.filesystem.upload_uri", "/uploads");
    // The upload directory is inside the data directory, and only stored media is served.
    const uploadPath = "/api/settings/upload.filesystem.upload_path";
    const moveTo = (path: string) => call(uploadPath, "PUT", path);
    await Bun.write(join(uploads, `unlisted-${suffix}.txt`), "unlisted");
    check((await raw(`/uploads/unlisted-${suffix}.txt`)).status === 404, "unlisted-served");
    symlinkSync(dataDir, join(dataDir, "data-alias"));
    for (const path of ["data-alias", ".", "..", "/", dataDir, "/tmp"]) {
      const refusal = await moveTo(path);
      check(refusal.status === 400, `upload-path-${path}-${refusal.status}`);
      check(refusal.body.message.includes("data directory"), `upload-path-message-${path}`);
      check((await raw("/uploads/iglo-email.db")).status === 404, `database-served-${path}`);
    }
    // A row has one location: the directory cannot change under it.
    const populated = await moveTo("custom/place");
    check(populated.status === 400, `upload-path-populated-${populated.status}`);
    check(populated.body.message.includes("media"), "upload-path-reason");
    check((await moveTo("uploads")).status === 200, "upload-path-unchanged");
    const everything = (await call("/api/settings")).body.data;
    check((await call("/api/settings", "PUT", everything)).status === 200, "settings-round-trip");
    check((await served(image.url)).status === 200, "upload-path-kept");

    // S3 is refused and its settings stay.
    const s3 = { "upload.s3.bucket": `bucket-${suffix}`, "upload.provider": "s3" };
    for (const [key, value] of Object.entries(s3)) await setting(key, value);
    const refusedS3 = await upload(`s3-${suffix}.png`);
    check(refusedS3.status === 400, `s3-upload-${refusedS3.status}`);
    check(
      names().every((entry) => !entry.startsWith("s3-")),
      "s3-left",
    );
    check((await raw(`/uploads/${name}`)).status === 404, "s3-serve");
    check((await call("/api/settings")).body.data["upload.s3.bucket"] === `bucket-${suffix}`, "s3");
    await setting("upload.provider", "filesystem");
    await setting("upload.s3.bucket", "");

    // An interrupted upload's temporary file goes at startup, and files survive a restart.
    const stale = join(uploads, temporary, crypto.randomUUID());
    const operator = join(uploads, ".tmp/operator-owned");
    await Bun.write(stale, "partial");
    await Bun.write(operator, "theirs");
    await target.restart!();
    check(!existsSync(stale), "stale-temporary");
    check(existsSync(operator), "operator-directory");
    check((await served(image.url)).status === 200, "restart-serve");

    // A refused directory takes media down and nothing else, so the operator keeps a way in.
    const elsewhere = `${dataDir}-elsewhere`;
    renameSync(uploads, elsewhere);
    symlinkSync(elsewhere, uploads);
    try {
      await target.restart!();
      check((await fetch(`${target.baseUrl}/health`)).status === 200, "refused-health");
      check((await served(image.url)).status === 404, "refused-serve");
      const refused = await upload(`refused-${suffix}.png`);
      check(refused.status === 503, `refused-upload-${refused.status}`);
      check(refused.body.message.includes("data directory"), "refused-reason");
      check((await call("/api/media")).status === 200, "refused-listing");
      const list = await call("/api/lists", "POST", {
        name: `Refused ${suffix}`,
        type: "public",
        optin: "single",
      });
      check(list.status === 200, `refused-list-${list.status}`);
      check((await call(`/api/lists/${list.body.data.id}`, "DELETE")).status === 200, "list-gone");
      const settings = (await call("/api/settings")).body.data;
      check((await call("/api/settings", "PUT", settings)).status === 200, "refused-settings");
    } finally {
      rmSync(uploads);
      renameSync(elsewhere, uploads);
    }
    await target.restart!();
    check((await served(image.url)).status === 200, "recovered-serve");
  } finally {
    for (const id of created) await call(`/api/media/${id}`, "DELETE");
    for (const id of users) await call(`/api/users/${id}`, "DELETE");
    for (const id of roles) await call(`/api/roles/users/${id}`, "DELETE");
    await call("/api/settings/upload.extensions", "PUT", originals["upload.extensions"]);
  }
}

if (import.meta.main) {
  try {
    if (process.argv[2] !== "reference") throw new Error("Invalid mode");
    const {
      REFERENCE_URL: baseUrl,
      REFERENCE_API_USER: user,
      REFERENCE_API_TOKEN: token,
    } = process.env;
    if (!baseUrl || !user || !token) throw new Error("Missing reference credentials");
    await runMediaContract({ mode: "reference", baseUrl, credentials: { user, token } });
    process.stdout.write("PASS media reference contract\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [^\n]+$/.test(error.message) ? error.message : `Media contract failed: ${error}`}\n`,
    );
    process.exitCode = 1;
  }
}
