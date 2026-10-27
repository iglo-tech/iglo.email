import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withProduction } from "@/test/contract/owned";
import { runContract } from "@/test/contract/runner";
import type { ContractCase, ContractTarget, Difference } from "@/test/contract/types";

const repository = resolve(import.meta.dir, "../..");
let directory = "";
let executable = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "iglo-contract-tests-"));
  executable = join(directory, "iglo.email");
  const build = Bun.spawn(
    [process.execPath, "build", "--compile", "src/main.ts", "--outfile", executable],
    { cwd: repository, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  if (code !== 0) throw new Error(`Compiled test setup failed: ${stderr}`);
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
        expect((await get(origin, "/api/health")).status).toBe(404);
        throw new Error("synthetic contract failure");
      }),
    ).rejects.toThrow("synthetic contract failure");
    expect(origin).not.toBe("");
    await expect(get(origin)).rejects.toThrow();
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
