// M1.9 behavior through HTTP on a real server process: CSV corners, limits, and what a stop, a
// shutdown or a crash leaves. The corpus shared with upstream is in test/contract/import.ts.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { provisionApiUser } from "@/test/contract/owned";

const repository = resolve(import.meta.dir, "../..");
const admin = { user: "fixture-admin", password: "fixture-admin-password" };
const TEMPORARY = ".iglo-email-import";
const directories: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "iglo-import-"));
  directories.push(directory);
  return directory;
}
async function serve(dataDir: string) {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  const child = Bun.spawn(
    [
      process.execPath,
      "src/main.ts",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--data-dir",
      dataDir,
    ],
    {
      cwd: repository,
      env: {
        PATH: process.env.PATH ?? "",
        IGLO_EMAIL_ADMIN_USER: admin.user,
        IGLO_EMAIL_ADMIN_PASSWORD: admin.password,
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  children.push(child);
  const origin = `http://127.0.0.1:${port}`;
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await Bun.sleep(25)) {
    const up = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) }).catch(
      () => null,
    );
    if (up?.ok) return { child, origin };
  }
  throw new Error("Server did not start");
}
async function client(origin: string, credentials?: { user: string; token: string }) {
  const { user, token } = credentials ?? (await provisionApiUser(origin, admin));
  const authorization = `Basic ${btoa(`${user}:${token}`)}`;
  const call = async (path: string, method = "GET", body?: unknown) => {
    const form = body instanceof FormData;
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization,
        ...(body === undefined || form ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: form ? (body as FormData) : JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
  };
  const post = (params: unknown, content: BlobPart, name = "file.csv") => {
    const data = new FormData();
    data.append("params", JSON.stringify(params));
    data.append("file", new File([content], name));
    return call("/api/import/subscribers", "POST", data);
  };
  const status = async () => (await call("/api/import/subscribers")).body.data;
  const settled = async () => {
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; await Bun.sleep(10)) {
      const current = await status();
      if (current.status === "finished" || current.status === "failed") return current;
    }
    throw new Error("Import did not settle");
  };
  const run = async (params: unknown, content: BlobPart, name?: string) => {
    const started = await post(params, content, name);
    expect(started.status).toBe(200);
    const done = await settled();
    const log = (await call("/api/import/subscribers/logs")).body.data as string;
    await call("/api/import/subscribers", "DELETE");
    return { ...done, log };
  };
  const list = async (name: string) =>
    (await call("/api/lists", "POST", { name })).body.data.id as number;
  const subscriber = async (email: string) => {
    const query = encodeURIComponent(`subscribers.email = '${email}'`);
    return (await call(`/api/subscribers?query=${query}`)).body.data.results[0];
  };
  const subscribers = async () => (await call("/api/subscribers?per_page=1")).body.data.total;
  return { authorization, call, post, status, settled, run, list, subscriber, subscribers };
}
const rows = (label: string, count: number) =>
  `email\n${Array.from({ length: count }, (_, i) => `${label}${i}@example.test\n`).join("")}`;

afterEach(async () => {
  for (const child of children.splice(2)) {
    child.kill("SIGKILL");
    await child.exited;
  }
});
afterAll(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("one server", () => {
  let c: Awaited<ReturnType<typeof client>>;
  let origin: string;
  let dataDir: string;
  let lists: number;
  const subscribe = (extra: Record<string, unknown> = {}) => ({
    mode: "subscribe",
    delim: ",",
    lists: [lists],
    ...extra,
  });
  const leftovers = () => readdirSync(join(dataDir, TEMPORARY));
  beforeAll(async () => {
    dataDir = temporary();
    ({ origin } = await serve(dataDir));
    c = await client(origin);
    lists = await c.list("import-tests");
  });

  test("Go's CSV rules: quotes, line breaks and the last line", async () => {
    const done = await c.run(
      subscribe(),
      `email,name\r\n"a@example.test","two\r\nlines"\r\nb@example.test,"say ""hi"""\nc@example.test,bare\rcr\r\nd@example.test,last`,
    );
    expect(done).toMatchObject({ status: "finished", imported: 4, total: 5 });
    expect((await c.subscriber("a@example.test")).name).toBe("two\nlines");
    expect((await c.subscriber("b@example.test")).name).toBe('say "hi"');
    expect((await c.subscriber("c@example.test")).name).toBe("bare\rcr");
    expect((await c.subscriber("d@example.test")).name).toBe("last");
  });

  test("a header alone finishes with nothing, and a column name is case-sensitive", async () => {
    expect(await c.run(subscribe(), "email,name\n")).toMatchObject({
      status: "finished",
      total: 0,
      imported: 0,
    });
    const wrong = await c.run(subscribe(), "Email\nx@example.test\n");
    expect(wrong.status).toBe("failed");
    expect(wrong.log).toContain("'email' column not found");
  });

  test("text after a closing quote and an unusable delimiter fail the file", async () => {
    const quote = await c.run(subscribe(), `email,name\nq@example.test,"a"b\n`);
    expect(quote.status).toBe("failed");
    expect(quote.log).toContain("parse error on line 2");
    expect((await c.run(subscribe({ delim: '"' }), "email\n")).status).toBe("failed");
    expect((await c.run(subscribe({ delim: "\n" }), "email\n")).status).toBe("failed");
  });

  test("a bad file writes nothing, even after good rows", async () => {
    const before = await c.subscribers();
    const failed = await c.run(subscribe(), `${rows("early", 1200)}late@example.test,"open\n`);
    expect(failed).toMatchObject({ status: "failed", imported: 0 });
    expect(await c.subscribers()).toBe(before);
  });

  test("a record over the limit fails the file instead of filling memory", async () => {
    const failed = await c.run(subscribe(), `email,name\nbig@example.test,"${"x".repeat(1100000)}`);
    expect(failed.status).toBe("failed");
    expect(failed.log).toContain("record over");
  });

  test("empty fields cannot fill memory: a sparse record or header fails the file", async () => {
    const before = await c.subscribers();
    const commas = ",".repeat(2 * 1024 * 1024);
    const record = await c.run(subscribe(), `email\nsparse-row@example.test\n${commas}\n`);
    expect(record).toMatchObject({ status: "failed", imported: 0 });
    expect(record.log).toContain("record over");
    const header = await c.run(subscribe(), `email${commas}\nsparse-head@example.test\n`);
    expect(header).toMatchObject({ status: "failed", imported: 0 });
    expect(header.log).toContain("record over");
    expect(await c.subscribers()).toBe(before);
  });

  test("a wide file up to the column limit still imports", async () => {
    const done = await c.run(
      subscribe(),
      `email${",".repeat(16_383)}\nwide@example.test${",".repeat(16_383)}\n`,
    );
    expect(done).toMatchObject({ status: "finished", imported: 1 });
  });

  test("attributes obey the API's rules and size", async () => {
    const big = JSON.stringify({ v: "x".repeat(70_000) }).replaceAll('"', '""');
    const deep = `${'{""a"":'.repeat(1100)}1${"}".repeat(1100)}`;
    const done = await c.run(
      subscribe(),
      [
        "email,attributes",
        `big-attr@example.test,"${big}"`,
        `inf-attr@example.test,"{""n"":1e999}"`,
        `nul-attr@example.test,"{""n"":""a\\u0000b""}"`,
        `deep-attr@example.test,"${deep}"`,
        `null-attr@example.test,null`,
        `fine-attr@example.test,"{""n"":{""m"":[1,2]}}"`,
        "",
      ].join("\n"),
    );
    expect(done).toMatchObject({ status: "finished", imported: 6 });
    expect(done.log.match(/skipping invalid attributes JSON/g)).toHaveLength(4);
    for (const label of ["big", "inf", "nul", "deep", "null"])
      expect((await c.subscriber(`${label}-attr@example.test`)).attribs).toEqual({});
    expect((await c.subscriber("fine-attr@example.test")).attribs).toEqual({ n: { m: [1, 2] } });
  });

  test("the log keeps no personal data, before or after a wipe", async () => {
    const person = "kept-out@example.test";
    const created = await c.call("/api/subscribers", "POST", {
      email: person,
      name: "Existing",
      lists: [lists],
    });
    expect(created.status).toBe(200);
    expect((await c.call("/api/settings/privacy.allow_wipe", "PUT", true)).status).toBe(200);
    expect(
      (await c.call("/api/settings/privacy.domain_blocklist", "PUT", ["kept-out.test"])).status,
    ).toBe(200);
    const leaks = /kept-out|Private Name|privatevalue/;
    const longName = `Private Name ${"n".repeat(2000)}`;
    const content = Buffer.concat([
      Buffer.from(
        [
          "email,name,attributes",
          `not-an-address-kept-out,Private Name,`,
          `kept-out@kept-out.test,Private Name,`,
          `${person},${longName},`,
          `${person},Private Name`,
          `${person},Private Name,{privatevalue}`,
          `${person},Private Name,"{""n"":""private\\u0000value""}"`,
          `kept-out-binary@example.test,Private Name `,
        ].join("\n"),
      ),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(",\n"),
    ]);
    expect((await c.post(subscribe(), content)).status).toBe(200);
    expect((await c.settled()).status).toBe("finished");
    const logs = async () => (await c.call("/api/import/subscribers/logs")).body.data as string;
    const before = await logs();
    expect(before).toContain("skipping line 7");
    expect(before).toContain("skipping invalid attributes JSON on line 5");
    expect(before).not.toMatch(leaks);
    const { uuid } = await c.subscriber(person);
    const wiped = await fetch(`${origin}/subscription/wipe/${uuid}`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(wiped.status).toBe(200);
    expect(await c.subscriber(person)).toBeUndefined();
    expect(await logs()).not.toMatch(leaks);
    await c.call("/api/import/subscribers", "DELETE");
    await c.call("/api/settings/privacy.domain_blocklist", "PUT", []);
    // A file with no header row puts its first address where a column name belongs.
    const headerless = await c.run(subscribe(), `${person},Private Name\n`);
    expect(headerless.status).toBe("failed");
    expect(headerless.log).toContain("'email' column not found");
    expect(headerless.log).not.toMatch(leaks);
  });

  test("a long name is a bad row", async () => {
    const done = await c.run(subscribe(), `email,name\nlong@example.test,${"n".repeat(2001)}\n`);
    expect(done).toMatchObject({ status: "finished", imported: 0 });
    expect(done.log).toContain("Invalid name");
  });

  test("the domain settings apply to each row", async () => {
    const set = (value: string[]) => c.call("/api/settings/privacy.domain_blocklist", "PUT", value);
    expect((await set(["blocked.test"])).status).toBe(200);
    try {
      const done = await c.run(subscribe(), "email\nno@blocked.test\nyes@allowed.test\n");
      expect(done).toMatchObject({ status: "finished", imported: 1 });
      expect(done.log).toContain("skipping line 1");
    } finally {
      await set([]);
    }
  });

  test("a list that does not exist fails the import and writes nothing", async () => {
    const before = await c.subscribers();
    const failed = await c.run(subscribe({ lists: [999_999] }), "email\nghost@example.test\n");
    expect(failed).toMatchObject({ status: "failed", imported: 0 });
    expect(await c.subscribers()).toBe(before);
  });

  test("the list's date moves when an import finishes", async () => {
    const id = await c.list("import-date");
    const before = (await c.call(`/api/lists/${id}`)).body.data.updated_at;
    await Bun.sleep(5);
    await c.run(subscribe({ lists: [id] }), "email\ndated@example.test\n");
    expect((await c.call(`/api/lists/${id}`)).body.data.updated_at > before).toBe(true);
  });

  test("the log keeps its end when a file has more bad rows than it holds", async () => {
    const bad = `email,name\n${"not-an-email,x\n".repeat(60_000)}`.replaceAll(
      "x\n",
      `${"y".repeat(100)}\n`,
    );
    const done = await c.run(subscribe(), bad);
    expect(done.status).toBe("finished");
    expect(done.log.length).toBeLessThanOrEqual(1024 * 1024);
    expect(done.log).toContain("skipping line 60000");
    expect(done.log).toContain("imported finished");
  });

  test("a broken form is refused and leaves no file", async () => {
    const call = (headers: Record<string, string>, body: BodyInit) =>
      fetch(`${origin}/api/import/subscribers`, {
        method: "POST",
        headers: { authorization: c.authorization, ...headers },
        body,
      });
    const truncated = await call(
      { "content-type": "multipart/form-data; boundary=x" },
      `--x\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\nemail\n`,
    );
    expect(truncated.status).toBe(400);
    expect((await truncated.json()).message).toContain("Invalid params");
    const noBoundary = await call({ "content-type": "multipart/form-data" }, "x");
    expect(noBoundary.status).toBe(400);
    const json = await call({ "content-type": "application/json" }, "{}");
    expect(json.status).toBe(400);
    expect(leftovers()).toEqual([]);
    expect((await c.status()).status).toBe("none");
  });

  test("parts may come in any order, with other fields around them", async () => {
    const boundary = "----import";
    const body = [
      `--${boundary}\r\nContent-Disposition: form-data; name="other"\r\n\r\nignored`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dir/parts.csv"\r\n` +
        `Content-Type: text/csv\r\n\r\nemail\r\nparts@example.test\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="params"\r\n\r\n` +
        JSON.stringify(subscribe()),
      `--${boundary}--\r\n`,
    ].join("\r\n");
    const response = await fetch(`${origin}/api/import/subscribers`, {
      method: "POST",
      headers: {
        authorization: c.authorization,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(await c.settled()).toMatchObject({ name: "parts.csv", imported: 1 });
    await c.call("/api/import/subscribers", "DELETE");
  });

  test("a boundary split across network chunks is still found", async () => {
    const boundary = "split-boundary";
    const text =
      `--${boundary}\r\nContent-Disposition: form-data; name="params"\r\n\r\n` +
      `${JSON.stringify(subscribe())}\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="split.csv"\r\n\r\n` +
      `email\nsplit@example.test\n\r\n--${boundary}--\r\n`;
    const bytes = new TextEncoder().encode(text);
    let at = 0;
    const response = await fetch(`${origin}/api/import/subscribers`, {
      method: "POST",
      headers: {
        authorization: c.authorization,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: new ReadableStream({
        async pull(controller) {
          if (at >= bytes.length) return controller.close();
          controller.enqueue(bytes.subarray(at, at + 7));
          at += 7;
          await Bun.sleep(0);
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await c.settled()).toMatchObject({ name: "split.csv", imported: 1 });
    await c.call("/api/import/subscribers", "DELETE");
  });

  test("one upload at a time, and an abandoned one gives its place back", async () => {
    const abort = new AbortController();
    const held = new TransformStream<Uint8Array>();
    const writer = held.writable.getWriter();
    const first = fetch(`${origin}/api/import/subscribers`, {
      method: "POST",
      headers: {
        authorization: c.authorization,
        "content-type": "multipart/form-data; boundary=x",
      },
      body: held.readable,
      signal: abort.signal,
    }).catch(() => null);
    await writer.write(
      new TextEncoder().encode(
        `--x\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\nemail\n`,
      ),
    );
    await Bun.sleep(100);
    expect(leftovers()).toHaveLength(1);
    const second = await c.post(subscribe(), "email\n");
    expect(second.status).toBe(400);
    expect(second.body.message).toContain("already running");
    abort.abort();
    await first;
    for (const deadline = Date.now() + 5000; Date.now() < deadline; await Bun.sleep(20))
      if (!leftovers().length) break;
    expect(leftovers()).toEqual([]);
    expect((await c.run(subscribe(), "email\nafter-abort@example.test\n")).imported).toBe(1);
  });

  test("the temporary file goes on finish, stop and failure", async () => {
    await c.run(subscribe(), "email\ntemp1@example.test\n");
    expect(leftovers()).toEqual([]);
    await c.run(subscribe(), "name\nA\n");
    expect(leftovers()).toEqual([]);
    expect((await c.post(subscribe(), rows("temp-stop", 3000))).status).toBe(200);
    await c.call("/api/import/subscribers", "DELETE");
    await c.settled();
    await c.call("/api/import/subscribers", "DELETE");
    expect(leftovers()).toEqual([]);
  });

  test("a stop lands between batches: the count and the rows agree", async () => {
    const before = await c.subscribers();
    expect((await c.post(subscribe(), rows("between", 20_000))).status).toBe(200);
    for (let current = await c.status(); current.imported < 300; current = await c.status())
      await Bun.sleep(1);
    await c.call("/api/import/subscribers", "DELETE");
    const done = await c.settled();
    expect(done.status).toBe("finished");
    expect(done.imported % 100).toBe(0);
    expect(done.imported).toBeLessThan(20_000);
    expect((await c.subscribers()) - before).toBe(done.imported);
    await c.call("/api/import/subscribers", "DELETE");
  });
});

describe("process lifecycle", () => {
  const subscribe = (lists: number) => ({ mode: "subscribe", delim: ",", lists: [lists] });
  const running = async (dataDir: string) => {
    const { child, origin } = await serve(dataDir);
    const c = await client(origin);
    const lists = await c.list("lifecycle");
    expect((await c.post(subscribe(lists), rows("life", 30_000))).status).toBe(200);
    for (let current = await c.status(); current.imported < 100; current = await c.status())
      await Bun.sleep(1);
    return { child, c };
  };

  test("SIGTERM stops an import between batches and the next start is clean", async () => {
    const dataDir = temporary();
    const { child, c } = await running(dataDir);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(readdirSync(join(dataDir, TEMPORARY))).toEqual([]);
    const next = await serve(dataDir);
    const again = await client(next.origin, {
      user: "m13-contract-api",
      token: tokenOf(c),
    });
    expect(await again.status()).toEqual({ name: "", total: 0, imported: 0, status: "none" });
    expect((await again.subscribers()) % 100).toBe(0);
  });

  test("after a crash nothing resumes and the sweep removes the upload", async () => {
    const dataDir = temporary();
    const { child, c } = await running(dataDir);
    child.kill("SIGKILL");
    await child.exited;
    expect(readdirSync(join(dataDir, TEMPORARY))).toHaveLength(1);
    const next = await serve(dataDir);
    expect(readdirSync(join(dataDir, TEMPORARY))).toEqual([]);
    const again = await client(next.origin, {
      user: "m13-contract-api",
      token: tokenOf(c),
    });
    expect((await again.status()).status).toBe("none");
    const count = await again.subscribers();
    expect(count % 100).toBe(0);
    await Bun.sleep(200);
    expect(await again.subscribers()).toBe(count);
  });
});

/** The API token survives a restart; the first client read it once. */
const tokenOf = (c: Awaited<ReturnType<typeof client>>) =>
  atob(c.authorization.slice("Basic ".length)).split(":")[1]!;
