// Synthetic subscriber and campaign provisioning, not production domain endpoints.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { createCampaignListReferences } from "@/campaigns/list-references";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { createListReferences } from "@/lists/references";
import { registerListRoutes } from "@/lists/routes";
import { createListStore } from "@/lists/store";
import { createRoles } from "@/roles/roles";
import { ok } from "@/server/response";
import { createRouter, startServer } from "@/server/server";
import { createListCounts } from "@/subscribers/list-counts";
import { TestClock } from "@/test/server/fixture";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { registerUserRoutes } from "@/users/routes";
import { createUserStore } from "@/users/store";

export async function startListFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "iglo-lists-fixture-"));
  const db = openDatabase(dataDir),
    clock = new TestClock();
  runMigrations(db, dataDir, clock, productionMigrations);
  const references = createListReferences(db),
    roles = createRoles(db, references);
  const counts = createListCounts(db),
    campaigns = createCampaignListReferences(db);
  const lists = createListStore(db, clock, counts, campaigns),
    users = createUserStore(db, clock, roles);
  try {
    const admin = { user: "fixture-admin", password: "fixture-admin-password" };
    const auth = await createAuthentication(
      users,
      roles,
      clock,
      "http://fixture.test",
      defaultAuthPolicy,
    );
    await bootstrapAdmin(users, auth, admin);
    const app = createApp({
      bootstrap: {
        host: "127.0.0.1",
        port: 0,
        dataDir,
        rootUrl: "http://fixture.test",
        initialAdmin: admin,
      },
      db,
      clock,
      i18n: createTranslation(),
      logger: { error: () => {} },
    });
    const router = createRouter();
    registerUserRoutes(router, users, roles, auth);
    registerListRoutes(router, lists, roles, auth);
    // Test-only sequence setup; production still allocates every list ID automatically.
    router.route("POST", "/fixture/list-sequence", () => {
      db.query("UPDATE sqlite_sequence SET seq = ? WHERE name = 'lists'").run(9007199254740992n);
      return ok(true);
    });
    router.route("POST", "/fixture/membership", async ({ request }) => {
      const { list, status, subscriberStatus } = (await request.json()) as {
        list: number;
        status: string;
        subscriberStatus: string;
      };
      const id = (
        db
          .query("INSERT INTO subscribers(uuid,email,name,status) VALUES(?,?,?,?) RETURNING id")
          .get(
            crypto.randomUUID(),
            `${crypto.randomUUID()}@example.test`,
            "Synthetic subscriber",
            subscriberStatus,
          ) as { id: bigint }
      ).id;
      db.query("INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES(?,?,?)").run(
        id,
        list,
        status,
      );
      return ok(Number(id));
    });
    router.route("POST", "/fixture/campaign", async ({ request }) => {
      const { list, name } = (await request.json()) as { list: number; name: string };
      const id = (
        db
          .query(
            "INSERT INTO campaigns(uuid,name,subject,from_email,body,messenger) VALUES(?,?,?,?,?,?) RETURNING id",
          )
          .get(
            crypto.randomUUID(),
            "Synthetic campaign",
            "Subject",
            "sender@example.test",
            "Body",
            "email",
          ) as { id: bigint }
      ).id;
      db.query("INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(?,?,?)").run(
        id,
        list,
        name,
      );
      return ok(Number(id));
    });
    router.route("GET", "/fixture/references", () =>
      ok({
        campaigns: db
          .query("SELECT list_id,list_name FROM campaign_lists ORDER BY id")
          .all()
          .map((row: any) => ({
            list_id: row.list_id === null ? null : Number(row.list_id),
            list_name: row.list_name,
          })),
        subscribers: Number(
          (db.query("SELECT COUNT(*) AS count FROM subscribers").get() as { count: bigint }).count,
        ),
        memberships: Number(
          (db.query("SELECT COUNT(*) AS count FROM subscriber_lists").get() as { count: bigint })
            .count,
        ),
      }),
    );
    const server = startServer(app, router);
    return {
      origin: `http://127.0.0.1:${server.port}`,
      admin,
      clock,
      async close() {
        await server.stop(true);
        users.close();
        lists.close();
        campaigns.close();
        counts.close();
        roles.close();
        references.close();
        db.close(true);
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    users.close();
    lists.close();
    campaigns.close();
    counts.close();
    roles.close();
    references.close();
    db.close(true);
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}
