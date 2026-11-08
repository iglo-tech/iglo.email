// Kill the compiled build while a delivery is in flight, restart it, and the delivery arrives:
// same `id`, correctly signed, a duplicate allowed and a loss not. Then a SIGTERM with a hung
// receiver still exits cleanly. Part of `bun run contract:webhooks`.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { provisionApiUser } from "@/test/contract/owned";
import { listensOn, restartOnPort, startOnFreePort, stderrDrained } from "@/test/serve-port";
import { signatureValid, startReceiver } from "@/test/webhooks/receiver";

const admin = { user: "crash-admin", password: "crash-admin-password" };
const executable = resolve(import.meta.dir, "../../dist/iglo.email");
const directory = mkdtempSync(join(tmpdir(), "iglo-webhook-crash-"));
// Set by the first start, which takes a port that startOnFreePort finds free; restarts reuse it
// through restartOnPort, since the origin above is kept.
let port = 0;
let origin = "";
let child: ChildProcess | undefined;
let errors = "";

async function start(listenPort: number) {
  // This attempt's stderr only: restartOnPort retries a start that reports its port in use, so an
  // earlier attempt's message must not make a later, different failure look like one.
  errors = "";
  child = spawn(
    executable,
    [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(listenPort),
      "--data-dir",
      join(directory, "d"),
    ],
    {
      cwd: directory,
      env: {
        PATH: "",
        IGLO_EMAIL_ADMIN_USER: admin.user,
        IGLO_EMAIL_ADMIN_PASSWORD: admin.password,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const attempt = child;
  attempt.stderr!.on("data", (chunk: Buffer) => {
    if (child === attempt) errors = (errors + chunk.toString()).slice(-4000);
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    // An exit here is a failed start (the port in use, for one); /health alone could be another server's.
    if (child.exitCode !== null) {
      await stderrDrained(child!);
      throw new Error(`not ready: ${errors}`);
    }
    const response = await fetch(`${origin}/health`).catch(() => null);
    if (response?.status === 200 && child.pid !== undefined && listensOn(child.pid, listenPort))
      return;
    assert(Date.now() < deadline, `not ready: ${errors}`);
    await Bun.sleep(20);
  }
}
const exit = (process: ChildProcess) =>
  new Promise<number | null>((done) => {
    if (process.exitCode !== null || process.signalCode !== null) done(process.exitCode);
    else process.once("exit", (code) => done(code));
  });

let release = () => {};
const held = new Promise<void>((resolve) => (release = resolve));
const receiver = startReceiver(async () => {
  await held;
  return new Response("too late");
});
try {
  await startOnFreePort(async (free) => {
    port = free;
    origin = `http://127.0.0.1:${port}`;
    await start(free);
  });
  const { user, token } = await provisionApiUser(origin, admin);
  const authorization = `Basic ${btoa(`${user}:${token}`)}`;
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { authorization, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200, path);
    return ((await response.json()) as { data: any }).data;
  };
  const { secret } = await api("/api/webhooks", "POST", {
    url: receiver.url(),
    events: ["subscriber.blocklisted"],
  });
  const subscriber = await api("/api/subscribers", "POST", {
    email: "crash@example.test",
    name: "Crash",
  });
  await api(`/api/subscribers/${subscriber.id}/blocklist`, "PUT", {});
  await receiver.waitFor(1);

  child!.kill("SIGKILL");
  await exit(child!);
  await restartOnPort(port, start);
  await receiver.waitFor(2);
  const [first, second] = receiver.received;
  assert.equal(second!.body.id, first!.body.id);
  assert.equal(second!.text, first!.text);
  assert(signatureValid(second!, secret));
  console.log("in-flight delivery arrived after SIGKILL and restart, same id");

  // SIGTERM with an attempt hanging: the loop stops, the attempt times out, the exit is clean.
  receiver.respond(async () => {
    await held;
    return new Response("late");
  });
  const before = receiver.received.length;
  const hang = await api("/api/subscribers", "POST", { email: "hang@example.test", name: "Hang" });
  await api(`/api/subscribers/${hang.id}/blocklist`, "PUT", {});
  await receiver.waitFor(before + 1);
  const started = Date.now();
  child!.kill("SIGTERM");
  assert.equal(await exit(child!), 0, errors);
  assert(Date.now() - started < 12_000, "bounded shutdown");
  console.log(`SIGTERM with a hung receiver exited 0 after ${Date.now() - started} ms`);
} finally {
  release();
  child?.kill("SIGKILL");
  receiver.close();
  rmSync(directory, { recursive: true, force: true });
}
console.log("PASS webhook crash");
