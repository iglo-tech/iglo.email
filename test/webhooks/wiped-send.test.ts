// B22 (D61, D85): a send whose subscriber is deleted while it is in flight ends without a
// `send.failed` webhook, seen at a receiver. Absence is shown by order: deliveries leave in the
// order they were queued, so a later control `send.failed` arriving with nothing between it and
// `subscriber.deleted` proves the wiped send queued none.
import { afterEach, expect, test } from "bun:test";
import { writeTransaction } from "@/db/transaction";
import { holdRecord, placeRestoreHold, releaseRestoreHold } from "@/settings/hold";
import { txFixture } from "@/test/tx/fixture";
import { startReceiver } from "@/test/webhooks/receiver";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function open(reject: () => boolean) {
  const f = await txFixture({ webhooks: {}, reject });
  cleanups.push(() => f.close());
  const r = startReceiver();
  cleanups.push(() => r.close());
  const created = await f.json("/api/webhooks", "POST", {
    url: r.url(),
    events: ["send.failed", "subscriber.deleted"],
  });
  expect(created.status).toBe(200);
  return { f, r };
}
const wipe = (f: Awaited<ReturnType<typeof open>>["f"], id: number, wiped: boolean) =>
  writeTransaction(f.db, () => f.owners.subscribers.remove([BigInt(id)], { wipe: wiped }));
const summary = (r: ReturnType<typeof startReceiver>) =>
  r.received.map((x) => [x.body.event, x.body.data.send?.uuid ?? null]);
const uuidOf = (f: Awaited<ReturnType<typeof open>>["f"], email: string) =>
  (
    f.db.query("SELECT uuid FROM sends WHERE to_email = ?").get(email) as {
      uuid: string;
    }
  ).uuid;

for (const wiped of [true, false]) {
  test(`a subscriber deleted during SMTP (wipe: ${wiped}) leaves no send.failed; a control still reports`, async () => {
    let onReject = () => {};
    const { f, r } = await open(() => {
      onReject();
      return true;
    });
    const gone = await f.subscriber("gone@example.test", "Gone");
    const kept = await f.subscriber("kept@example.test", "Kept");
    const template = await f.template("<p>hi</p>");
    let fired = false;
    onReject = () => {
      if (fired) return;
      fired = true;
      wipe(f, gone, wiped);
    };
    expect((await f.tx({ subscriber_id: gone, template_id: template })).status).toBe(200);
    expect(fired).toBe(true);
    // Queued after the wiped send settled: it must be the next delivery after subscriber.deleted.
    onReject = () => {};
    expect((await f.tx({ subscriber_id: kept, template_id: template })).status).toBe(200);
    await r.waitFor(2);
    expect(summary(r)).toEqual([
      ["subscriber.deleted", null],
      ["send.failed", uuidOf(f, "kept@example.test")],
    ]);
    expect(
      f.db.query("SELECT status FROM sends WHERE to_email = ''").get() as {
        status: string;
      },
    ).toEqual({ status: "failed" });
  });
}

test("a restart ends a wiped in-flight send silently and an unrelated one with send.failed", async () => {
  const { f, r } = await open(() => true);
  const gone = await f.subscriber("gone@example.test", "Gone");
  const kept = await f.subscriber("kept@example.test", "Kept");
  await f.stopOutbox();
  const message = (to: string) => ({
    from: "sender@example.test",
    to: [to],
    subject: "s",
    contentType: "plain" as const,
    body: Buffer.from("b"),
    headers: {},
  });
  for (const [id, email] of [
    [gone, "gone@example.test"],
    [kept, "kept@example.test"],
  ] as const)
    f.sends.enqueue({
      source: "tx",
      kind: "transactional",
      subscriberId: BigInt(id),
      message: message(email),
    });
  const now = f.clock.now();
  writeTransaction(f.db, () => f.sends.claimBatch(now, new Date(now.getTime() + 120_000), 2));
  wipe(f, gone, true);
  f.restartOutbox();
  await r.waitFor(2);
  const keptUuid = uuidOf(f, "kept@example.test");
  // A later failing send is queued after the restart's, so nothing can hide between them.
  const template = await f.template("<p>hi</p>");
  const control = await f.subscriber("control@example.test", "Control");
  await f.tx({ subscriber_id: control, template_id: template });
  await r.waitFor(3);
  expect(summary(r)).toEqual([
    ["subscriber.deleted", null],
    ["send.failed", keptUuid],
    ["send.failed", uuidOf(f, "control@example.test")],
  ]);
  expect(r.received[1]!.body.data.send).toMatchObject({
    status: "unknown",
    error: "interrupted",
  });
});

test("a wiped send whose lease expires in the running loop reports nothing; an unrelated one does (B23)", async () => {
  const { f, r } = await open(() => true);
  const gone = await f.subscriber("gone@example.test", "Gone");
  const kept = await f.subscriber("kept@example.test", "Kept");
  // Held, so the loop claims nothing of its own but still expires leases each pass.
  placeRestoreHold(f.db, f.clock.now().toISOString());
  const message = (to: string) => ({
    from: "sender@example.test",
    to: [to],
    subject: "s",
    contentType: "plain" as const,
    body: Buffer.from("b"),
    headers: {},
  });
  for (const [id, email] of [
    [gone, "gone@example.test"],
    [kept, "kept@example.test"],
  ] as const)
    f.sends.enqueue({
      source: "tx",
      kind: "transactional",
      subscriberId: BigInt(id),
      message: message(email),
    });
  // In flight under a claim no push of this process holds, as another holder's.
  const now = f.clock.now();
  writeTransaction(f.db, () => f.sends.claimBatch(now, new Date(now.getTime() + 120_000), 2));
  wipe(f, gone, true);
  f.clock.advance(130_000);
  while ((f.db.query("SELECT 1 FROM sends WHERE status = 'sending'").all() as unknown[]).length)
    await Bun.sleep(5);
  // Webhook deliveries are held with everything else: release now that both rows have ended.
  releaseRestoreHold(f.db, holdRecord(f.db)!, f.clock.now().toISOString());
  f.advanceWebhooks(0);
  await r.waitFor(2);
  expect(summary(r)).toEqual([
    ["subscriber.deleted", null],
    ["send.failed", uuidOf(f, "kept@example.test")],
  ]);
  expect(r.received[1]!.body.data.send).toMatchObject({
    status: "unknown",
    error: "interrupted",
  });
  expect(f.db.query("SELECT status, error FROM sends WHERE to_email = ''").get()).toEqual({
    status: "unknown",
    error: "interrupted",
  });
});
