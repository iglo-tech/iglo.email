// The receiver helper that docs/operations.md documents (D130), against a real delivery from the
// server and a local receiver. The sync test reads the docs and the fixture as text on purpose: the
// documented snippet must be exactly the code that is tested.
import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { txFixture } from "@/test/tx/fixture";
import { verifyDelivery } from "@/test/webhooks/verify-delivery";
import { signatureTime, startReceiver } from "@/test/webhooks/receiver";

/** No delivery id has been applied yet. */
const fresh = () => false;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) {
    await close();
  }
});

/** One real delivery of `subscriber.blocklisted`, signed with `secret`, and its receiver. */
async function oneDelivery() {
  const f = await txFixture({ webhooks: {}, reject: () => true });
  cleanups.push(() => f.close());
  const r = startReceiver();
  cleanups.push(() => r.close());
  const created = await f.json("/api/webhooks", "POST", {
    url: r.url(),
    events: ["subscriber.blocklisted"],
  });
  const id = await f.subscriber("verify@example.test", "verify");
  await f.json(`/api/subscribers/${id}/blocklist`, "PUT", {});
  await r.waitFor(1);
  const [received] = r.received;
  const secret: string = created.body.data.secret;
  return { received: received!, secret };
}

test("the documented helper verifies a real delivery and returns it", async () => {
  const { received, secret } = await oneDelivery();
  const now = signatureTime(received);
  const delivery = verifyDelivery(received.text, received.signature, [secret], () => false, now);
  expect(delivery.id).toBe(received.body.id);
  expect(delivery.event).toBe("subscriber.blocklisted");
});

test("a tampered body, a stale or future timestamp, a replay and a wrong secret are rejected", async () => {
  const { received, secret } = await oneDelivery();
  const now = signatureTime(received);
  const tampered = received.text.replace("verify@example.test", "other@example.test");
  expect(() => verifyDelivery(tampered, received.signature, [secret], fresh, now)).toThrow(
    "bad_signature",
  );
  expect(() =>
    verifyDelivery(received.text, received.signature, [secret], fresh, now + 300),
  ).not.toThrow();
  expect(() =>
    verifyDelivery(received.text, received.signature, [secret], fresh, now + 301),
  ).toThrow("bad_timestamp");
  expect(() =>
    verifyDelivery(received.text, received.signature, [secret], fresh, now - 301),
  ).toThrow("bad_timestamp");
  expect(() =>
    verifyDelivery(received.text, received.signature, [secret], () => true, now),
  ).toThrow("replay");
  expect(() =>
    verifyDelivery(received.text, received.signature, ["x".repeat(64)], fresh, now),
  ).toThrow("bad_signature");
  expect(() => verifyDelivery(received.text, "", [secret], fresh, now)).toThrow("bad_timestamp");
});

test("during a rotation either secret verifies, and a secret the receiver does not hold does not", async () => {
  const f = await txFixture({ webhooks: {}, reject: () => true });
  cleanups.push(() => f.close());
  const r = startReceiver();
  cleanups.push(() => r.close());
  const created = await f.json("/api/webhooks", "POST", {
    url: r.url(),
    events: ["subscriber.blocklisted"],
  });
  const rotated = await f.json(`/api/webhooks/${created.body.data.id}/rotate-secret`, "POST", {});
  const id = await f.subscriber("rotated@example.test", "rotated");
  await f.json(`/api/subscribers/${id}/blocklist`, "PUT", {});
  await r.waitFor(1);
  const [received] = r.received;
  const now = signatureTime(received!);
  const { text, signature } = received!;
  expect(verifyDelivery(text, signature, [rotated.body.data.secret], fresh, now).id).toBeString();
  expect(verifyDelivery(text, signature, [created.body.data.secret], fresh, now).event).toBe(
    "subscriber.blocklisted",
  );
  expect(() => verifyDelivery(text, signature, ["y".repeat(64)], fresh, now)).toThrow(
    "bad_signature",
  );
});

test("the snippet in docs/operations.md is the tested file", async () => {
  const repository = resolve(import.meta.dir, "../..");
  const docs = await readFile(join(repository, "docs/operations.md"), "utf-8");
  const fixture = await readFile(join(import.meta.dir, "verify-delivery.ts"), "utf-8");
  const heading = docs.indexOf("### Verifying a delivery");
  expect(heading).toBeGreaterThan(-1);
  const open = docs.indexOf("```ts\n", heading);
  const close = docs.indexOf("\n```", open + 6);
  expect(open).toBeGreaterThan(-1);
  expect(docs.slice(open + 6, close).trim()).toBe(fixture.trim());
});
