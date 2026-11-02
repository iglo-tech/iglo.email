// Permanent regressions for the batched journal paths of `claimBatch` and `finishAll`
// (PR #32 review): mixed outcomes, the same-subscriber cap inside one batch, and a COMMIT that
// fails. They use the journal's exported functions only, with the injected clock.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createListReferences } from "@/lists/references";
import type { Outcome } from "@/messaging/email";
import { createSends } from "@/messaging/sends";
import { createSubscriberStore } from "@/subscribers/store";
import { TestClock } from "@/test/server/fixture";

const open: Array<() => void> = [];
afterEach(() => {
  for (const close of open.splice(0)) close();
});

const outcome = (status: Outcome["status"], retry?: "transient"): Outcome => ({
  messageId: "<m@example.test>",
  status,
  stage:
    status === "accepted" ? "smtp-complete" : status === "ambiguous" ? "unknown" : "recipients",
  accepted: status === "accepted" ? ["recipient@example.test"] : [],
  rejected: [],
  ...(retry ? { retry } : {}),
});
const message = (to = "recipient@example.test") => ({
  from: "sender@example.test",
  to: [to],
  subject: "synthetic subject",
  contentType: "plain" as const,
  body: Buffer.from("synthetic body"),
  headers: {},
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "iglo-finish-"));
  const clock = new TestClock();
  const db = openDatabase(directory);
  runMigrations(db, directory, clock, productionMigrations);
  const lists = createListReferences(db);
  const subscribers = createSubscriberStore(db, clock, lists);
  const journal = createSends({
    db,
    clock,
    subscribers,
    rootUrl: () => "http://fixture.test",
    // Consent always granted; a one-hour cap, counted from the clock.
    marketingPolicy: {
      consent: () => null,
      capStart: (now) => new Date(now.getTime() - 3_600_000),
    },
  });
  open.push(() => {
    journal.close();
    subscribers.close();
    lists.close();
    db.close(true);
    rmSync(directory, { recursive: true, force: true });
  });
  const subscriber = (email: string) =>
    subscribers.create({ email, name: "Fixture" }, { all: true, ids: [] });
  const row = (id: bigint) =>
    db
      .query<
        { status: string; error: string | null; attempts: bigint; next_attempt_at: string | null },
        [bigint]
      >("SELECT status, error, attempts, next_attempt_at FROM sends WHERE id = ?")
      .get(id)!;
  const enqueue = (input: Parameters<typeof journal.enqueue>[0]) =>
    BigInt(journal.enqueue(input).id as number);
  const claim = (limit: number) => {
    const now = clock.now();
    return journal.claimBatch(now, new Date(now.getTime() + 60_000), limit);
  };
  return { clock, db, journal, subscriber, enqueue, row, claim };
}

test("one batch journals accepted, retried, failed and ambiguous outcomes together", () => {
  const f = fixture();
  const enqueue = (kind: "transactional" | "marketing", to: string, subscriberId?: bigint) =>
    f.enqueue({
      source: "tx",
      kind,
      message: message(to),
      ...(subscriberId === undefined ? {} : { subscriberId }),
    });
  const marketing = f.subscriber("marketing@example.test");
  const ids = {
    accepted: enqueue("transactional", "a@example.test"),
    retried: enqueue("transactional", "b@example.test"),
    failed: enqueue("transactional", "c@example.test"),
    ambiguous: enqueue("transactional", "d@example.test"),
    // Marketing never retries: a transient answer is a failure.
    marketing: enqueue("marketing", marketing.email, marketing.id),
  };
  const batch = f.claim(10);
  expect(batch.map((c) => c.row.id)).toEqual(Object.values(ids));
  const byId = (id: bigint) => batch.find((c) => c.row.id === id)!.row;
  f.journal.finishAll([
    { row: byId(ids.accepted), outcome: outcome("accepted") },
    { row: byId(ids.retried), outcome: outcome("proven-not-accepted", "transient") },
    { row: byId(ids.failed), outcome: outcome("proven-not-accepted") },
    { row: byId(ids.ambiguous), outcome: outcome("ambiguous") },
    { row: byId(ids.marketing), outcome: outcome("proven-not-accepted", "transient") },
  ]);
  expect(f.row(ids.accepted)).toMatchObject({ status: "sent", error: null });
  // First retry is due one second after the injected now, and keeps its attempt count.
  expect(f.row(ids.retried)).toMatchObject({
    status: "queued",
    error: "temporary_rejection",
    attempts: 1n,
    next_attempt_at: new Date(f.clock.now().getTime() + 1000).toISOString(),
  });
  expect(f.row(ids.failed)).toMatchObject({ status: "failed", error: "not_accepted" });
  expect(f.row(ids.ambiguous)).toMatchObject({ status: "unknown", error: "uncertain" });
  expect(f.row(ids.marketing)).toMatchObject({ status: "failed", error: "temporary_rejection" });
  // Only the retried row is claimable again, and only once its deadline has passed.
  expect(f.claim(10)).toEqual([]);
  f.clock.advance(1000);
  expect(f.claim(10).map((c) => c.row.id)).toEqual([ids.retried]);
});

test("a transactional row stops retrying after five attempts inside a batch", () => {
  const f = fixture();
  const id = f.enqueue({ source: "tx", kind: "transactional", message: message() });
  const transient = outcome("proven-not-accepted", "transient");
  for (let attempt = 1; attempt <= 5; attempt++) {
    const [claimed] = f.claim(10);
    expect(claimed!.row.id).toBe(id);
    f.journal.finishAll([{ row: claimed!.row, outcome: transient }]);
    expect(f.row(id).status).toBe(attempt < 5 ? "queued" : "failed");
    f.clock.advance(1000 * 2 ** attempt);
  }
  expect(f.row(id)).toMatchObject({ status: "failed", attempts: 5n });
});

test("two marketing rows for one subscriber in one batch: the first sends, the second is capped", () => {
  const f = fixture();
  const one = f.subscriber("one@example.test");
  const other = f.subscriber("other@example.test");
  const enqueue = (s: { id: bigint; email: string }) =>
    f.enqueue({
      source: "tx",
      kind: "marketing",
      message: message(s.email),
      subscriberId: s.id,
    });
  const first = enqueue(one);
  const second = enqueue(one);
  const unrelated = enqueue(other);
  const batch = f.claim(10);
  // The second row saw the first as `sending` when it was admitted, before any SMTP.
  expect(batch.map((c) => c.message !== null)).toEqual([true, false, true]);
  expect(f.row(second)).toMatchObject({ status: "skipped" });
  expect(
    f.db
      .query<{ skip_reason: string }, [bigint]>("SELECT skip_reason FROM sends WHERE id = ?")
      .get(second)!.skip_reason,
  ).toBe("frequency_cap");
  f.journal.finishAll(
    batch.flatMap((c) => (c.message ? [{ row: c.row, outcome: outcome("accepted") }] : [])),
  );
  expect(f.row(first).status).toBe("sent");
  expect(f.row(unrelated).status).toBe("sent");
  // Skipped rows are not claimed again, and the cap still holds a later attempt for an hour.
  expect(f.claim(10)).toEqual([]);
  const later = enqueue(one);
  expect(f.claim(10).map((c) => c.message !== null)).toEqual([false]);
  expect(f.row(later).status).toBe("skipped");
  f.clock.advance(3_600_001);
  const afterCap = enqueue(one);
  expect(f.claim(10).map((c) => c.message !== null)).toEqual([true]);
  expect(f.row(afterCap).status).toBe("sending");
});

test("a COMMIT that fails rolls back every outcome of the batch", () => {
  const f = fixture();
  const ids = ["a", "b", "c"].map((name) =>
    f.enqueue({
      source: "tx",
      kind: "transactional",
      message: message(`${name}@example.test`),
    }),
  );
  const batch = f.claim(10);
  const results = batch.map((c, i) => ({
    row: c.row,
    outcome: i === 1 ? outcome("proven-not-accepted") : outcome("accepted"),
  }));
  // A deferred foreign key is checked only at COMMIT, after every UPDATE has succeeded.
  f.db.run("PRAGMA foreign_keys = ON");
  f.db.run("CREATE TABLE commit_parent(id INTEGER PRIMARY KEY)");
  f.db.run(
    "CREATE TABLE commit_child(parent INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED)",
  );
  f.db.run(
    "CREATE TRIGGER commit_fault AFTER UPDATE OF status ON sends WHEN NEW.status IN ('sent', 'failed') BEGIN INSERT INTO commit_child(parent) VALUES (1); END",
  );
  expect(() => f.journal.finishAll(results)).toThrow(/FOREIGN KEY/);
  expect(f.db.inTransaction).toBe(false);
  // Nothing was journaled, including the rows whose own UPDATE had succeeded.
  for (const id of ids) expect(f.row(id)).toMatchObject({ status: "sending", error: null });
  // Once the fault is gone the same results go through: the rows were left claimable by finish.
  f.db.run("DROP TRIGGER commit_fault");
  f.journal.finishAll(results);
  expect(ids.map((id) => f.row(id).status)).toEqual(["sent", "failed", "sent"]);
});

test("a statement that fails rolls back the earlier outcomes of the batch", () => {
  const f = fixture();
  const ids = ["a", "b"].map((name) =>
    f.enqueue({
      source: "tx",
      kind: "transactional",
      message: message(`${name}@example.test`),
    }),
  );
  const batch = f.claim(10);
  f.db.run(
    "CREATE TRIGGER statement_fault BEFORE UPDATE OF status ON sends WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  expect(() =>
    f.journal.finishAll([
      { row: batch[0]!.row, outcome: outcome("accepted") },
      { row: batch[1]!.row, outcome: outcome("proven-not-accepted") },
    ]),
  ).toThrow(/injected/);
  expect(f.db.inTransaction).toBe(false);
  for (const id of ids) expect(f.row(id).status).toBe("sending");
});

test("finishAll with no results writes nothing", () => {
  const f = fixture();
  f.journal.finishAll([]);
  expect(f.db.inTransaction).toBe(false);
});
