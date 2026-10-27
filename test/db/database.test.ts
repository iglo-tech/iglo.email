import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDbFixture } from "@/test/db/fixture";

async function request(origin: string, input: object) {
  const response = await fetch(origin, {
    method: "POST",
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(3000),
  });
  return {
    status: response.status,
    ...((await response.json()) as { result?: any; error?: string }),
  };
}
async function withFixture(fn: (origin: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "iglo-db-contract-"));
  const fixture = startDbFixture(directory);
  try {
    await fn(fixture.origin, directory);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("opens durable independent connections and persists exact 64-bit values", async () => {
  await withFixture(async (origin, directory) => {
    expect((await request(origin, { action: "status" })).result).toMatchObject({
      journal: "wal",
      foreignKeys: "1",
      synchronous: "2",
      timeout: "5000",
      version: "0",
      integrity: "ok",
      objects: [],
      backups: [],
    });
    expect((await request(origin, { action: "migrate", catalog: "first" })).status).toBe(200);
    const second = startDbFixture(directory);
    try {
      expect(
        (
          await request(origin, {
            action: "insert",
            id: "9223372036854775807",
            value: "quote '; -- $1",
          })
        ).result,
      ).toEqual({ id: "9223372036854775807", value: "quote '; -- $1" });
      expect(
        (await request(second.origin, { action: "get", id: "9223372036854775807" })).result.value,
      ).toBe("quote '; -- $1");
    } finally {
      await second.close();
    }
    const reopened = startDbFixture(directory);
    try {
      expect(
        (await request(reopened.origin, { action: "get", id: "9223372036854775807" })).result.id,
      ).toBe("9223372036854775807");
    } finally {
      await reopened.close();
    }
  });
});

test("a closed file-backed store reopens with its committed data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iglo-db-reopen-"));
  let fixture = startDbFixture(directory);
  try {
    await request(fixture.origin, { action: "migrate", catalog: "first" });
    await request(fixture.origin, { action: "insert", id: "8", value: "survives close" });
    await fixture.close();
    fixture = startDbFixture(directory);
    expect((await request(fixture.origin, { action: "get", id: "8" })).result).toEqual({
      id: "8",
      value: "survives close",
    });
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("immediate writes commit or roll back and reject nested or asynchronous callbacks", async () => {
  for (const mode of [
    "success",
    "failure",
    "nested",
    "async",
    "thenable",
    "thenable-object",
    "rejected",
  ]) {
    await withFixture(async (origin) => {
      await request(origin, { action: "migrate", catalog: "first" });
      const outcome = (await request(origin, { action: "transaction", mode })).result;
      expect(outcome.active).toBe(false);
      if (mode === "success") expect(outcome.error).toBeNull();
      else
        expect(outcome.error).toMatch(
          mode === "failure"
            ? /original error/
            : mode === "nested"
              ? /nested/i
              : /synchron|async|promise/i,
        );
      const record = (await request(origin, { action: "get", id: "1" })).result;
      expect(record).toEqual(mode === "success" ? { id: "1", value: "changed" } : null);
      if (mode !== "success")
        expect((await request(origin, { action: "insert", id: "2", value: "usable" })).status).toBe(
          200,
        );
    });
  }
});

test("migration catalogs validate, upgrade atomically per file, and preserve the previous committed version", async () => {
  for (const catalog of ["gap", "duplicate", "unordered", "blank", "transactional", "pragma"]) {
    await withFixture(async (origin) => {
      expect((await request(origin, { action: "migrate", catalog })).status).toBe(400);
      expect((await request(origin, { action: "status" })).result.version).toBe("0");
    });
  }
  await withFixture(async (origin) => {
    expect((await request(origin, { action: "migrate", catalog: "empty" })).result.backups).toEqual(
      [],
    );
    expect((await request(origin, { action: "migrate", catalog: "failing" })).status).toBe(400);
    const status = (await request(origin, { action: "status" })).result;
    expect(status.version).toBe("1");
    expect(status.objects).toEqual([{ name: "fixture_records" }]);
    expect(status.backups).toEqual([]);
    expect((await request(origin, { action: "migrate", catalog: "both" })).status).toBe(200);
    const upgraded = (await request(origin, { action: "status" })).result;
    expect(upgraded.version).toBe("2");
    expect(upgraded.backups).toHaveLength(1);
    expect(
      (await request(origin, { action: "migrate", catalog: "both" })).result.backups,
    ).toHaveLength(1);
    expect((await request(origin, { action: "migrate", catalog: "first" })).status).toBe(400);
  });
});

test("migration bodies can create SQLite triggers while the runner owns transactions", async () => {
  await withFixture(async (origin) => {
    expect((await request(origin, { action: "migrate", catalog: "triggers" })).status).toBe(200);
    await request(origin, { action: "insert", id: "1", value: "triggered" });
    expect((await request(origin, { action: "audit" })).result).toEqual([{ value: "triggered" }]);
  });
});

test("migration identifiers cannot hide transaction control or connection settings", async () => {
  for (const catalog of [
    "identifierCommit",
    "identifierRollback",
    "identifierPragma",
    "explainPragma",
  ]) {
    await withFixture(async (origin) => {
      expect((await request(origin, { action: "migrate", catalog })).status).toBe(400);
      const status = (await request(origin, { action: "status" })).result;
      expect(status.version).toBe("0");
      expect(status.objects).toEqual([]);
      expect(status.timeout).toBe("5000");
      expect((await request(origin, { action: "migrate", catalog: "first" })).status).toBe(200);
    });
  }
});

test("migration trigger bodies accept keyword identifiers and reject unbound parameters", async () => {
  await withFixture(async (origin) => {
    expect((await request(origin, { action: "migrate", catalog: "keywordTrigger" })).status).toBe(
      200,
    );
    await request(origin, { action: "insert", id: "1", value: "keyword identifier" });
    expect((await request(origin, { action: "keyword-audit" })).result).toEqual([
      { end: "keyword identifier" },
    ]);
  });
  await withFixture(async (origin) => {
    expect(
      (await request(origin, { action: "migrate", catalog: "migrationParameter" })).status,
    ).toBe(400);
    expect((await request(origin, { action: "status" })).result.objects).toEqual([]);
  });
});

test("pre-upgrade snapshot captures committed WAL contents; a failed snapshot prevents writes", async () => {
  await withFixture(async (origin) => {
    await request(origin, { action: "migrate", catalog: "first" });
    await request(origin, { action: "insert", id: "47", value: "committed in WAL" });
    expect((await request(origin, { action: "status" })).result.walBytes).toBeGreaterThan(0);
    await request(origin, { action: "migrate", catalog: "both" });
    expect((await request(origin, { action: "backup" })).result).toEqual({
      version: "1",
      integrity: "ok",
      records: [{ id: "47", value: "committed in WAL" }],
    });
  });
  await withFixture(async (origin) => {
    await request(origin, { action: "migrate", catalog: "first" });
    await request(origin, { action: "block-backup" });
    expect((await request(origin, { action: "migrate", catalog: "both" })).status).toBe(400);
    expect((await request(origin, { action: "status" })).result.version).toBe("1");
    expect(
      (await request(origin, { action: "insert", id: "2", value: "still writable" })).status,
    ).toBe(200);
  });
});

test("a failed pending migration keeps the previous version and its pre-batch backup", async () => {
  await withFixture(async (origin) => {
    await request(origin, { action: "migrate", catalog: "first" });
    await request(origin, { action: "insert", id: "1", value: "before failure" });
    expect((await request(origin, { action: "migrate", catalog: "failing" })).status).toBe(400);
    const status = (await request(origin, { action: "status" })).result;
    expect(status.version).toBe("1");
    expect(status.objects).toEqual([{ name: "fixture_records" }]);
    expect(status.backups).toHaveLength(1);
    expect((await request(origin, { action: "backup" })).result.records).toEqual([
      { id: "1", value: "before failure" },
    ]);
  });
});

test("snapshots unversioned user schema and never reuses names when the clock stands still", async () => {
  await withFixture(async (origin) => {
    await request(origin, { action: "create-unversioned" });
    await request(origin, { action: "migrate", catalog: "first" });
    expect((await request(origin, { action: "unversioned-backup" })).result).toEqual({
      version: "0",
      value: "prior",
    });
    await request(origin, { action: "migrate", catalog: "both" });
    await request(origin, { action: "migrate", catalog: "three" });
    const backups: string[] = (await request(origin, { action: "status" })).result.backups;
    expect(backups).toHaveLength(3);
    expect(new Set(backups).size).toBe(3);
  });
});

test("named blocks reject malformed input and preserve semicolons, comments and bound values", async () => {
  await withFixture(async (origin) => {
    await request(origin, { action: "migrate", catalog: "first" });
    expect((await request(origin, { action: "named", literal: true })).result.literal.value).toBe(
      "; -- name: not-a-header",
    );
    expect((await request(origin, { action: "named", literal: true })).result.multiline.value).toBe(
      "first\n-- name: not-a-query\nlast",
    );
    for (const sources of [
      [
        { name: "a", sql: "-- name: same\nSELECT 1" },
        { name: "b", sql: "-- name: same\nSELECT 2" },
      ],
      [{ name: "a", sql: "-- name: \nSELECT 1" }],
      [{ name: "a", sql: "-- name: empty\n-- only a comment" }],
      [{ name: "a", sql: "-- name: invalid\nSELECT FROM" }],
      [{ name: "a", sql: "-- name: multiple\nSELECT 1; SELECT 2" }],
    ])
      expect((await request(origin, { action: "named", sources })).status).toBe(400);
  });
});
