// Production-only: subscriber events are native (docs/design/05-sequences.md#events-api);
// listmonk has no equivalent endpoint, so there is no reference run. Exercised through the
// compiled executable's real HTTP, auth, restart and SQLite file.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Credentials } from "@/test/contract/types";

export async function runEventsContract(target: {
  baseUrl: string;
  credentials: Credentials;
  restart: () => Promise<void>;
  dataDir: string;
}) {
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL events-${label}`);
  };
  const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = { authorization },
  ) => {
    const response = await fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const post = (body: unknown, headers?: Record<string, string>) =>
    call("/api/subscriber-events", "POST", body, headers);
  const stored = () => {
    const db = new Database(join(target.dataDir, "iglo-email.db"), {
      readonly: true,
      safeIntegers: true,
    });
    try {
      return db
        .query(
          "SELECT id, subscriber_id, name, data, occurred_at, created_at FROM events ORDER BY id",
        )
        .all() as { id: bigint; subscriber_id: bigint; name: string; data: string }[];
    } finally {
      db.close();
    }
  };

  // Auth: no credential and a credential without the permission are rejected without writes.
  const body = {
    subscriber: { external_id: "c_1", email: "Contract@Example.com", attribs: { plan: "trial" } },
    name: "subscription_created",
    data: { price: 79 },
    idempotency_key: "contract:1",
  };
  check((await post(body, {})).status === 403, "anonymous");
  const role = await call("/api/roles/users", "POST", {
    name: "events-contract-denied",
    permissions: ["subscribers:manage"],
  });
  const denied = await call("/api/users", "POST", {
    username: "events-contract-denied",
    type: "api",
    status: "enabled",
    user_role_id: role.body.data.id,
  });
  const deniedAuth = `Basic ${btoa(`events-contract-denied:${denied.body.data.password}`)}`;
  const forbidden = await post(body, { authorization: deniedAuth });
  check(
    forbidden.status === 403 &&
      forbidden.body.message === "permission denied: subscriber_events:create",
    "permission",
  );
  check(stored().length === 0, "no-write-denied");

  // Create, then concurrent retries of the same key all replay the first result.
  const first = await post(body);
  check(
    first.status === 200 &&
      typeof first.body.data.event_id === "number" &&
      typeof first.body.data.subscriber_id === "number" &&
      JSON.stringify(first.body.data.enrollments) === '{"started":[],"ended":[]}',
    "create",
  );
  const subscriber = await call(`/api/subscribers/${first.body.data.subscriber_id}`);
  check(
    subscriber.body.data.email === "contract@example.com" &&
      subscriber.body.data.status === "enabled" &&
      subscriber.body.data.lists.length === 0 &&
      JSON.stringify(subscriber.body.data.attribs) === '{"plan":"trial"}',
    "subscriber",
  );
  const retries = await Promise.all(
    Array.from({ length: 16 }, () =>
      post({ ...body, subscriber: { external_id: "c_1", attribs: { plan: "paid" } } }),
    ),
  );
  for (const r of retries) check(JSON.stringify(r) === JSON.stringify(first), "concurrent-replay");
  // Concurrent distinct first requests for one new subscriber create it once.
  const racing = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      post({
        subscriber: { email: "race@example.com" },
        name: "race",
        idempotency_key: `r${i % 4}`,
      }),
    ),
  );
  check(
    racing.every((r) => r.status === 200) &&
      new Set(racing.map((r) => r.body.data.subscriber_id)).size === 1 &&
      new Set(racing.map((r) => r.body.data.event_id)).size === 4,
    "concurrent-create",
  );

  // Restart: the key still replays and nothing changes.
  await target.restart();
  const after = await post({ ...body, subscriber: { external_id: "c_1", attribs: { plan: "x" } } });
  check(JSON.stringify(after) === JSON.stringify(first), "restart-replay");
  const unchanged = await call(`/api/subscribers/${first.body.data.subscriber_id}`);
  check(JSON.stringify(unchanged.body.data.attribs) === '{"plan":"trial"}', "restart-attribs");

  // Upsert by external_id updates the address and merges attributes; conflicts write nothing.
  const updated = await post({
    subscriber: { external_id: "c_1", email: "moved@example.com", attribs: { plan: null, n: 1 } },
    name: "moved",
  });
  check(updated.body.data.subscriber_id === first.body.data.subscriber_id, "update");
  const moved = await call(`/api/subscribers/${first.body.data.subscriber_id}`);
  check(
    moved.body.data.email === "moved@example.com" &&
      JSON.stringify(moved.body.data.attribs) === '{"n":1}',
    "merge",
  );
  const before = stored().length;
  const conflict = await post({
    subscriber: { external_id: "c_1", email: "race@example.com", attribs: { n: 2 } },
    name: "conflict",
  });
  check(conflict.status === 409, "conflict");
  check(stored().length === before, "conflict-no-event");
  const missing = await post({ subscriber: { external_id: "nobody" }, name: "x" });
  check(missing.status === 404, "missing");

  // Batch: per-item results, atomic items.
  const batch = await call("/api/subscriber-events/batch", "POST", {
    events: [
      { subscriber: { email: "batch@example.com" }, name: "b1" },
      { subscriber: { external_id: "c_1", email: "race@example.com" }, name: "b2" },
      {
        subscriber: { email: "batch@example.com" },
        name: "b3",
        occurred_at: "2020-01-01T00:00:00Z",
      },
      { name: "b4" },
    ],
  });
  check(
    batch.status === 200 &&
      JSON.stringify(batch.body.data.results.map((r: { status: number }) => r.status)) ===
        "[200,409,200,400]",
    "batch",
  );
  const rows = stored();
  check(rows.length === before + 2, "batch-rows");
  const last = rows.at(-1)!;
  check(
    last.name === "b3" &&
      (last as unknown as { occurred_at: string }).occurred_at === "2020-01-01T00:00:00.000Z",
    "backfill-stored",
  );
  check(
    (
      await call("/api/subscriber-events/batch", "POST", {
        events: Array.from({ length: 501 }, () => ({
          subscriber: { email: "x@example.com" },
          name: "x",
        })),
      })
    ).status === 400,
    "batch-limit",
  );
  const oversized = await fetch(`${target.baseUrl}/api/subscriber-events`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ name: "x", pad: "a".repeat(70_000) }),
  });
  check(oversized.status === 413, "body-limit");
  check(stored().length === rows.length, "no-write-rejected");
}
