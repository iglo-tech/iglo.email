// Serial synthetic owner comparison; invoked only inside reference:run.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createServer, createConnection, type Socket } from "node:net";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createListReferences } from "@/lists/references";
import { createSubscriberStore } from "@/subscribers/store";
import { createEmailer, type Message } from "@/messaging/email";
import { createSends } from "@/messaging/sends";
import { startOutbox } from "@/messaging/outbox";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";

const controlPath = resolve("node_modules/.cache/m22-control/src/messaging/email.ts");
const control = (await import(controlPath)) as typeof import("@/messaging/email");
const sink = referenceMailpit(process.env);
await assertOwnedMailpit(sink);
const marker = `m08${sink.runId.replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
const mailpit = new Mailpit(sink, marker);
let connects = 0,
  live = 0,
  peak = 0;
const sockets = new Set<Socket>();
const relay = createServer((client) => {
  connects++;
  live++;
  peak = Math.max(peak, live);
  const upstream = createConnection({ host: sink.host, port: sink.port });
  sockets.add(client);
  sockets.add(upstream);
  client.on("error", () => {});
  upstream.on("error", () => {});
  client.pipe(upstream).pipe(client);
  client.on("close", () => {
    live--;
    sockets.delete(client);
    upstream.destroy();
  });
  upstream.on("close", () => {
    sockets.delete(upstream);
    client.destroy();
  });
});
await new Promise<void>((done) => relay.listen(0, "127.0.0.1", done));
const relayAddress = relay.address();
if (!relayAddress || typeof relayAddress === "string") throw new Error("Missing relay port");
const directory = await mkdtemp(join(tmpdir(), "iglo-outbox-measure-"));
const clock = createRealClock(),
  db = openDatabase(directory);
runMigrations(db, directory, clock, productionMigrations);
const lists = createListReferences(db),
  subscribers = createSubscriberStore(db, clock, lists);
const smtp = [
  {
    name: "fixture",
    enabled: true,
    exclude_from_default: false,
    host: sink.host,
    port: relayAddress.port,
    hello_hostname: "fixture.test",
    max_conns: 1,
    idle_timeout: "2s",
    wait_timeout: "2s",
    auth_protocol: "none",
    username: "",
    tls_type: "none",
    tls_skip_verify: false,
    email_headers: [],
    from_addresses: [],
  },
];
const settings = () => ({ smtp, rootUrl: "https://example.test" });
const direct = control.createEmailer({ clock, settings });
const mailer = createEmailer({ clock, settings });
const sends = createSends({ db, clock, subscribers, rootUrl: () => "https://example.test" });
const pending = new Map<string, (accepted: boolean) => void>();
const tracked = {
  ...sends,
  finishAll(results: Parameters<typeof sends.finishAll>[0]) {
    sends.finishAll(results);
    for (const { outcome } of results) {
      pending.get(outcome.messageId)?.(outcome.status === "accepted");
      pending.delete(outcome.messageId);
    }
  },
};
let loop: ReturnType<typeof startOutbox> | undefined;
try {
  for (const mode of ["control", "durable"] as const) {
    if (mode === "durable")
      loop = startOutbox({
        db,
        clock,
        logger: { error: () => {} },
        sends: tracked,
        emailer: mailer,
      });
    for (let repetition = 0; repetition <= 3; repetition++) {
      const count = repetition === 0 ? 10 : 50;
      const ids: string[] = [],
        enqueue: number[] = [];
      const before = connects;
      peak = live;
      const start = performance.now();
      for (let i = 0; i < count; i++) {
        const message: Message = {
          from: "sender@example.test",
          to: ["recipient@example.test"],
          subject: `${marker} ${mode}-${repetition}-${i}`,
          contentType: "plain",
          body: Buffer.from("synthetic measurement"),
        };
        if (mode === "control") {
          const dispatched = direct.push(message);
          const result = await dispatched.result;
          assert.equal(result.status, "accepted");
          ids.push(dispatched.messageId.replace(/[<>]/g, ""));
        } else {
          const begin = performance.now();
          const entry = sends.enqueue({ source: "tx", kind: "transactional", message });
          enqueue.push(performance.now() - begin);
          const accepted = new Promise<boolean>((done) => pending.set(entry.smtp_message_id, done));
          assert.equal(await accepted, true);
          ids.push(entry.smtp_message_id.replace(/[<>]/g, ""));
        }
      }
      const elapsed = performance.now() - start;
      const received = (await mailpit.list()).filter((m) =>
        m.Subject.startsWith(`${marker} ${mode}-${repetition}-`),
      );
      assert.equal(received.length, count);
      assert.deepEqual(received.map((m) => m.MessageID.replace(/[<>]/g, "")).sort(), ids.sort());
      process.stdout.write(
        `${JSON.stringify({ mode, repetition, count, elapsedMs: elapsed, enqueueMeanMs: enqueue.length ? enqueue.reduce((a, b) => a + b, 0) / enqueue.length : null, accepted: count, matched: received.length, connections: connects - before, peakLive: peak })}\n`,
      );
      await mailpit.removeOwned();
    }
    if (mode === "control") await direct.close();
  }
} finally {
  const stopped = loop?.stop();
  await Promise.all([direct.close(), mailer.close(), stopped]);
  sends.close();
  subscribers.close();
  lists.close();
  db.close(true);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((done, fail) => relay.close((error) => (error ? fail(error) : done())));
  await mailpit.removeOwned();
  await rm(directory, { recursive: true, force: true });
}
