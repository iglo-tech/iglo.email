// B18 (D80): the `sends` lease, rejected pushes, and anonymized rows, through the outbox loop and
// dispatch with the injected clock and a fake emailer. Only the journal's exported functions.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createListReferences } from "@/lists/references";
import type { Outcome } from "@/messaging/email";
import { startOutbox } from "@/messaging/outbox";
import { createSendAnonymizer } from "@/messaging/anonymize";
import { createSends } from "@/messaging/sends";
import { createSubscriberStore } from "@/subscribers/store";
import { TestClock } from "@/test/server/fixture";

const open: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

const accepted: Outcome = {
  messageId: "<m@example.test>",
  status: "accepted",
  stage: "smtp-complete",
  accepted: ["recipient@example.test"],
  rejected: [],
};
const transient: Outcome = {
  messageId: "<m@example.test>",
  status: "proven-not-accepted",
  stage: "recipients",
  accepted: [],
  rejected: [],
  retry: "transient",
};
const { retry: _retry, ...permanent } = transient;
const message = (to = "recipient@example.test") => ({
  from: "sender@example.test",
  to: [to],
  subject: "synthetic subject",
  contentType: "plain" as const,
  body: Buffer.from("synthetic body"),
  headers: {},
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "iglo-lease-"));
  const clock = new TestClock();
  const db = openDatabase(directory);
  runMigrations(db, directory, clock, productionMigrations);
  const lists = createListReferences(db);
  const subscribers = createSubscriberStore(db, clock, lists);
  const ended: Array<{ uuid: string; status: string; error: string | null }> = [];
  const errors: unknown[] = [];
  const journal = createSends({
    db,
    clock,
    subscribers,
    rootUrl: () => "http://fixture.test",
    ended: (send) => ended.push({ uuid: send.uuid, status: send.status, error: send.error }),
  });
  open.push(() => {
    journal.close();
    subscribers.close();
    lists.close();
    db.close(true);
    rmSync(directory, { recursive: true, force: true });
  });
  const uuid = (id: bigint) =>
    db.query<{ uuid: string }, [bigint]>("SELECT uuid FROM sends WHERE id = ?").get(id)!.uuid;
  const row = (id: bigint) =>
    db
      .query<{ status: string; error: string | null; skip_reason: string | null }, [bigint]>(
        "SELECT status, error, skip_reason FROM sends WHERE id = ?",
      )
      .get(id)!;
  const enqueue = (input: Partial<Parameters<typeof journal.enqueue>[0]> = {}) =>
    BigInt(
      journal.enqueue({
        source: "tx",
        kind: "transactional",
        message: message(),
        ...input,
      }).id as number,
    );
  /** An emailer whose pushes the test settles by hand. */
  const pushes: Array<{ resolve(o: Outcome): void; reject(e: Error): void }> = [];
  const emailer = {
    push: () => {
      let resolve!: (o: Outcome) => void;
      let reject!: (e: Error) => void;
      const result = new Promise<Outcome>((a, b) => {
        resolve = a;
        reject = b;
      });
      pushes.push({ resolve, reject });
      return { messageId: "<m@example.test>", result };
    },
  };
  const outbox = () => {
    const running = startOutbox({
      db,
      clock,
      logger: { error: (e) => errors.push(e) },
      sends: journal,
      emailer: emailer as never,
    });
    open.push(async () => {
      for (const p of pushes) p.resolve(accepted);
      await running.stop().catch(() => {});
    });
    return running;
  };
  return {
    clock,
    db,
    journal,
    subscribers,
    ended,
    errors,
    uuid,
    row,
    enqueue,
    pushes,
    outbox,
  };
}

test("a dispatch push that outlives its lease is moved to unknown by the next pass", async () => {
  const f = fixture();
  const outbox = f.outbox();
  const id = f.enqueue();
  void outbox.dispatch([id]);
  expect(f.row(id).status).toBe("sending");
  // A healthy push is bounded at 60 s; its lease must outlast that.
  await f.clock.whenSleeping();
  for (let i = 0; i < 90; i++) {
    f.clock.advance(1000);
    await tick();
  }
  expect(f.row(id).status).toBe("sending");
  for (let i = 0; i < 60; i++) {
    f.clock.advance(1000);
    await tick();
  }
  expect(f.row(id)).toMatchObject({ status: "unknown", error: "interrupted" });
  expect(f.ended).toEqual([{ uuid: f.uuid(id), status: "unknown", error: "interrupted" }]);
  // The late outcome of the abandoned push does not change the row or fire a second webhook.
  f.pushes[0]!.resolve(accepted);
  await tick();
  expect(f.row(id)).toMatchObject({ status: "unknown", error: "interrupted" });
  expect(f.ended).toHaveLength(1);
});

test("a rejected dispatch push leaves its row unknown, not sending", async () => {
  const f = fixture();
  const outbox = f.outbox();
  const id = f.enqueue();
  const done = outbox.dispatch([id]);
  f.pushes[0]!.reject(new Error("socket reset"));
  await done;
  expect(f.row(id)).toMatchObject({ status: "unknown", error: "uncertain" });
  expect(f.ended).toEqual([{ uuid: f.uuid(id), status: "unknown", error: "uncertain" }]);
});

test("a rejected loop push settles its rows before the loop fails", async () => {
  const f = fixture();
  const a = f.enqueue();
  const b = f.enqueue({ message: message("other@example.test") });
  const outbox = f.outbox();
  while (f.pushes.length < 2) await tick();
  f.pushes[0]!.resolve(accepted);
  f.pushes[1]!.reject(new Error("socket reset"));
  await expect(outbox.done).rejects.toThrow("socket reset");
  expect(f.row(a).status).toBe("sent");
  expect(f.row(b)).toMatchObject({ status: "unknown", error: "uncertain" });
});

test("a send whose subscriber is deleted mid-send is skipped, not re-queued", () => {
  const f = fixture();
  const subscriber = f.subscribers.create(
    { email: "gone@example.test", name: "Gone" },
    { all: true, ids: [] },
  );
  const id = f.enqueue({
    subscriberId: subscriber.id,
    message: message("gone@example.test"),
  });
  const now = f.clock.now();
  const [claimed] = f.journal.claimBatch(now, new Date(now.getTime() + 120_000), 1);
  expect(claimed!.row.id).toBe(id);
  f.db.transaction(() =>
    createSendAnonymizer(f.db)([{ id: subscriber.id, email: subscriber.email }]),
  )();
  f.journal.finishAll([{ row: claimed!.row, outcome: transient }]);
  expect(f.row(id)).toMatchObject({
    status: "skipped",
    skip_reason: "subscriber_unavailable",
  });
  f.clock.advance(60_000);
  expect(
    f.journal.claimBatch(f.clock.now(), new Date(f.clock.now().getTime() + 120_000), 1),
  ).toEqual([]);
  expect(f.ended).toEqual([]);
});

// B22 (D61, D85): a send anonymized while in flight ends without a `send.failed` webhook, whatever
// its outcome. The `ended` hook is the producer's only input. test/webhooks/wiped-send.test.ts
// covers `failed` and a restart through a receiver; the cases here add `unknown`.
for (const [name, outcome, status, error] of [
  ["a permanent rejection", permanent, "failed", "not_accepted"],
  [
    "an ambiguous outcome",
    { ...transient, status: "ambiguous" } as Outcome,
    "unknown",
    "uncertain",
  ],
] as const) {
  test(`a send anonymized mid-flight ends ${status} without an end event: ${name}`, () => {
    const f = fixture();
    const subscriber = f.subscribers.create(
      { email: "wiped@example.test", name: "Wiped" },
      { all: true, ids: [] },
    );
    const id = f.enqueue({
      subscriberId: subscriber.id,
      message: message("wiped@example.test"),
    });
    const now = f.clock.now();
    const [claimed] = f.journal.claimBatch(now, new Date(now.getTime() + 120_000), 1);
    f.db.transaction(() =>
      createSendAnonymizer(f.db)([{ id: subscriber.id, email: subscriber.email }]),
    )();
    f.journal.finishAll([{ row: claimed!.row, outcome }]);
    expect(f.row(id)).toMatchObject({ status, error });
    expect(f.ended).toEqual([]);
  });
}

test("a send that is not anonymized still reports its end", () => {
  const f = fixture();
  const id = f.enqueue();
  const now = f.clock.now();
  const [claimed] = f.journal.claimBatch(now, new Date(now.getTime() + 120_000), 1);
  f.journal.finishAll([{ row: claimed!.row, outcome: permanent }]);
  expect(f.ended).toEqual([{ uuid: f.uuid(id), status: "failed", error: "not_accepted" }]);
});

test("a wiped send whose lease expires in the outbox pass ends silently; an unrelated one reports", async () => {
  const f = fixture();
  const outbox = f.outbox();
  const subscriber = f.subscribers.create(
    { email: "wiped@example.test", name: "Wiped" },
    { all: true, ids: [] },
  );
  const wiped = f.enqueue({ subscriberId: subscriber.id, message: message("wiped@example.test") });
  const other = f.enqueue({ message: message("stranger@example.test") });
  void outbox.dispatch([wiped, other]);
  expect(f.row(wiped).status).toBe("sending");
  expect(f.row(other).status).toBe("sending");
  f.db.transaction(() =>
    createSendAnonymizer(f.db)([{ id: subscriber.id, email: subscriber.email }]),
  )();
  await f.clock.whenSleeping();
  for (let i = 0; i < 150; i++) {
    f.clock.advance(1000);
    await tick();
  }
  expect(f.row(wiped)).toMatchObject({ status: "unknown", error: "interrupted" });
  expect(f.row(other)).toMatchObject({ status: "unknown", error: "interrupted" });
  expect(f.ended).toEqual([{ uuid: f.uuid(other), status: "unknown", error: "interrupted" }]);
});
