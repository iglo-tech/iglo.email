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
      version: "1",
      integrity: "ok",
      foreignKeyErrors: [],
      journal: "wal",
      foreignKeys: "1",
      synchronous: "2",
      timeout: "5000",
      backups: [],
    });
    for (const name of tables) expect(installed.result.shapes[name]).toBeDefined();
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
      deleted: [],
    });
    await fixture.close();
    fixture = startSchemaFixture(directory);
    expect((await call(fixture.origin, "migrate")).result).toMatchObject({
      version: "1",
      integrity: "ok",
      foreignKeyErrors: [],
      backups: [],
    });
    expect((await call(fixture.origin, "search")).result).toEqual({
      robin: ["robin@example.test"],
      bob: ["bob@example.test"],
      transient: [],
    });
    expect((await call(fixture.origin, "delete")).result).toEqual({
      eventReference: null,
      softStep: "deleted",
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
      version: "1",
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
    expect(Object.keys(state.shapes)).toEqual(["subscribers"]);
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
