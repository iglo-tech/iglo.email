import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withProduction } from "@/test/contract/owned";
import { runContract } from "@/test/contract/runner";
import type { ContractCase, ContractTarget, Difference } from "@/test/contract/types";

const repository = resolve(import.meta.dir, "../..");
let directory = "";
let executable = "";
let badShutdownExecutable = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "iglo-contract-tests-"));
  executable = join(directory, "iglo.email");
  const build = Bun.spawn(
    [process.execPath, "build", "--compile", "src/main.ts", "--outfile", executable],
    { cwd: repository, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  if (code !== 0) throw new Error(`Compiled test setup failed: ${stderr}`);
  badShutdownExecutable = join(directory, "bad-shutdown");
  const fixtureBuild = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "test/contract/shutdown-fixture.ts",
      "--outfile",
      badShutdownExecutable,
    ],
    { cwd: repository, stdout: "pipe", stderr: "pipe" },
  );
  const [fixtureCode, fixtureError] = await Promise.all([
    fixtureBuild.exited,
    new Response(fixtureBuild.stderr).text(),
  ]);
  if (fixtureCode !== 0) throw new Error(`Shutdown test setup failed: ${fixtureError}`);
}, 30_000);
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function get(origin: string, path = "/health") {
  return fetch(`${origin}${path}`, {
    headers: { Connection: "close" },
    signal: AbortSignal.timeout(1_000),
  });
}

describe("owned production lifecycle", () => {
  test("runs the standalone compiled process and removes it after a failing run", async () => {
    let origin = "";
    await expect(
      withProduction(executable, new AbortController().signal, async (baseUrl) => {
        origin = baseUrl;
        expect((await get(origin)).status).toBe(200);
        expect((await get(origin, "/api/health")).status).toBe(403);
        throw new Error("synthetic contract failure");
      }),
    ).rejects.toThrow("synthetic contract failure");
    expect(origin).not.toBe("");
    await expect(get(origin)).rejects.toThrow();
  });

  test("a nonzero child shutdown is reported as a failure", async () => {
    const run = withProduction(
      badShutdownExecutable,
      new AbortController().signal,
      async (origin) => {
        expect((await get(origin)).status).toBe(200);
        return true;
      },
    );
    await expect(run).rejects.toThrow("shutdown");
  });

  test("the production CLI removes its own data after refusing an unsupported case", async () => {
    const build = Bun.spawn([process.execPath, "run", "build"], {
      cwd: repository,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [buildCode, buildError] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);
    if (buildCode !== 0) throw new Error(`Production build failed: ${buildError}`);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "iglo-contract-cli-cleanup-"));
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "test/contract/cli.ts",
          "owned",
          "production",
          "--case",
          "probe-entities",
        ],
        {
          cwd: repository,
          env: { PATH: process.env.PATH ?? "", TMPDIR: temporaryRoot },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).not.toBe(0);
      expect(output.toLowerCase()).toContain("unsupported");
      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("closes its compiled child when the run is cancelled", async () => {
    const controller = new AbortController();
    let ready!: (origin: string) => void;
    const started = new Promise<string>((resolveReady) => {
      ready = resolveReady;
    });
    const running = withProduction(executable, controller.signal, async (origin) => {
      ready(origin);
      await new Promise<void>((_, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("synthetic cancellation")),
          { once: true },
        ),
      );
    });
    const origin = await started;
    expect((await get(origin)).status).toBe(200);
    controller.abort();
    await expect(running).rejects.toThrow();
    await expect(get(origin)).rejects.toThrow();
  });
});

describe("difference metadata and strict transport", () => {
  test("D18 static escape checks the normal HTML refusal rather than accepting upstream text", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("404 page not found\n", {
          status: 404,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      },
    });
    try {
      const report = await runContract(
        {
          mode: "normal",
          target: "production",
          profile: "core",
          baseUrl: `http://127.0.0.1:${server.port}`,
        },
        { caseId: "public-static-dot-escape" },
      );
      expect(report.passed).toBe(false);
      expect(report.lines.join("\n")).toContain("FAIL public-static-dot-escape [D18:");
    } finally {
      await server.stop(true);
    }
  });

  test("declared response headers reject missing and incorrect Allow values", async () => {
    for (const allow of [undefined, "GET", "OPTIONS, GET"]) {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return new Response(null, {
            status: 204,
            headers: allow ? { Allow: allow } : {},
          });
        },
      });
      try {
        const report = await runContract(
          {
            mode: "normal",
            target: "production",
            profile: "core",
            baseUrl: `http://127.0.0.1:${server.port}`,
          },
          {
            cases: [
              {
                id: "synthetic-response-header",
                group: "core",
                production: {
                  path: "/",
                  expect: {
                    status: 204,
                    contentType: null,
                    headers: { allow: "OPTIONS, GET" },
                    body: { kind: "wire", value: "" },
                  },
                },
              },
            ],
          },
        );
        expect(report.passed).toBe(allow === "OPTIONS, GET");
      } finally {
        await server.stop(true);
      }
    }
  });

  test("rejects unknown, orphaned, missing and duplicate markers before requests", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return new Response();
      },
    });
    try {
      const target: ContractTarget = {
        mode: "normal",
        target: "fixture",
        profile: "staged",
        baseUrl: `http://127.0.0.1:${server.port}`,
      };
      const endpoint = {
        path: "/",
        expect: { status: 200, contentType: null, body: { kind: "wire", value: "" } },
      } as const;
      const base: ContractCase = {
        id: "synthetic",
        group: "staged",
        reference: endpoint,
        fixture: endpoint,
      };
      const bad: ContractCase[][] = [
        [{ ...base, difference: "D99" as Difference }],
        [{ ...base, difference: "D17" }],
        [{ ...base, id: "positive-id-overflow" }],
        [base, base],
        [{ ...base, id: "positive-id-overflow", difference: "D17" }],
        [{ ...base, fixture: { ...endpoint, path: "http://example.com/" } }],
        [{ ...base, fixture: { ...endpoint, path: "//example.com/" } }],
      ];
      for (const cases of bad) await expect(runContract(target, { cases })).rejects.toThrow();
      expect(requests).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("a difference marker cannot excuse an unexpected response", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response('{"data":true}\n', { headers: { "content-type": "application/json" } });
      },
    });
    try {
      const result = await runContract(
        {
          mode: "normal",
          target: "fixture",
          profile: "staged",
          baseUrl: `http://127.0.0.1:${server.port}`,
          credentials: { user: "synthetic-user", token: "synthetic-token" },
        },
        { caseId: "positive-id-overflow" },
      );
      expect(result.passed).toBe(false);
      expect(result.lines.join("\n")).toContain("FAIL positive-id-overflow [D17:");
    } finally {
      await server.stop(true);
    }
  });

  test("concurrent runs keep independent ID and timestamp bindings", async () => {
    const create = (id: number, created: string, updated: string) =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const data = new URL(request.url).pathname.endsWith("/reference")
            ? { id }
            : {
                id,
                owner_id: id,
                other_id: id + 1,
                created_at: created,
                created_copy: created,
                updated_at: updated,
                label: "synthetic 101",
                fixed: { id: 77 },
              };
          return new Response(`${JSON.stringify({ data })}\n`, {
            headers: { "content-type": "application/json" },
          });
        },
      });
    const first = create(101, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z");
    const second = create(202, "2027-01-01T00:00:00.000Z", "2027-01-01T00:00:01.000Z");
    try {
      const reports = await Promise.all(
        [first, second].map((target) =>
          runContract({
            mode: "normal",
            target: "fixture",
            profile: "probe",
            baseUrl: `http://127.0.0.1:${target.port}`,
          }),
        ),
      );
      expect(reports.map((report) => report.passed)).toEqual([true, true]);
    } finally {
      await Promise.all([first.stop(true), second.stop(true)]);
    }
  });

  test("rejects invalid JSON and incorrect content type in probes", async () => {
    for (const response of [
      new Response("not-json\n", { headers: { "content-type": "application/json" } }),
      new Response("{}\n", { headers: { "content-type": "text/plain" } }),
    ]) {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return response.clone();
        },
      });
      try {
        const result = await runContract(
          {
            mode: "normal",
            target: "fixture",
            profile: "probe",
            baseUrl: `http://127.0.0.1:${server.port}`,
          },
          { caseId: "probe-entities" },
        );
        expect(result.passed).toBe(false);
      } finally {
        await server.stop(true);
      }
    }
  });

  test("CLI cancellation interrupts an in-flight request", async () => {
    let received!: () => void;
    const started = new Promise<void>((resolveReady) => {
      received = resolveReady;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        received();
        return new Promise<Response>(() => {});
      },
    });
    const child = Bun.spawn(
      [
        process.execPath,
        "test/contract/cli.ts",
        "run",
        "--mode",
        "normal",
        "--target",
        "production",
        "--profile",
        "core",
        "--base-url",
        `http://127.0.0.1:${server.port}`,
        "--case",
        "health",
      ],
      { cwd: repository, stdout: "pipe", stderr: "pipe" },
    );
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await started;
      child.kill("SIGTERM");
      const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).not.toBe(0);
      expect(output).toContain("interrupted");
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill("SIGKILL");
      await server.stop(true);
    }
  });
});
