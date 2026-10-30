// Kill the compiled build while a delivery is in flight, restart it, and the delivery arrives:
// same `id`, correctly signed, a duplicate allowed and a loss not. Then a SIGTERM with a hung
// receiver still exits cleanly. Part of `bun run contract:webhooks`.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { provisionApiUser } from "@/test/contract/owned";
import { signatureValid, startReceiver } from "@/test/webhooks/receiver";

const admin = { user: "crash-admin", password: "crash-admin-password" };
const executable = resolve(import.meta.dir, "../../dist/iglo.email");
const directory = mkdtempSync(join(tmpdir(), "iglo-webhook-crash-"));
const port = await new Promise<number>((done) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => done(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
let child: ChildProcess | undefined;
let errors = "";

async function start() {
  child = spawn(
    executable,
    ["serve", "--host", "127.0.0.1", "--port", String(port), "--data-dir", join(directory, "d")],
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
  child.stderr!.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-4000);
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const response = await fetch(`${origin}/health`).catch(() => null);
    if (response?.status === 200) return;
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
  await start();
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
  await start();
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
