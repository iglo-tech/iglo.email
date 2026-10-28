import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const fixtureUser = "contract-fixture-user";
const fixtureToken = "contract-fixture-token";

async function cli(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "test/contract/cli.ts", "run", ...args], {
    cwd: repository,
    env: {
      PATH: process.env.PATH ?? "",
      CONTRACT_API_USER: fixtureUser,
      CONTRACT_API_TOKEN: fixtureToken,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output: stdout + stderr };
  } finally {
    clearTimeout(timer);
  }
}

function options(origin: string, profile = "staged") {
  return ["--mode", "normal", "--target", "fixture", "--profile", profile, "--base-url", origin];
}

function server(handler: (request: Request) => Response) {
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  return { origin: `http://127.0.0.1:${target.port}`, close: () => target.stop(true) };
}

function json(body: unknown, status = 200) {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("contract runner public boundary", () => {
  test.each([
    ["encoded-dot", "GET /fixture/id/%2E"],
    ["encoded-dot-dot", "GET /fixture/id/%2E%2E"],
    ["api-method-mismatch", "POST /api/health"],
  ])("fixture case %s detects a nonconforming route response", async (id, expectedTarget) => {
    const seen: string[] = [];
    const target = createServer((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      const preservedDot = /^\/fixture\/id\/%2E(?:%2E)?$/.test(request.url ?? "");
      const wrongMethod = request.method === "POST" && request.url === "/api/health";
      response.writeHead(preservedDot ? 400 : wrongMethod ? 405 : 404, {
        "content-type": "application/json",
      });
      response.end(
        preservedDot
          ? '{"message":"invalid ID"}\n'
          : wrongMethod
            ? '{"message":"Method Not Allowed"}\n'
            : '{"message":"404 unknown endpoint"}\n',
      );
    });
    await new Promise<void>((ready) => target.listen(0, "127.0.0.1", ready));
    try {
      const address = target.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      const result = await cli([...options(`http://127.0.0.1:${address.port}`), "--case", id]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain(`FAIL ${id}`);
      expect(seen).toEqual([expectedTarget]);
    } finally {
      await new Promise<void>((done) => target.close(() => done()));
    }
  });

  test("selects cases explicitly and sends Basic and token credentials", async () => {
    const sent: string[] = [];
    const target = server((request) => {
      sent.push(request.headers.get("authorization") ?? "none");
      return json({ data: true });
    });
    try {
      for (const id of ["protected-health-basic", "protected-health-token"]) {
        const result = await cli([...options(target.origin), "--case", id]);
        expect(result.code).toBe(0);
        expect(result.output).toContain(`PASS ${id}`);
        expect(result.output).toContain("mode=normal target=fixture profile=staged");
      }
      expect(sent).toEqual([
        `Basic ${Buffer.from(`${fixtureUser}:${fixtureToken}`).toString("base64")}`,
        `token ${fixtureUser}:${fixtureToken}`,
      ]);
    } finally {
      await target.close();
    }
  });

  test("rejects unsupported production cases before making a request", async () => {
    let requests = 0;
    const target = server(() => {
      requests++;
      return json({ data: true });
    });
    try {
      const result = await cli([
        "--mode",
        "normal",
        "--target",
        "production",
        "--profile",
        "core",
        "--base-url",
        target.origin,
        "--case",
        "invalid-id",
      ]);
      expect(result.code).not.toBe(0);
      expect(result.output.toLowerCase()).toContain("unsupported");
      expect(requests).toBe(0);
    } finally {
      await target.close();
    }
  });

  test("rejects malformed modes, profiles, origins, and credentials before requests", async () => {
    let requests = 0;
    const target = server(() => {
      requests++;
      return json({ data: true });
    });
    try {
      const samples = [
        [
          "--mode",
          "other",
          "--target",
          "fixture",
          "--profile",
          "staged",
          "--base-url",
          target.origin,
        ],
        [
          "--mode",
          "normal",
          "--target",
          "production",
          "--profile",
          "staged",
          "--base-url",
          target.origin,
        ],
        [...options("https://example.com")],
        [...options("http://example.com")],
        [...options("http://user:private-password@127.0.0.1:1234")],
        [...options(`${target.origin}/path`)],
        [...options(target.origin), "--case", "not-a-case"],
      ];
      for (const args of samples) {
        const result = await cli(args);
        expect(result.code).not.toBe(0);
        expect(result.output).not.toContain("private-password");
      }
      const badCredentials = await cli(
        [...options(target.origin), "--case", "protected-health-basic"],
        { CONTRACT_API_TOKEN: "bad\ncredential" },
      );
      expect(badCredentials.code).not.toBe(0);
      expect(requests).toBe(0);
    } finally {
      await target.close();
    }
  });

  test("fails strictly and redacts credentials even when the server echoes them", async () => {
    const auth = `Basic ${Buffer.from(`${fixtureUser}:${fixtureToken}`).toString("base64")}`;
    const target = server(() => json({ data: `${fixtureUser} ${fixtureToken} ${auth}` }));
    try {
      const result = await cli([...options(target.origin), "--case", "protected-health-basic"]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("FAIL protected-health-basic");
      for (const secret of [fixtureUser, fixtureToken, auth, auth.slice(6)])
        expect(result.output).not.toContain(secret);
    } finally {
      await target.close();
    }
  });

  test("does not infer capabilities from 401 or 404 responses", async () => {
    for (const status of [401, 404]) {
      const target = server(() => json({ message: "synthetic failure" }, status));
      try {
        const result = await cli([...options(target.origin), "--case", "protected-health-basic"]);
        expect(result.code).not.toBe(0);
        expect(result.output).toContain("FAIL protected-health-basic");
        expect(result.output).not.toContain("PASS protected-health-basic");
      } finally {
        await target.close();
      }
    }
  });

  test("sends an exact dot-segment target without client URL normalization", async () => {
    const seen: string[] = [];
    const target = createServer((request, response) => {
      seen.push(request.url ?? "");
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"message":"invalid ID"}\n');
    });
    await new Promise<void>((resolveListen) => target.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = target.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      const result = await cli([
        "--mode",
        "reference",
        "--target",
        "upstream",
        "--profile",
        "all",
        "--base-url",
        `http://127.0.0.1:${address.port}`,
        "--case",
        "encoded-dot",
      ]);
      expect(result.code).toBe(0);
      expect(result.output).toContain("D18");
      expect(seen).toEqual(["/api/lists/%2E"]);
    } finally {
      await new Promise<void>((done) => target.close(() => done()));
    }
  });
});

describe("normalization at the HTTP boundary", () => {
  const good = () => ({
    data: {
      id: 101,
      owner_id: 101,
      other_id: 202,
      created_at: "2026-01-01T00:00:00.000Z",
      created_copy: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:01.000Z",
      label: "synthetic 101",
      fixed: { id: 77 },
    },
  });
  async function run(first: unknown, referenceId = 101) {
    const target = server((request) =>
      new URL(request.url).pathname.endsWith("/reference")
        ? json({ data: { id: referenceId } })
        : json(first),
    );
    try {
      return await cli(options(target.origin, "probe"));
    } finally {
      await target.close();
    }
  }
  test("preserves independently generated identities and ordered timestamps", async () => {
    for (const id of [101, 9001]) {
      const entity = good();
      entity.data.id = id;
      entity.data.owner_id = id;
      entity.data.other_id = id + 1;
      const result = await run(entity, id);
      expect(result.code).toBe(0);
      expect(result.output).toContain("PASS probe-entities");
      expect(result.output).toContain("PASS probe-entity-reference");
      expect(result.output).toContain("synthetic harness probe");
    }
  });
  test("rejects numeric tokens that JSON parsing would round to an apparently safe ID", async () => {
    const body = JSON.stringify(good()).replace('"id":101', '"id":101.0000000000000001');
    const target = server(
      () => new Response(`${body}\n`, { headers: { "content-type": "application/json" } }),
    );
    try {
      const result = await cli([...options(target.origin, "probe"), "--case", "probe-entities"]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("Invalid or unsafe ID");
    } finally {
      await target.close();
    }
  });
  test("a reference case requires the entity binding established earlier in the run", async () => {
    const target = server(() => json({ data: { id: 101 } }));
    try {
      const result = await cli([
        ...options(target.origin, "probe"),
        "--case",
        "probe-entity-reference",
      ]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("requires an existing binding");
    } finally {
      await target.close();
    }
  });
  test("a failed case cannot establish a binding for a later reference", async () => {
    const value = good();
    value.data.label = "changed";
    const result = await run(value);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("FAIL probe-entities");
    expect(result.output).toContain("FAIL probe-entity-reference");
    expect(result.output).toContain("requires an existing binding");
  });
  test("rejects wrong types, missing/extra fields, unsafe IDs, inconsistent references and ordinary changes", async () => {
    const invalid: unknown[] = [
      { data: { ...good().data, id: "101" } },
      { data: { ...good().data, id: 9007199254740992 } },
      { data: { ...good().data, owner_id: 102 } },
      { data: { ...good().data, other_id: 101 } },
      { data: { ...good().data, created_at: "invalid" } },
      { data: { ...good().data, created_copy: "2026-01-01T00:00:01.000Z" } },
      { data: { ...good().data, updated_at: "2025-12-31T00:00:00.000Z" } },
      { data: { ...good().data, label: "changed" } },
      { data: { ...good().data, fixed: { id: 78 } } },
      { data: { ...good().data, extra: true } },
      { data: { ...good().data, created_at: undefined } },
    ];
    for (const value of invalid) expect((await run(value)).code).not.toBe(0);
    expect((await run(good(), 999)).code).not.toBe(0);
  });
});

const public404Page =
  '<!DOCTYPE html><html><head><title>404 - Not found - iglo.email</title><link rel="stylesheet" href="/public/static/style.css?v=0123456789"><link rel="icon" href="/public/static/favicon.png?v=0123456789"></head><body><div class="wrap"><header><div class="logo"><img src="/public/static/logo.svg?v=0123456789" alt="iglo.email"></div></header><h2>404 - Not found</h2><div></div></div><footer>Powered by <a href="https://iglo.email">iglo.email</a>. Based on <a href="https://listmonk.app">listmonk</a>.</footer></body></html>';

test("public HTML contract rejects missing, duplicated, incorrect, or unsafe page elements", async () => {
  const page = public404Page;

  let body = page;
  const target = server(
    () =>
      new Response(body, { status: 404, headers: { "content-type": "text/html; charset=UTF-8" } }),
  );
  const args = [
    "--mode",
    "normal",
    "--target",
    "production",
    "--profile",
    "core",
    "--base-url",
    target.origin,
    "--case",
    "health-post-html",
  ];
  try {
    expect((await cli(args)).code).toBe(0);
    for (const invalid of [
      page.replace("<!DOCTYPE html>", ""),
      page.replace("404 - Not found - iglo.email", "wrong title"),
      page.replace("<h2>404 - Not found</h2>", "<h2>404 - Not found</h2><h2>404 - Not found</h2>"),
      page.replace("/public/static/style.css?v=0123456789", "/public/static/style.css?v=bad"),
      page.replace("/public/static/logo.svg?v=0123456789", "/public/static/logo.svg?v=1111111111"),
      page.replace("<div></div>", "<div>unexpected message</div>"),
      page.replace("<footer>", "<script>alert(1)</script><footer>"),
      page.replace('alt="iglo.email"', 'alt="iglo.email" onerror="alert(1)"'),
      page.replace("https://iglo.email", "javascript:alert(1)"),
    ]) {
      body = invalid;
      const result = await cli(args);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("FAIL health-post-html");
    }
  } finally {
    await target.close();
  }
});

test.each([
  [
    "newline executable URL",
    public404Page.replace(
      "</footer>",
      '<a href="java\nscript:globalThis.contractInjected=true">unsafe</a></footer>',
    ),
  ],
  [
    "tab executable URL",
    public404Page.replace(
      "</footer>",
      '<a href="java\tscript:globalThis.contractInjected=true">unsafe</a></footer>',
    ),
  ],
  [
    "carriage-return executable URL",
    public404Page.replace(
      "</footer>",
      '<a href="java\rscript:globalThis.contractInjected=true">unsafe</a></footer>',
    ),
  ],
  ["hidden heading", public404Page.replace("<h2>", "<h2 hidden>")],
  ["hidden heading ancestor", public404Page.replace('class="wrap"', 'class="wrap" hidden')],
  ["styled hidden heading", public404Page.replace("<h2>", '<h2 style="display:none">')],
  [
    "entity newline executable URL",
    public404Page.replace(
      "</footer>",
      '<a href="java&#10;script:globalThis.contractInjected=true">unsafe</a></footer>',
    ),
  ],
  [
    "entity initial executable URL",
    public404Page.replace(
      "</footer>",
      '<a href="&#106;avascript:globalThis.contractInjected=true">unsafe</a></footer>',
    ),
  ],
  [
    "entity colon executable URL",
    public404Page.replace(
      "</footer>",
      '<a href="javascript&colon;globalThis.contractInjected=true">unsafe</a></footer>',
    ),
  ],
  [
    "closed disclosure heading",
    public404Page.replace(
      "<h2>404 - Not found</h2>",
      "<details><summary>Closed</summary><h2>404 - Not found</h2></details>",
    ),
  ],
  [
    "body stylesheet",
    public404Page.replace(
      "</body>",
      '<link rel="stylesheet" href="https://example.invalid/hide.css"></body>',
    ),
  ],
  [
    "foreign document base",
    public404Page.replace("</head>", '<base href="https://example.invalid/"></head>'),
  ],
  ["closed popover ancestor", public404Page.replace('class="wrap"', 'class="wrap" popover')],
  [
    "image in head",
    public404Page.replace("</head>", '<img src="https://example.invalid/t.png" alt="x"></head>'),
  ],
  ["image after document", public404Page + '<img src="https://example.invalid/t.png" alt="x">'],
  [
    "sibling message container",
    public404Page.replace("</body>", '<div class="container">unexpected message</div></body>'),
  ],
  ["bare wrapper text", public404Page.replace("<h2>", "unexpected message<h2>")],
  ["bare header text", public404Page.replace("<header>", "<header>unexpected message")],
  ["extra footer text", public404Page.replace("</footer>", " unexpected message</footer>")],
  ["text after body", public404Page.replace("</body>", "</body>unexpected message")],
  ["text after document", public404Page + "unexpected message"],
  [
    "unexpected footer link",
    public404Page.replace("https://listmonk.app", "https://example.invalid"),
  ],
])("public HTML contract rejects %s", async (_name, body) => {
  const target = server(
    () =>
      new Response(body, {
        status: 404,
        headers: { "content-type": "text/html; charset=UTF-8" },
      }),
  );
  try {
    const result = await cli([
      "--mode",
      "normal",
      "--target",
      "production",
      "--profile",
      "core",
      "--base-url",
      target.origin,
      "--case",
      "health-post-html",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("FAIL health-post-html");
  } finally {
    await target.close();
  }
});
