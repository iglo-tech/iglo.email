// B23 (D80): a push that throws before any pool saw the message never left, so it is not
// journaled `unknown`. Through POST /api/tx, the outbox loop and the SMTP sink.
import { afterEach, expect, test } from "bun:test";
import { placeRestoreHold, releaseRestoreHold, restoreHold, holdRecord } from "@/settings/hold";
import { HttpError } from "@/server/response";
import { txFixture, type TxFixture } from "@/test/tx/fixture";

const fixtures: TxFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function until(condition: () => boolean, f: TxFixture) {
  for (const end = performance.now() + 20_000; !condition(); await tick()) {
    if (performance.now() > end) throw new Error("condition not reached");
    f.clock.advance(1000);
  }
}
const row = (f: TxFixture) =>
  f.db.query("SELECT status, attempts, error, claimed_until FROM sends").get() as {
    status: string;
    attempts: bigint;
    error: string | null;
    claimed_until: string | null;
  };

test("a send refused by the restore hold goes back to queued, uncounted, and is sent once after release", async () => {
  let armed = false;
  const f = await txFixture({
    refuse: () => {
      if (!armed) return;
      // The hold lands between the loop's check and the push: the emailer's last gate refuses.
      placeRestoreHold(f.db, f.clock.now().toISOString());
      throw new HttpError(503, "Sending is held.");
    },
  });
  fixtures.push(f);
  const template = await f.template("<p>x</p>");
  armed = true;
  const sent = await f.tx({
    subscriber_email: "held@example.test",
    subscriber_mode: "external",
    template_id: template,
    async: true,
  });
  expect(sent.status).toBe(200);
  await until(() => restoreHold(f.db) !== null, f);
  await until(() => row(f).status === "queued", f);
  expect(row(f)).toMatchObject({
    status: "queued",
    attempts: 0n,
    claimed_until: null,
  });
  // Held: the loop claims nothing, however long it runs.
  for (let i = 0; i < 10; i++) {
    f.clock.advance(1000);
    await tick();
  }
  expect(row(f)).toMatchObject({ status: "queued", attempts: 0n });
  expect(f.sink.messages).toHaveLength(0);
  expect(f.errors).toEqual([]);
  armed = false;
  releaseRestoreHold(f.db, holdRecord(f.db)!, f.clock.now().toISOString());
  await until(() => f.sink.messages.length >= 1, f);
  await until(() => row(f).status === "sent", f);
  expect(f.sink.messages).toHaveLength(1);
  expect(row(f)).toMatchObject({ status: "sent", attempts: 1n });
});

test("any other synchronous push failure fails the row with a concrete error, never unknown", async () => {
  const f = await txFixture({
    refuse: () => {
      throw new Error("boom");
    },
  });
  fixtures.push(f);
  const template = await f.template("<p>x</p>");
  // A direct send dispatches at once: the failure is logged and the journal is settled.
  const response = await f.tx({
    subscriber_email: "a@example.test",
    subscriber_mode: "external",
    template_id: template,
  });
  expect(response.status).toBe(200);
  expect(row(f)).toMatchObject({
    status: "failed",
    error: "push_failed",
    claimed_until: null,
  });
  expect(response.body.data.sends[0]).toMatchObject({ status: "failed" });
  expect(f.sink.messages).toHaveLength(0);
  expect(f.errors.length).toBeGreaterThan(0);
});
