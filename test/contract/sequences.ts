// Production-only: sequences and enrollments are native (docs/design/05-sequences.md);
// listmonk has no equivalent endpoint, so there is no reference run. Exercised through the
// compiled executable's real HTTP, auth, migrations, restart and SQLite file.
import type { Credentials } from "@/test/contract/types";

export async function runSequencesContract(target: {
  baseUrl: string;
  credentials: Credentials;
  restart: () => Promise<void>;
}) {
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL sequences-${label}`);
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
  const apiUser = async (name: string, permissions: string[]) => {
    const role = await call("/api/roles/users", "POST", { name, permissions });
    const user = await call("/api/users", "POST", {
      username: name,
      type: "api",
      status: "enabled",
      user_role_id: role.body.data.id,
    });
    return { authorization: `Basic ${btoa(`${name}:${user.body.data.password}`)}` };
  };

  const template = await call("/api/templates", "POST", {
    name: "sequence step",
    type: "tx",
    subject: "Hello",
    body: "<p>{{ subscriber.name }}</p>",
  });
  check(template.status === 200, "template");
  const list = await call("/api/lists", "POST", { name: "seq", type: "public", optin: "single" });
  check(list.status === 200, "list");
  const definition = {
    name: "Prepaid onboarding",
    status: "active",
    trigger: { event: "order_paid", where: { "data.product": "prepaid" } },
    exit_on: ["subscription_created"],
    reentry: "after_exit",
    list_id: list.body.data.id,
    steps: [
      { wait: "PT0S", kind: "transactional", template_id: template.body.data.id },
      {
        wait: "P3D",
        kind: "marketing",
        template_id: template.body.data.id,
        condition: { not: { event: "download_finished", since: "trigger" } },
      },
    ],
  };

  // Permissions: anonymous and a role without the sequence permissions write nothing.
  const reader = await apiUser("sequences-contract-reader", ["sequences:get"]);
  check((await call("/api/sequences", "POST", definition, {})).status === 403, "anonymous");
  const denied = await call("/api/sequences", "POST", definition, reader);
  check(
    denied.status === 403 && denied.body.message === "permission denied: sequences:manage",
    "permission",
  );
  check((await call("/api/sequences", "GET", undefined, reader)).body.data.total === 0, "empty");

  // Validation: a definition that cannot be saved writes nothing.
  const invalid = await call("/api/sequences", "POST", { ...definition, list_id: null });
  check(invalid.status === 400 && /list_id/.test(invalid.body.message), "invalid");
  const sql = await call("/api/sequences", "POST", {
    ...definition,
    trigger: { event: "order_paid", where: { sql: "1=1" } },
  });
  check(sql.status === 400, "trigger-sql");

  const created = await call("/api/sequences", "POST", definition);
  check(created.status === 200 && created.body.data.steps.length === 2, "create");
  const seq = created.body.data;
  check(seq.steps[1].max_late === "P2D" && seq.steps[0].max_late === null, "max-late");

  // An event triggers it inside the event transaction and replays by idempotency key.
  const event = {
    subscriber: { email: "seq@example.com" },
    name: "order_paid",
    data: { product: "prepaid" },
    idempotency_key: "seq:1",
  };
  const first = await call("/api/subscriber-events", "POST", event);
  check(
    first.status === 200 &&
      first.body.data.enrollments.started.length === 1 &&
      first.body.data.enrollments.started[0].sequence_id === seq.id,
    "trigger",
  );
  const enrollmentId = first.body.data.enrollments.started[0].id;
  const enrollment = (await call(`/api/enrollments/${enrollmentId}`)).body.data;
  check(
    enrollment.status === "active" &&
      enrollment.step_id === seq.steps[0].id &&
      enrollment.trigger_event_id === first.body.data.event_id,
    "enrollment",
  );
  const other = await call("/api/subscriber-events", "POST", {
    ...event,
    data: { product: "subscription" },
    idempotency_key: "seq:2",
  });
  check(other.body.data.enrollments.started.length === 0, "where");

  // Restart: definitions, enrollments and the stored replay survive.
  await target.restart();
  const replay = await call("/api/subscriber-events", "POST", event);
  check(JSON.stringify(replay) === JSON.stringify(first), "replay");
  const exit = await call("/api/subscriber-events", "POST", {
    subscriber: { email: "seq@example.com" },
    name: "subscription_created",
  });
  check(
    JSON.stringify(exit.body.data.enrollments.ended) ===
      JSON.stringify([
        { id: enrollmentId, sequence_id: seq.id, exit_reason: "event:subscription_created" },
      ]),
    "exit",
  );

  // Manual enroll, reentry, cancel and the consent exit on blocklist.
  const subscriberId = first.body.data.subscriber_id;
  const manual = await call("/api/enrollments", "POST", {
    sequence_id: seq.id,
    subscriber_id: subscriberId,
  });
  check(manual.status === 200 && manual.body.data.status === "active", "manual");
  const again = await call("/api/enrollments", "POST", {
    sequence_id: seq.id,
    subscriber_id: subscriberId,
  });
  check(again.status === 409, "reentry");
  const blocked = await call(`/api/subscribers/${subscriberId}/blocklist`, "PUT");
  check(blocked.status === 200, "blocklist");
  const after = (await call(`/api/enrollments/${manual.body.data.id}`)).body.data;
  check(after.status === "exited" && after.exit_reason === "blocklisted", "blocklist-exit");
  check(
    (await call(`/api/enrollments/${manual.body.data.id}`, "DELETE")).status === 409,
    "cancel-inactive",
  );
  const listed = await call(`/api/enrollments?sequence_id=${seq.id}`, "GET", undefined, reader);
  check(listed.status === 200 && listed.body.data.total === 2, "list");

  // Archive, then delete is refused while enrollments exist.
  const archived = await call(`/api/sequences/${seq.id}/status`, "PUT", { status: "archived" });
  check(archived.status === 200 && archived.body.data.status === "archived", "archive");
  check((await call(`/api/sequences/${seq.id}`, "DELETE")).status === 409, "delete-enrolled");
}
