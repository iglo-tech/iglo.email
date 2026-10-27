// Synthetic store and HTTP boundary; never registered in production.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "@/db/connection";
import { runMigrations } from "@/db/migrations";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import { TestClock } from "@/test/server/fixture";
import first from "@/test/db/assets/0001.sql" with { type: "text" };
import second from "@/test/db/assets/0002.sql" with { type: "text" };
import failing from "@/test/db/assets/failing.sql" with { type: "text" };
import queries from "@/test/db/assets/queries.sql" with { type: "text" };

const one = { version: 1, sql: first };
const two = { version: 2, sql: second };
const catalogs = {
  empty: [],
  first: [one],
  both: [one, two],
  failing: [one, { version: 2, sql: failing }],
  gap: [one, { version: 3, sql: second }],
  duplicate: [one, one],
  unordered: [two, one],
  blank: [{ version: 1, sql: " -- empty\n" }],
  transactional: [{ version: 1, sql: "CREATE TABLE forbidden (id); COMMIT;" }],
} as const;

function scalar(db: Database, sql: string): unknown {
  return Object.values(db.query<Record<string, unknown>, []>(sql).get() ?? {})[0];
}

export function startDbFixture(dataDir: string) {
  const db = openDatabase(dataDir);
  const clock = new TestClock();
  const names = () =>
    existsSync(join(dataDir, "backups"))
      ? readdirSync(join(dataDir, "backups")).filter((name) => name.endsWith(".db"))
      : [];

  async function action(input: Record<string, any>): Promise<unknown> {
    switch (input.action) {
      case "status":
        return {
          journal: scalar(db, "PRAGMA journal_mode"),
          foreignKeys: scalar(db, "PRAGMA foreign_keys"),
          synchronous: scalar(db, "PRAGMA synchronous"),
          timeout: scalar(db, "PRAGMA busy_timeout"),
          version: scalar(db, "PRAGMA user_version"),
          integrity: scalar(db, "PRAGMA integrity_check"),
          objects: db
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all(),
          backups: names(),
        };
      case "migrate":
        runMigrations(db, dataDir, clock, catalogs[input.catalog as keyof typeof catalogs]);
        return { backups: names() };
      case "insert": {
        const prepared = prepareNamedQueries(db, [{ name: "fixture", sql: queries }]);
        try {
          writeTransaction(db, () =>
            prepared.get("insert-record").run(BigInt(input.id), input.value),
          );
          return prepared.get("get-record").get(BigInt(input.id));
        } finally {
          prepared.close();
        }
      }
      case "get": {
        const prepared = prepareNamedQueries(db, [{ name: "fixture", sql: queries }]);
        try {
          return prepared.get("get-record").get(BigInt(input.id));
        } finally {
          prepared.close();
        }
      }
      case "transaction": {
        const insert = () =>
          db.run("INSERT INTO fixture_records (id, value) VALUES (1, 'changed')");
        try {
          if (input.mode === "nested")
            writeTransaction(db, () => {
              insert();
              writeTransaction(db, () => undefined);
            });
          else if (input.mode === "async")
            writeTransaction(db, (async () => {
              insert();
            }) as never);
          else if (input.mode === "thenable")
            writeTransaction(db, (() => {
              insert();
              return Promise.resolve(1);
            }) as never);
          else
            writeTransaction(db, () => {
              insert();
              if (input.mode === "failure") throw new Error("original error");
            });
          return { error: null, active: db.inTransaction };
        } catch (error) {
          return { error: String(error), active: db.inTransaction };
        }
      }
      case "named": {
        const sources = input.sources ?? [{ name: "fixture", sql: queries }];
        const prepared = prepareNamedQueries(db, sources);
        try {
          return { literal: input.literal ? prepared.get("literal").get() : null };
        } finally {
          prepared.close();
        }
      }
      case "backup": {
        const path = join(dataDir, "backups", names()[input.index ?? 0]!);
        const snapshot = new Database(path, { readonly: true, safeIntegers: true });
        try {
          return {
            version: scalar(snapshot, "PRAGMA user_version"),
            integrity: scalar(snapshot, "PRAGMA integrity_check"),
            records: snapshot.query("SELECT id, value FROM fixture_records ORDER BY id").all(),
          };
        } finally {
          snapshot.close(true);
        }
      }
      case "block-backup":
        writeFileSync(join(dataDir, "backups"), "fixture blocks directory");
        return true;
      default:
        throw new Error("Unknown fixture action");
    }
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        const result = await action((await request.json()) as Record<string, any>);
        return new Response(
          JSON.stringify({ result }, (_key, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value,
          ),
          { headers: { "content-type": "application/json" } },
        );
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    async close() {
      await server.stop(true);
      db.close(true);
    },
  };
}
