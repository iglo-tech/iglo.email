// Finite timing at compiled producer process/HTTP barriers, outside production.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { referenceMailpit, assertOwnedMailpit } from "@/test/perf/runtime-compat/smtp-env";
const sink = referenceMailpit(process.env);
await assertOwnedMailpit(sink);
const directory = await mkdtemp(join(tmpdir(), "iglo-recovery-time-"));
let active: ChildProcessWithoutNullStreams | undefined;
async function launch(dataDir: string) {
  const child = spawn(resolve("dist/sends-producer"), [], {
    env: { ...process.env, SENDS_FIXTURE_DIR: dataDir, SENDS_FIXTURE_SMTP_PORT: String(sink.port) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  active = child;
  const port = await new Promise<string>((ok, fail) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("\n")) ok(output.split("\n")[0]!);
    });
    child.once("exit", () => fail(new Error("Producer exited before readiness")));
  });
  const origin = `http://127.0.0.1:${port}`;
  const call = async (
    path: string,
    method = "GET",
    body?: string,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(origin + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    return ((await response.json()) as { data: any }).data;
  };
  return { child, call };
}
async function kill(child: ChildProcessWithoutNullStreams) {
  const done = new Promise<void>((ok) => child.once("exit", () => ok()));
  child.kill("SIGKILL");
  await done;
  if (active === child) active = undefined;
}
try {
  for (let repetition = 1; repetition <= 3; repetition++) {
    const dataDir = join(directory, String(repetition));
    let worker = await launch(dataDir);
    const entry = await worker.call(
      "/fixture/enqueue",
      "POST",
      JSON.stringify({ subject: "synthetic restart measure", kind: "transactional" }),
      { "content-type": "application/json" },
    );
    await worker.call("/fixture/start", "POST", "before-smtp");
    await worker.call("/fixture/entered");
    await kill(worker.child);
    const start = performance.now();
    worker = await launch(dataDir);
    await worker.call("/fixture/start", "POST", "normal");
    const session = await worker.call("/fixture/session");
    const recovered = await worker.call(`/api/sends/${entry.id}`, "GET", undefined, {
      cookie: session.cookie,
    });
    const elapsedMs = performance.now() - start;
    assert.equal(recovered.status, "unknown");
    assert.equal(recovered.attempts, 1);
    assert.equal(recovered.smtp_message_id, entry.smtp_message_id);
    process.stdout.write(
      `${JSON.stringify({ repetition, elapsedMs, status: recovered.status, attempts: recovered.attempts, matchingId: true })}\n`,
    );
    await kill(worker.child);
  }
} finally {
  if (active) await kill(active);
  await rm(directory, { recursive: true, force: true });
}
