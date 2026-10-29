// Compiled finite instrumentation around concrete journal operations, outside production.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { writeTransaction } from "@/db/transaction";
import { createListReferences } from "@/lists/references";
import { createSubscriberStore } from "@/subscribers/store";
import { createSends } from "@/messaging/sends";
import { createEmailer } from "@/messaging/email";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
const sink = referenceMailpit(process.env);
await assertOwnedMailpit(sink);
const marker = `m08${sink.runId.replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
const mailpit = new Mailpit(sink, marker);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const bytes = async (file: string) => (await stat(file).catch(() => ({ size: 0 }))).size;
try {
  for (let repetition = 1; repetition <= 3; repetition++) {
    const directory = await mkdtemp(join(tmpdir(), "iglo-stages-"));
    const clock = createRealClock();
    let db = openDatabase(directory);
    runMigrations(db, directory, clock, productionMigrations);
    let lists = createListReferences(db),
      subscribers = createSubscriberStore(db, clock, lists);
    let sends = createSends({ db, clock, subscribers, rootUrl: () => "http://fixture.test" });
    const mailer = createEmailer({
      clock,
      settings: () => ({
        rootUrl: "http://fixture.test",
        smtp: [
          {
            name: "fixture",
            enabled: true,
            exclude_from_default: false,
            host: sink.host,
            port: sink.port,
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
        ],
      }),
    });
    const enqueue: number[] = [],
      claim: number[] = [],
      commit: number[] = [];
    try {
      const dbPath = join(directory, "iglo-email.db");
      const initial = (await bytes(dbPath)) + (await bytes(`${dbPath}-wal`));
      const ids: string[] = [];
      const beginQueue = performance.now();
      for (let i = 0; i < 32; i++) {
        const start = performance.now();
        const row = sends.enqueue({
          source: "tx",
          kind: "transactional",
          message: {
            from: "sender@example.test",
            to: ["recipient@example.test"],
            subject: `${marker} ${repetition}-${i}`,
            contentType: "plain",
            body: Buffer.from("synthetic stage measurement"),
          },
        });
        enqueue.push(performance.now() - start);
        ids.push(row.smtp_message_id.replace(/[<>]/g, ""));
      }
      const queueMs = performance.now() - beginQueue;
      assert.equal(sends.list({ page: 1, perPage: 100, status: "queued" }).total, 32);
      const queuedBytes = (await bytes(dbPath)) + (await bytes(`${dbPath}-wal`));
      // Commit one claim, then reopen as a real restart recovery would.
      let start = performance.now();
      const interrupted = writeTransaction(db, () =>
        sends.claim(clock.now(), new Date(clock.now().getTime() + 60000)),
      )[0]!;
      claim.push(performance.now() - start);
      sends.close();
      subscribers.close();
      lists.close();
      db.close(true);
      start = performance.now();
      db = openDatabase(directory);
      lists = createListReferences(db);
      subscribers = createSubscriberStore(db, clock, lists);
      sends = createSends({ db, clock, subscribers, rootUrl: () => "http://fixture.test" });
      sends.recover();
      const recoveryMs = performance.now() - start;
      assert.equal(sends.get(interrupted.id)!.status, "unknown");
      for (let i = 1; i < 32; i++) {
        start = performance.now();
        const row = writeTransaction(db, () =>
          sends.claim(clock.now(), new Date(clock.now().getTime() + 60000)),
        )[0]!;
        claim.push(performance.now() - start);
        const message = sends.admit(row);
        assert.ok(message);
        const outcome = await mailer.push(message).result;
        assert.equal(outcome.status, "accepted");
        start = performance.now();
        sends.finish(row, outcome);
        commit.push(performance.now() - start);
      }
      const received = await mailpit.list();
      assert.equal(received.length, 31);
      assert.deepEqual(
        received.map((m) => m.MessageID.replace(/[<>]/g, "")).sort(),
        ids.slice(1).sort(),
      );
      assert.equal(sends.list({ page: 1, perPage: 100, status: "sent" }).total, 31);
      process.stdout.write(
        `${JSON.stringify({ repetition, backlog: 32, enqueueMeanMs: mean(enqueue), queueMs, claimMeanMs: mean(claim), terminalMeanMs: mean(commit), recoveryMs, initialBytes: initial, queuedBytes, growthBytes: queuedBytes - initial, sent: 31, unknown: 1, matchingIds: received.length })}\n`,
      );
      await mailpit.removeOwned();
    } finally {
      await mailer.close();
      sends.close();
      subscribers.close();
      lists.close();
      db.close(true);
      await rm(directory, { recursive: true, force: true });
    }
  }
} finally {
  await mailpit.removeOwned();
}
