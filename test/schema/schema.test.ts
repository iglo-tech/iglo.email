import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSchemaFixture, tables } from "@/test/schema/fixture";

async function call(origin: string, action: string) {
  const response = await fetch(origin, {
    method: "POST",
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(3000),
  });
  return {
    status: response.status,
    ...((await response.json()) as { result?: any; error?: string }),
  };
}

test("fresh installation, persistence, constraints, deletion and transactional FTS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iglo-schema-"));
  let fixture = startSchemaFixture(directory);
  try {
    expect((await call(fixture.origin, "status")).result).toMatchObject({
      version: "0",
      shapes: {},
      backups: [],
    });
    const installed = await call(fixture.origin, "migrate");
    expect(installed.status).toBe(200);
    expect(installed.result).toMatchObject({
      version: "2",
      integrity: "ok",
      foreignKeyErrors: [],
      journal: "wal",
      foreignKeys: "1",
      synchronous: "2",
      timeout: "5000",
      backups: [],
    });
    for (const name of tables) {
      expect(installed.result.shapes[name]).toBeDefined();
      expect(installed.result.counts[name]).toBe("0");
    }
    const columns: Record<string, string[]> = {
      subscribers: [
        "id",
        "uuid",
        "email",
        "name",
        "attribs",
        "status",
        "external_id",
        "created_at",
        "updated_at",
      ],
      lists: [
        "id",
        "uuid",
        "name",
        "type",
        "optin",
        "status",
        "tags",
        "description",
        "created_at",
        "updated_at",
      ],
      subscriber_lists: ["subscriber_id", "list_id", "meta", "status", "created_at", "updated_at"],
      templates: [
        "id",
        "name",
        "type",
        "subject",
        "body",
        "body_source",
        "is_default",
        "created_at",
        "updated_at",
      ],
      campaigns: [
        "id",
        "uuid",
        "name",
        "subject",
        "from_email",
        "body",
        "body_source",
        "altbody",
        "content_type",
        "send_at",
        "headers",
        "attribs",
        "status",
        "tags",
        "type",
        "messenger",
        "template_id",
        "to_send",
        "sent",
        "max_subscriber_id",
        "last_subscriber_id",
        "archive",
        "archive_slug",
        "archive_template_id",
        "archive_meta",
        "started_at",
        "created_at",
        "updated_at",
      ],
      campaign_lists: ["id", "campaign_id", "list_id", "list_name"],
      campaign_views: ["id", "campaign_id", "send_id", "subscriber_id", "created_at"],
      media: ["id", "uuid", "provider", "filename", "content_type", "thumb", "meta", "created_at"],
      campaign_media: ["campaign_id", "media_id", "filename"],
      links: ["id", "uuid", "url", "created_at"],
      link_clicks: ["id", "campaign_id", "send_id", "link_id", "subscriber_id", "created_at"],
      settings: ["key", "value", "updated_at"],
      bounces: [
        "id",
        "subscriber_id",
        "campaign_id",
        "send_id",
        "type",
        "source",
        "meta",
        "created_at",
      ],
      roles: [
        "id",
        "type",
        "parent_id",
        "list_id",
        "permissions",
        "name",
        "created_at",
        "updated_at",
      ],
      users: [
        "id",
        "username",
        "password_login",
        "password",
        "email",
        "name",
        "avatar",
        "type",
        "user_role_id",
        "list_role_id",
        "status",
        "twofa_type",
        "twofa_key",
        "loggedin_at",
        "created_at",
        "updated_at",
      ],
      sessions: ["id", "data", "created_at"],
      events: [
        "id",
        "subscriber_id",
        "name",
        "data",
        "occurred_at",
        "created_at",
        "idempotency_key",
      ],
      sequences: [
        "id",
        "uuid",
        "name",
        "status",
        "trigger",
        "exit_on",
        "reentry",
        "list_id",
        "created_at",
        "updated_at",
      ],
      sequence_steps: [
        "id",
        "uuid",
        "sequence_id",
        "position",
        "wait",
        "kind",
        "template_id",
        "subject",
        "condition",
        "on_false",
        "cap_policy",
        "max_late",
        "status",
        "created_at",
        "updated_at",
      ],
      enrollments: [
        "id",
        "sequence_id",
        "subscriber_id",
        "trigger_event_id",
        "step_id",
        "due_at",
        "status",
        "exit_reason",
        "claimed_until",
        "created_at",
        "updated_at",
        "finished_at",
      ],
      sends: [
        "id",
        "uuid",
        "source",
        "kind",
        "subscriber_id",
        "to_email",
        "template_id",
        "enrollment_id",
        "step_id",
        "list_id",
        "idempotency_key",
        "status",
        "skip_reason",
        "smtp_message_id",
        "error",
        "payload",
        "attempts",
        "claimed_until",
        "created_at",
        "sent_at",
        "next_attempt_at",
        "retry_of",
      ],
      webhooks: ["id", "url", "secret", "events", "enabled", "created_at", "updated_at"],
      webhook_deliveries: [
        "id",
        "uuid",
        "webhook_id",
        "event",
        "payload",
        "status",
        "attempts",
        "next_attempt_at",
        "last_error",
        "claimed_until",
        "created_at",
        "updated_at",
      ],
      subscribers_fts: ["name", "email"],
    };
    for (const [table, expected] of Object.entries(columns)) {
      expect(installed.result.shapes[table]).toEqual(expected);
    }
    expect(installed.result.shapes.mat_dashboard_counts).toEqual(["updated_at", "data"]);
    expect(installed.result.shapes.mat_dashboard_charts).toEqual(["updated_at", "data"]);
    expect(installed.result.shapes.mat_list_subscriber_stats).toEqual([
      "updated_at",
      "list_id",
      "status",
      "subscriber_count",
    ]);
    expect(installed.result.shapes.mat_list_charts).toEqual([
      "list_id",
      "date",
      "subscriptions",
      "unsubscriptions",
      "campaign_views",
    ]);
    expect((await call(fixture.origin, "seed")).result).toEqual({
      subscriberCount: "3",
      sentinels: "1",
    });
    const checks = await call(fixture.origin, "constraints");
    expect(checks.status).toBe(200);
    expect(Object.keys(checks.result)).toHaveLength(35);
    expect(Object.values(checks.result)).toEqual(Array(35).fill(true));
    const search = await call(fixture.origin, "fts");
    expect(search.result).toEqual({
      insert: ["Ana@example.test"],
      oldName: [],
      oldEmail: [],
      newName: ["robin@example.test"],
      newEmail: ["robin@example.test"],
      rollback: [],
      afterRollback: ["robin@example.test"],
      rollbackDelete: ["bob@example.test"],
      deleted: [],
      nextSubscriberId: "4",
      largeId: "9223372036854775807",
    });
    await fixture.close();
    fixture = startSchemaFixture(directory);
    expect((await call(fixture.origin, "migrate")).result).toMatchObject({
      version: "2",
      integrity: "ok",
      foreignKeyErrors: [],
      backups: [],
    });
    expect((await call(fixture.origin, "search")).result).toEqual({
      robin: ["robin@example.test"],
      bob: ["bob@example.test"],
      cat: [],
      transient: [],
    });
    expect((await call(fixture.origin, "delete")).result).toEqual({
      eventReference: null,
      softStep: "deleted",
      replacementStep: "2",
      events: "0",
      memberships: "0",
      enrollments: "0",
      retainedSends: "1",
      retainedViews: "2",
      retainedClicks: "2",
      bounces: "0",
      deletedFts: [],
      listName: "Test",
      mediaName: "file",
      campaignTemplate: null,
    });
    expect((await call(fixture.origin, "status")).result).toMatchObject({
      integrity: "ok",
      foreignKeyErrors: [],
      version: "2",
    });
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("deleted identities never resolve to replacement accounts or entities after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iglo-schema-identities-"));
  let fixture = startSchemaFixture(directory);
  try {
    expect((await call(fixture.origin, "migrate")).status).toBe(200);
    expect((await call(fixture.origin, "seed")).status).toBe(200);
    const deleted = await call(fixture.origin, "delete-identities");
    expect(deleted.status).toBe(200);
    await fixture.close();
    fixture = startSchemaFixture(directory);
    expect((await call(fixture.origin, "migrate")).status).toBe(200);
    const replacement = await call(fixture.origin, "replace-identities");
    expect(replacement.status).toBe(200);
    expect(replacement.result.retainedSessionUser).toBe(deleted.result.user);
    expect(replacement.result.resolvedSessionUser).toBeNull();
    expect(BigInt(replacement.result.user)).toBeGreaterThan(BigInt(deleted.result.user));
    for (const entity of ["lists", "templates", "campaigns"] as const) {
      expect(BigInt(replacement.result.entities[entity])).toBeGreaterThan(
        BigInt(deleted.result.entities[entity]),
      );
    }
    expect((await call(fixture.origin, "status")).result).toMatchObject({
      integrity: "ok",
      foreignKeyErrors: [],
      version: "2",
      backups: [],
    });
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unexpected version-zero object is snapshotted and left intact on atomic migration failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iglo-schema-conflict-"));
  const fixture = startSchemaFixture(directory);
  try {
    expect((await call(fixture.origin, "conflict")).status).toBe(200);
    expect((await call(fixture.origin, "migrate")).status).toBe(400);
    const state = (await call(fixture.origin, "status")).result;
    expect(state).toMatchObject({ version: "0", integrity: "ok", foreignKeyErrors: [] });
    expect(Object.keys(state.shapes)).toEqual(["settings"]);
    expect(state.objects).toEqual(["settings"]);
    expect(state.backups).toHaveLength(1);
    expect((await call(fixture.origin, "marker")).result).toBe("preserved");
    expect((await call(fixture.origin, "backup")).result).toEqual({
      version: "0",
      marker: "preserved",
      integrity: "ok",
    });
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
