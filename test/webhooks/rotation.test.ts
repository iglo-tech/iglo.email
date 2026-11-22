// Secret rotation (D130) through the HTTP API, the injected clock and a local receiver.
import { afterEach, expect, test } from "bun:test";
import { writeTransaction } from "@/db/transaction";
import { startPurge } from "@/loops/purge";
import { txFixture } from "@/test/tx/fixture";
import type { TxFixture } from "@/test/tx/fixture";
import { signatureCount, signatureValid, startReceiver } from "@/test/webhooks/receiver";
import type { Receiver } from "@/test/webhooks/receiver";
import { asBody } from "@/test/read-body";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const all = ["subscriber.blocklisted", "subscriber.deleted"];

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) {
    await close();
  }
});
async function open() {
  const f = await txFixture({ webhooks: {}, reject: () => true });
  cleanups.push(() => f.close());
  return f;
}
function receiver() {
  const r = startReceiver();
  cleanups.push(() => r.close());
  return r;
}
async function hook(f: TxFixture, r: Receiver): Promise<{ id: number; secret: string }> {
  const created = await f.json("/api/webhooks", "POST", { url: r.url(), events: all });
  expect(created.status).toBe(200);
  return asBody<{ id: number; secret: string }>(created.body.data);
}
async function rotate(f: TxFixture, id: number, body?: unknown) {
  return f.json(`/api/webhooks/${id}/rotate-secret`, "POST", body);
}
async function listed(f: TxFixture, id: number) {
  const page = await f.json("/api/webhooks");
  return asBody<{ results: Array<{ id: number; previous_secret_until: string | null }> }>(
    page.body.data,
  ).results.find((w) => w.id === id)!;
}
/** A blocklisted subscriber queues one `subscriber.blocklisted` delivery. */
async function deliver(f: TxFixture, email: string) {
  const id = await f.subscriber(email, email.split("@")[0]);
  const blocked = await f.json(`/api/subscribers/${id}/blocklist`, "PUT", {});
  expect(blocked.status).toBe(200);
}
async function until(check: () => unknown | Promise<unknown>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("Condition not reached");
    }
    await Bun.sleep(2);
  }
}

test("a rotation answers the new secret once and states when the old one stops", async () => {
  const f = await open();
  const r = receiver();
  const created = await hook(f, r);
  const rotated = await rotate(f, created.id);
  expect(rotated.status).toBe(200);
  const { secret }: { secret: string } = rotated.body.data;
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  expect(secret).not.toBe(created.secret);
  expect(rotated.body.data.previous_secret_until).toBe(
    new Date(f.clock.now().getTime() + DAY).toISOString(),
  );
  // Neither secret is ever listed again; the stated end is the only thing a list shows.
  const text = JSON.stringify((await f.json("/api/webhooks")).body);
  expect(text).not.toContain(secret);
  expect(text).not.toContain(created.secret);
  expect((await listed(f, created.id)).previous_secret_until).toBe(
    rotated.body.data.previous_secret_until,
  );
});

test("deliveries during the window carry both signatures and verify with either secret", async () => {
  const f = await open();
  const r = receiver();
  const created = await hook(f, r);
  const { secret }: { secret: string } = (await rotate(f, created.id, {})).body.data;
  await deliver(f, "window@example.test");
  await r.waitFor(1);
  const [delivery] = r.received;
  expect(signatureCount(delivery!)).toBe(2);
  expect(signatureValid(delivery!, secret)).toBe(true);
  expect(signatureValid(delivery!, created.secret)).toBe(true);
  expect(signatureValid(delivery!, "x".repeat(64))).toBe(false);
});

test("after the window only the new secret signs, judged by the injected clock", async () => {
  const f = await open();
  const r = receiver();
  const created = await hook(f, r);
  const { secret }: { secret: string } = (await rotate(f, created.id, { overlap_hours: 24 })).body
    .data;
  f.advanceWebhooks(DAY - 1000);
  await deliver(f, "inside@example.test");
  await r.waitFor(1);
  expect(signatureCount(r.received[0]!)).toBe(2);
  expect(signatureValid(r.received[0]!, created.secret)).toBe(true);

  f.advanceWebhooks(1000);
  await deliver(f, "after@example.test");
  await r.waitFor(2);
  const after = r.received[1]!;
  expect(signatureCount(after)).toBe(1);
  expect(signatureValid(after, secret)).toBe(true);
  expect(signatureValid(after, created.secret)).toBe(false);
});

test("overlap 0 switches at once and states no end", async () => {
  const f = await open();
  const r = receiver();
  const created = await hook(f, r);
  const rotated = await rotate(f, created.id, { overlap_hours: 0 });
  expect(rotated.body.data.previous_secret_until).toBeNull();
  await deliver(f, "switched@example.test");
  await r.waitFor(1);
  expect(signatureCount(r.received[0]!)).toBe(1);
  expect(signatureValid(r.received[0]!, rotated.body.data.secret)).toBe(true);
  expect(signatureValid(r.received[0]!, created.secret)).toBe(false);
});

test("a rotation ends an earlier old secret still in its window, so one rotation is one step", async () => {
  const f = await open();
  const r = receiver();
  const created = await hook(f, r);
  const first: { secret: string } = (await rotate(f, created.id)).body.data;
  const second: { secret: string } = (await rotate(f, created.id)).body.data;
  await deliver(f, "chained@example.test");
  await r.waitFor(1);
  expect(signatureCount(r.received[0]!)).toBe(2);
  expect(signatureValid(r.received[0]!, second.secret)).toBe(true);
  expect(signatureValid(r.received[0]!, first.secret)).toBe(true);
  expect(signatureValid(r.received[0]!, created.secret)).toBe(false);
});

test("overlap_hours is an integer from 0 to 168, and a bad body changes nothing", async () => {
  const f = await open();
  const r = receiver();
  const created = await hook(f, r);
  for (const body of [
    { overlap_hours: -1 },
    { overlap_hours: 169 },
    { overlap_hours: 1.5 },
    { overlap_hours: "24" },
    { overlap_hours: null },
    [],
  ]) {
    const refused = await rotate(f, created.id, body);
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("invalid_fields");
  }
  expect((await listed(f, created.id)).previous_secret_until).toBeNull();
  const widest = await rotate(f, created.id, { overlap_hours: 168 });
  expect(widest.status).toBe(200);
  expect(widest.body.data.previous_secret_until).toBe(
    new Date(f.clock.now().getTime() + 7 * DAY).toISOString(),
  );
});

test("the body holds only overlap_hours: a supplied secret or any other key is refused, and nothing rotates", async () => {
  const f = await open();
  const r = receiver();
  const created = await hook(f, r);
  for (const { body, key } of [
    { body: { overlap_hours: 1, secret: "x".repeat(32) }, key: "secret" },
    { body: { secret: "x".repeat(32) }, key: "secret" },
    { body: { overlap_hours: 1, unknown: true }, key: "unknown" },
    { body: { overlap_hours: 1, overlap: 2 }, key: "overlap" },
  ]) {
    const refused = await rotate(f, created.id, body);
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("invalid_fields");
    expect(refused.body.message).toBe(`Invalid fields: ${key}`);
  }
  expect((await listed(f, created.id)).previous_secret_until).toBeNull();
});

test("an empty body uses the default window, and a missing webhook is 404", async () => {
  const f = await open();
  const r = receiver();
  const created = await hook(f, r);
  const bare = await rotate(f, created.id);
  expect(bare.status).toBe(200);
  expect(bare.body.data.previous_secret_until).toBe(
    new Date(f.clock.now().getTime() + DAY).toISOString(),
  );
  const missing = await rotate(f, 999, {});
  expect(missing.status).toBe(404);
  expect(missing.body.code).toBe("not_found");
});

test("rotating needs webhooks:manage and the usual auth", async () => {
  const f = await open();
  const r = receiver();
  const created = await hook(f, r);
  const role = await f.json("/api/roles/users", "POST", {
    name: "no-rotation",
    permissions: ["subscribers:get"],
  });
  const user = await f.json("/api/users", "POST", {
    username: "no-rotation",
    type: "api",
    status: "enabled",
    user_role_id: role.body.data.id,
  });
  const basic = { authorization: `Basic ${btoa(`no-rotation:${user.body.data.password}`)}` };
  const denied = await f.json(`/api/webhooks/${created.id}/rotate-secret`, "POST", {}, basic);
  expect(denied.status).toBe(403);
  expect(denied.body.code).toBe("permission_denied");
  const anonymous = await f.json(`/api/webhooks/${created.id}/rotate-secret`, "POST", {}, {});
  expect(anonymous.status).toBe(403);
  const headers: Record<string, string> = f.sessionHeaders;
  const { "x-csrf-token": _csrf, ...noCsrf } = headers;
  const forged = await f.json(`/api/webhooks/${created.id}/rotate-secret`, "POST", {}, noCsrf);
  expect(forged.status).toBe(403);
  expect((await listed(f, created.id)).previous_secret_until).toBeNull();
});

/** The webhook's deliveries, as the API lists them. */
async function deliveries(f: TxFixture, id: number) {
  const page = await f.json(`/api/webhooks/${id}/deliveries?per_page=100`);
  return asBody<Array<{ attempts: number; status: string; claimed_until: string | null }>>(
    page.body.data.results,
  );
}
/** Until the row has made `attempts` attempts and waits, unclaimed, for its next one. */
const waitingAfter = (f: TxFixture, id: number, attempts: number) =>
  until(async () => {
    const [row] = await deliveries(f, id);
    return row?.attempts === attempts && row.status === "queued" && !row.claimed_until;
  });

test("a delivery queued before a rotation is signed with both secrets in its window, and with the new one after it", async () => {
  const f = await open();
  let up = false;
  const r = startReceiver(() => new Response(up ? "ok" : "down", { status: up ? 200 : 500 }));
  cleanups.push(() => r.close());
  const created = await hook(f, r);
  // Attempted before the rotation while the receiver is down, so the row waits for its retry.
  await deliver(f, "queued@example.test");
  await r.waitFor(1);
  await waitingAfter(f, created.id, 1);
  expect(signatureCount(r.received[0]!)).toBe(1);
  expect(signatureValid(r.received[0]!, created.secret)).toBe(true);
  const rotated: { secret: string } = (await rotate(f, created.id, { overlap_hours: 1 })).body.data;

  // The retry is due within 30 s of the failed attempt, well inside the hour: both secrets sign.
  f.advanceWebhooks(30_000);
  await r.waitFor(2);
  await waitingAfter(f, created.id, 2);
  const inWindow = r.received[1]!;
  expect(signatureCount(inWindow)).toBe(2);
  expect(signatureValid(inWindow, rotated.secret)).toBe(true);
  expect(signatureValid(inWindow, created.secret)).toBe(true);

  // Two hours on, past the window's end and within the delivery's day: the retry signs with the new secret alone.
  up = true;
  f.advanceWebhooks(2 * HOUR);
  await r.waitFor(3);
  const afterWindow = r.received[2]!;
  expect(signatureCount(afterWindow)).toBe(1);
  expect(signatureValid(afterWindow, rotated.secret)).toBe(true);
  expect(signatureValid(afterWindow, created.secret)).toBe(false);
  await until(async () => (await deliveries(f, created.id))[0]?.status === "delivered");
});

test("the retention pass ends a window once it has passed, and not before", async () => {
  const f = await open();
  const r = receiver();
  const created = await hook(f, r);
  await rotate(f, created.id, { overlap_hours: 1 });
  const windowEnd: string = (await listed(f, created.id)).previous_secret_until!;
  const logger = {
    error: (e: unknown) => f.errors.push(e),
    attention: (m: string) => f.errors.push(new Error(m)),
  };
  // A pass before the window's end takes nothing.
  f.clock.advance(HOUR - 1000);
  expect(writeTransaction(f.db, () => f.webhooks!.expireSecrets(f.clock.now()))).toEqual([]);
  expect((await listed(f, created.id)).previous_secret_until).toBe(windowEnd);
  // The loop's first pass at the window's end ends it.
  f.clock.advance(1000);
  const loop = startPurge({
    db: f.db,
    clock: f.clock,
    logger,
    purges: [f.webhooks!.expireSecrets],
  });
  await until(async () => (await listed(f, created.id)).previous_secret_until === null);
  await loop.stop();
  expect(f.errors).toEqual([]);
});
