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
        "protected-health-basic",
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
