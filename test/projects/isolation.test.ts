// B138b (14-projects sections 2, 6, 9, 14 invariant 1, 15): three projects in one compiled
// executable, registered through src/projects before it starts: the primary on the instance host
// (127.0.0.1), `a` and `b` on their own hostnames. Each project's credentials, rows, mail, logs and
// health stay its own, and a host no project claims reaches only the primary.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { connect } from "node:net";
import { join } from "node:path";
import {
  adminCredentials,
  api,
  createApiUser,
  logIn,
  prepareExecutable,
  registerProjects,
  request,
  startInstance,
} from "@/test/projects/fixture";
import type { Credentials, Session } from "@/test/projects/fixture";
import { asBody } from "@/test/read-body";
import { startSink } from "@/test/tx/sink";
import { untilState } from "@/test/wait";

setDefaultTimeout(30_000);

const PRIMARY = "127.0.0.1";
const A = "a.example.test";
const B = "b.example.test";
const UNCLAIMED = "unclaimed.example.test";
const tokenAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const primaryToken = Array.from(
  crypto.getRandomValues(new Uint8Array(48)),
  (byte) => tokenAlphabet[byte % 62],
).join("");
const primaryAuth = `Basic ${btoa(`primary-api:${primaryToken}`)}`;

let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
let server: Awaited<ReturnType<typeof startInstance>>;
let sink: Awaited<ReturnType<typeof startSink>>;
let admin: Credentials;
let port = 0;
const sessions = new Map<string, Session>();
const keys = new Map<string, string>();

const key = (host: string) => keys.get(host) ?? "";
const parse = <T>(text: string) => asBody<T>(JSON.parse(text));

beforeAll(async () => {
  admin = await adminCredentials();
  prepared = await prepareExecutable();
  sink = await startSink();
  const dataDir = join(prepared.directory, "data");
  registerProjects(dataDir, [
    { slug: "main", name: "Main", hostname: PRIMARY, primary: true },
    { slug: "a", name: "A", hostname: A },
    { slug: "b", name: "B", hostname: B },
  ]);
  server = await startInstance(prepared.executable, dataDir, admin, {
    IGLO_EMAIL_API_USER: "primary-api",
    IGLO_EMAIL_API_TOKEN: primaryToken,
  });
  port = server.port;
  keys.set(PRIMARY, primaryAuth);
  for (const [host, name] of [
    [A, "a"],
    [B, "b"],
  ] as const) {
    const session = await logIn(port, host, admin);
    sessions.set(host, session);
    keys.set(host, await createApiUser(port, host, session, `api-${name}`));
  }
  // Each project gets rows named after it.
  for (const [host, name] of [
    [PRIMARY, "main"],
    [A, "a"],
    [B, "b"],
  ] as const) {
    const list = await api(port, host, key(host), "POST", "/api/lists", {
      name: `list-of-${name}`,
      type: "public",
      optin: "single",
    });
    expect(list.status).toBe(200);
    const listId = parse<{ data: { id: number } }>(list.text).data.id;
    const subscriber = await api(port, host, key(host), "POST", "/api/subscribers", {
      email: `someone@${name}.example.test`,
      name: `subscriber-of-${name}`,
      status: "enabled",
      lists: [listId],
      preconfirm_subscriptions: true,
    });
    expect(subscriber.status).toBe(200);
  }
});

afterAll(async () => {
  if (server) {
    await server.stop();
  }
  await sink?.close();
  await prepared?.cleanup();
});

/** One request per route family; each needs a credential before it reads its body. */
const families: ReadonlyArray<[string, string, string, unknown?]> = [
  ["subscribers", "GET", "/api/subscribers"],
  ["lists", "GET", "/api/lists"],
  ["campaigns", "GET", "/api/campaigns"],
  ["templates", "GET", "/api/templates"],
  ["sequences", "GET", "/api/sequences"],
  ["sends", "GET", "/api/sends"],
  ["tx", "POST", "/api/tx", { subscriber_email: "someone@b.example.test", template_id: 1 }],
  ["events", "POST", "/api/subscriber-events", { name: "e", email: "someone@b.example.test" }],
  ["media", "GET", "/api/media"],
  ["webhooks", "GET", "/api/webhooks"],
  ["settings", "GET", "/api/settings"],
  [
    "mcp tools/call",
    "POST",
    "/api/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_lists", arguments: {} },
    },
  ],
];

test("Bun's fetch sends a caller's Host header unchanged", async () => {
  const seen: Array<string | null> = [];
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (incoming) => {
      seen.push(incoming.headers.get("host"));
      return new Response("ok");
    },
  });
  try {
    for (const host of [A, "B.Example.Test:8080", "[::1]:9"]) {
      await fetch(`http://127.0.0.1:${probe.port}/`, { headers: { host } });
    }
  } finally {
    await probe.stop(true);
  }
  expect(seen).toEqual([A, "B.Example.Test:8080", "[::1]:9"]);
});

test("each project's own credential works on its own host for every route family", async () => {
  for (const host of [A, B]) {
    for (const [family, method, path, body] of families.filter(([, method]) => method === "GET")) {
      const response = await api(port, host, key(host), method, path, body);
      expect([family, host, response.status]).toEqual([family, host, 200]);
    }
  }
});

test("A's API credential gets 401 or 403 on B's host for every route family", async () => {
  for (const [family, method, path, body] of families) {
    const response = await api(port, B, key(A), method, path, body);
    expect([family, [401, 403].includes(response.status)]).toEqual([family, true]);
  }
});

test("A's session cookie gets 401 or 403 on B's host, and B's admin asks for a login", async () => {
  const session = sessions.get(A)!;
  for (const [family, method, path, body] of families) {
    const response = await request(port, B, path, {
      method,
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect([family, [401, 403].includes(response.status)]).toEqual([family, true]);
  }
  const page = await request(port, B, "/admin", { headers: { cookie: session.cookie } });
  expect([302, 307]).toContain(page.status);
  expect(page.headers.get("location")).toStartWith("/admin/login");
});

test("B's rows never appear in A's responses, and A's never in B's", async () => {
  for (const [own, other, name, otherName] of [
    [A, B, "a", "b"],
    [B, A, "b", "a"],
  ] as const) {
    for (const path of ["/api/lists", "/api/subscribers"]) {
      const response = await api(port, own, key(own), "GET", path);
      expect(response.status).toBe(200);
      expect(response.text).toContain(`-of-${name}`);
      expect(response.text).not.toContain(`-of-${otherName}`);
      expect(response.text).not.toContain("-of-main");
      expect(response.text).not.toContain(other);
    }
    const mcp = await api(port, own, key(own), "POST", "/api/mcp", families.at(-1)![3]);
    expect(mcp.status).toBe(200);
    expect(mcp.text).toContain(`list-of-${name}`);
    expect(mcp.text).not.toContain(`list-of-${otherName}`);
    // Public pages: the subscription form lists the host's public lists only.
    const form = await request(port, own, "/subscription/form");
    const html = await form.text();
    expect(html).toContain(`list-of-${name}`);
    expect(html).not.toContain(`list-of-${otherName}`);
  }
});

test("an unclaimed host and the instance host reach only the primary project", async () => {
  for (const host of [UNCLAIMED, PRIMARY, `${UNCLAIMED}:8443`, "UNCLAIMED.example.test"]) {
    const lists = await api(port, host, primaryAuth, "GET", "/api/lists");
    expect(lists.status).toBe(200);
    expect(lists.text).toContain("list-of-main");
    expect(lists.text).not.toContain("list-of-a");
    expect([401, 403]).toContain((await api(port, host, key(A), "GET", "/api/lists")).status);
  }
  // The environment's API user belongs to the primary project only (D151).
  expect([401, 403]).toContain((await api(port, A, primaryAuth, "GET", "/api/lists")).status);
  // X-Forwarded-Host never picks a project: the reverse proxy passes Host (14-projects section 2).
  const forwarded = await request(port, UNCLAIMED, "/api/lists", {
    headers: { authorization: key(A), "x-forwarded-host": A },
  });
  expect([401, 403]).toContain(forwarded.status);
});

test("hostnames match without case or port", async () => {
  for (const host of ["A.Example.Test", `${A}:9000`]) {
    const response = await api(port, host, key(A), "GET", "/api/lists");
    expect(response.status).toBe(200);
    expect(response.text).toContain("list-of-a");
  }
});

test("A's mail carries A's hostname in its links and Message-ID", async () => {
  const smtp = {
    enabled: true,
    host: "127.0.0.1",
    port: sink.port,
    auth_protocol: "none",
    username: "",
    password: "",
    tls_type: "none",
    tls_skip_verify: false,
    max_conns: 2,
    max_msg_retries: 0,
    msg_retry_delay: "10ms",
    idle_timeout: "15s",
    wait_timeout: "5s",
    hello_hostname: "",
    name: "",
    from_addresses: [],
    email_headers: [],
    exclude_from_default: false,
  };
  const current = parse<{ data: Record<string, unknown> }>(
    (await api(port, A, key(A), "GET", "/api/settings")).text,
  );
  expect(current.data["app.root_url"]).toBe(`http://${A}`);
  const saved = await api(port, A, key(A), "PUT", "/api/settings", {
    ...current.data,
    smtp: [smtp],
  });
  expect(saved.status).toBe(200);
  const list = parse<{ data: { id: number } }>(
    (
      await api(port, A, key(A), "POST", "/api/lists", {
        name: "double-of-a",
        type: "public",
        optin: "double",
      })
    ).text,
  );
  const recipient = "optin@a.example.test";
  const created = await api(port, A, key(A), "POST", "/api/subscribers", {
    email: recipient,
    name: "Opt in",
    status: "enabled",
    lists: [list.data.id],
  });
  expect(created.status).toBe(200);
  await untilState(() => sink.messages.some((message) => message.to.includes(recipient)), {
    label: "the opt-in mail from project a",
    progress: () => String(sink.messages.length),
    stallMs: 15_000,
  });
  const mail = sink.messages.find((message) => message.to.includes(recipient))!.data;
  expect(mail).toMatch(/^Message-Id: <[^>]+@a\.example\.test>$/im);
  expect(mail).toContain(`http://${A}/subscription/optin/`);
  expect(mail).not.toContain("127.0.0.1");
  expect(mail).not.toContain(B);
});

test("logs are per project: GET /api/logs on a host shows only its own lines", async () => {
  // A forwarded header from an untrusted peer is one attention line, in the project it reached.
  await request(port, A, "/admin/login", {
    method: "POST",
    headers: {
      "x-forwarded-for": "203.0.113.9",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "username=x&password=y&nonce=z",
  });
  const line = "X-Forwarded-For from an untrusted peer ignored";
  const read = async (host: string) =>
    parse<{ data: Array<string> }>((await api(port, host, key(host), "GET", "/api/logs")).text)
      .data;
  await untilState(async () => (await read(A)).some((entry) => entry.includes(line)), {
    label: "the attention line in project a's log",
    progress: () => "waiting",
    stallMs: 10_000,
  });
  expect((await read(B)).some((entry) => entry.includes(line))).toBe(false);
  expect((await read(PRIMARY)).some((entry) => entry.includes(line))).toBe(false);
});

test("each project's health route answers on its own host", async () => {
  for (const host of [A, B, PRIMARY, UNCLAIMED]) {
    const response = await request(port, host, "/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: true });
  }
});

test("the subscriber query runner's two children are one budget across projects", async () => {
  // Two queries that never end on their own hold A's runner children until their 10 s limit.
  const endless = encodeURIComponent(
    "(WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c) > 0",
  );
  const quick = encodeURIComponent("subscribers.id > 0");
  const abort = new AbortController();
  const slow = [1, 2].map(() =>
    request(port, A, `/api/subscribers?query=${endless}`, {
      headers: { authorization: key(A) },
      signal: abort.signal,
    }).catch(() => undefined),
  );
  try {
    // Wait until both of A's queries hold a child: then A's own third query is refused as busy.
    await untilState(
      async () => {
        const third = await api(port, A, key(A), "GET", `/api/subscribers?query=${quick}`);
        return third.status === 429;
      },
      { label: "A's two slow queries to hold both children", progress: () => "", stallMs: 8000 },
    );
    // B has its own database, but not its own children: its query waits and is refused too.
    const other = await api(port, B, key(B), "GET", `/api/subscribers?query=${quick}`);
    expect(other.status).toBe(429);
    expect(other.text).toContain("Too many subscriber queries in progress.");
  } finally {
    abort.abort();
    await Promise.all(slow);
  }
  // Once A's children end (at their limit at the latest), B's query runs.
  await untilState(
    async () =>
      (await api(port, B, key(B), "GET", `/api/subscribers?query=${quick}`)).status === 200,
    { label: "B's query after A's children ended", progress: () => "", stallMs: 15_000 },
  );
});

/**
 * A GET on `host` whose response is read only up to its status line, then left unread with the
 * connection open, as a slow download leaves it. Bun's fetch would buffer the whole body.
 */
function pausedRequest(port: number, host: string, path: string, authorization: string) {
  return new Promise<{ status: number; close: () => void }>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAuthorization: ${authorization}\r\n\r\n`,
      );
    });
    socket.once("error", reject);
    socket.once("data", (chunk: Buffer) => {
      socket.pause();
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(chunk.toString("latin1"))?.[1] ?? 0);
      resolve({ status, close: () => socket.destroy() });
    });
  });
}

test("a paused raw-query export frees its shared child slot when its child exits", async () => {
  const query = encodeURIComponent("subscribers.id > 0");
  // Enough of A's rows that an export's CSV outgrows the socket buffers while nobody reads it.
  // An export writes 500 rows a batch and the server buffers about two batches of 4 MiB, so
  // 2,000 rows of about 8 KiB leave the export's ID reader unfinished.
  const filler = "x".repeat(8 * 1024);
  for (let n = 0; n < 2000; n++) {
    const created = await api(port, A, key(A), "POST", "/api/subscribers", {
      email: `bulk-${n}@a.example.test`,
      name: `bulk-of-a-${n}`,
      status: "enabled",
      attribs: { filler },
    });
    expect(created.status).toBe(200);
  }
  // Two exports in A whose bodies are not read past their headers: each keeps its response open,
  // but its child ends as soon as it has spooled the IDs (D62).
  const exports = await Promise.all(
    [1, 2].map(() => pausedRequest(port, A, `/api/subscribers/export?query=${query}`, key(A))),
  );
  try {
    expect(exports.map((paused) => paused.status)).toEqual([200, 200]);
    // Both exports still hold A's large-selection slots, so neither has been read to its end.
    const third = await api(port, A, key(A), "GET", `/api/subscribers/export?query=${query}`);
    expect(third.status).toBe(429);
    // Once their children have exited, a raw query in another project runs, as one in A does.
    for (const host of [B, A]) {
      await untilState(
        async () =>
          (await api(port, host, key(host), "GET", `/api/subscribers?query=${query}`)).status ===
          200,
        {
          label: `a raw query on ${host} beside two paused exports`,
          progress: () => "",
          stallMs: 8000,
        },
      );
    }
  } finally {
    for (const paused of exports) {
      paused.close();
    }
  }
});

test("stderr lines carry the project's slug", async () => {
  const { code, stderr } = await server.stop();
  expect(code).toBe(0);
  const lines = stderr.split("\n").filter((entry) => entry.includes("X-Forwarded-For"));
  expect(lines.length).toBe(1);
  expect(lines[0]).toStartWith("[a] ");
});
