// Test-only storage boundary for the M1.1 schema; never registered in production.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { writeTransaction } from "@/db/transaction";
import { TestClock } from "@/test/server/fixture";

export const tables = [
  "subscribers",
  "lists",
  "subscriber_lists",
  "templates",
  "campaigns",
  "campaign_lists",
  "campaign_views",
  "media",
  "campaign_media",
  "links",
  "link_clicks",
  "settings",
  "bounces",
  "roles",
  "users",
  "sessions",
  "events",
  "sequences",
  "sequence_steps",
  "enrollments",
  "sends",
  "webhooks",
  "webhook_deliveries",
  "mat_dashboard_counts",
  "mat_dashboard_charts",
  "mat_list_subscriber_stats",
  "mat_list_charts",
  "subscribers_fts",
] as const;

function scalar(db: Database, sql: string): unknown {
  return Object.values(db.query<Record<string, unknown>, []>(sql).get() ?? {})[0];
}
function rejected(db: Database, sql: string): boolean {
  db.run("SAVEPOINT probe");
  try {
    db.run(sql);
    return false;
  } catch {
    return true;
  } finally {
    db.run("ROLLBACK TO probe; RELEASE probe");
  }
}
function backupNames(directory: string): string[] {
  const path = join(directory, "backups");
  return existsSync(path) ? readdirSync(path).filter((name) => name.endsWith(".db")) : [];
}
function matches(db: Database, query: string): string[] {
  return db
    .query<{ email: string }, [string]>(
      "SELECT s.email FROM subscribers_fts f JOIN subscribers s ON s.id = f.rowid WHERE subscribers_fts MATCH ? ORDER BY s.email",
    )
    .all(query)
    .map((row) => row.email);
}

export function startSchemaFixture(directory: string) {
  const db = openDatabase(directory);
  const clock = new TestClock();
  function status() {
    const found = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    const shapes: Record<string, string[]> = {};
    for (const table of tables) {
      if (found.includes(table)) {
        shapes[table] = db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => row.name);
      }
    }
    return {
      version: scalar(db, "PRAGMA user_version"),
      integrity: scalar(db, "PRAGMA integrity_check"),
      foreignKeyErrors: db.query("PRAGMA foreign_key_check").all(),
      journal: scalar(db, "PRAGMA journal_mode"),
      foreignKeys: scalar(db, "PRAGMA foreign_keys"),
      synchronous: scalar(db, "PRAGMA synchronous"),
      timeout: scalar(db, "PRAGMA busy_timeout"),
      shapes,
      backups: backupNames(directory),
    };
  }
  function seed() {
    db.run(`
      INSERT INTO subscribers(id,uuid,email,name,external_id,created_at,updated_at) VALUES
        (1,'subscriber-1','Ana@example.test','Ana','app-1','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
        (2,'subscriber-2','bob@example.test','Bob',NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
        (3,'subscriber-3','cat@example.test','Cat',NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      INSERT INTO lists(id,uuid,name,type) VALUES (1,'list-1','Test','public');
      INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES (1,1,'confirmed');
      INSERT INTO templates(id,name,subject,body) VALUES (1,'Receipt','Subject','Body');
      INSERT INTO campaigns(id,uuid,name,subject,from_email,body,messenger) VALUES (1,'campaign-1','Campaign','Subject','sender@example.test','Body','smtp');
      INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES (1,1,'Test');
      INSERT INTO media(id,uuid,filename,thumb) VALUES (1,'media-1','file','thumb');
      INSERT INTO campaign_media(campaign_id,media_id,filename) VALUES (1,1,'file');
      INSERT INTO links(id,uuid,url) VALUES (1,'link-1','https://example.test/');
      INSERT INTO settings(key,value) VALUES ('number','42'),('bool','false'),('string','"text"'),('null','null');
      INSERT INTO roles(id,type,name) VALUES (1,'user','admin');
      INSERT INTO users(id,username,email,name,user_role_id) VALUES (1,'user','user@example.test','User',1);
      INSERT INTO sessions(id,data) VALUES ('session-1','{}');
      INSERT INTO events(id,subscriber_id,name,occurred_at,created_at,idempotency_key) VALUES (1,1,'created','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','event-key');
      INSERT INTO events(subscriber_id,name,occurred_at,created_at) VALUES (1,'other','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),(1,'other','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      INSERT INTO sequences(id,uuid,name,trigger,exit_on,reentry,list_id) VALUES (1,'sequence-1','Sequence','{"event":"created"}','[]','always',1);
      INSERT INTO sequence_steps(id,uuid,sequence_id,position,wait,kind,template_id) VALUES (1,'step-1',1,1,'PT0S','transactional',1);
      INSERT INTO enrollments(id,sequence_id,subscriber_id,trigger_event_id,step_id,status) VALUES (1,1,1,1,1,'active'),(2,1,1,NULL,1,'completed');
      INSERT INTO sends(id,uuid,source,kind,subscriber_id,to_email,template_id,enrollment_id,step_id,list_id,idempotency_key,status,payload)
        VALUES (1,'send-1','sequence','transactional',1,'Ana@example.test',1,1,1,1,NULL,'queued','{}'),
        (2,'send-2','tx','transactional',NULL,'external@example.test',NULL,NULL,NULL,NULL,'tx-key','sent','{}'),
        (3,'send-3','tx','transactional',NULL,'external2@example.test',NULL,NULL,NULL,NULL,NULL,'skipped','{}');
      INSERT INTO campaign_views(id,campaign_id,subscriber_id) VALUES (1,1,1);
      INSERT INTO campaign_views(id,send_id,subscriber_id) VALUES (2,1,1);
      INSERT INTO link_clicks(id,campaign_id,link_id,subscriber_id) VALUES (1,1,1,1);
      INSERT INTO link_clicks(id,send_id,link_id,subscriber_id) VALUES (2,1,1,1);
      INSERT INTO bounces(id,subscriber_id,campaign_id) VALUES (1,1,1);
      INSERT INTO webhooks(id,url,secret,events,enabled) VALUES (1,'https://receiver.example.test/','test-secret','[]',1);
      INSERT INTO webhook_deliveries(id,webhook_id,event,payload,status) VALUES (1,1,'send.failed','{}','queued');
      INSERT INTO mat_list_subscriber_stats(updated_at,list_id,status,subscriber_count) VALUES ('2026-01-01T00:00:00.000Z',0,NULL,3);
    `);
    return {
      subscriberCount: scalar(db, "SELECT count(*) FROM subscribers"),
      sentinels: scalar(
        db,
        "SELECT count(*) FROM mat_list_subscriber_stats WHERE list_id=0 AND status IS NULL",
      ),
    };
  }
  function constraints() {
    const probes: Record<string, string> = {
      duplicateEmail:
        "INSERT INTO subscribers(uuid,email,name) VALUES ('dupe','ana@EXAMPLE.test','Duplicate')",
      duplicateExternal:
        "INSERT INTO subscribers(uuid,email,name,external_id) VALUES ('dupe','unique@example.test','Duplicate','app-1')",
      subscriberStatus:
        "INSERT INTO subscribers(uuid,email,name,status) VALUES ('bad','bad@example.test','Bad','wrong')",
      subscriberNullStatus:
        "INSERT INTO subscribers(uuid,email,name,status) VALUES ('bad','bad@example.test','Bad',NULL)",
      subscriberJson:
        "INSERT INTO subscribers(uuid,email,name,attribs) VALUES ('bad','bad@example.test','Bad','[]')",
      listEnum: "INSERT INTO lists(uuid,name,type) VALUES ('bad','Bad','wrong')",
      listTags: "INSERT INTO lists(uuid,name,type,tags) VALUES ('bad','Bad','public','{}')",
      membershipForeignKey: "INSERT INTO subscriber_lists(subscriber_id,list_id) VALUES (9999,1)",
      membershipNull: "INSERT INTO subscriber_lists(subscriber_id,list_id) VALUES (1,NULL)",
      boolean: "INSERT INTO templates(name,subject,body,is_default) VALUES ('Bad','Bad','Bad',2)",
      campaignHeaders:
        "INSERT INTO campaigns(uuid,name,subject,from_email,body,messenger,headers) VALUES ('bad','Bad','Bad','x','x','x','{}')",
      campaignStatus: "UPDATE campaigns SET status='wrong' WHERE id=1",
      settingsJson: "INSERT INTO settings(key,value) VALUES ('bad','not json')",
      eventDuplicate:
        "INSERT INTO events(subscriber_id,name,occurred_at,created_at,idempotency_key) VALUES (1,'x','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','event-key')",
      eventForeignKey:
        "INSERT INTO events(subscriber_id,name,occurred_at,created_at) VALUES (9999,'x','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
      eventJson:
        "INSERT INTO events(subscriber_id,name,data,occurred_at,created_at) VALUES (1,'x','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
      sequenceTrigger: "UPDATE sequences SET trigger='[]' WHERE id=1",
      sequenceExitArray: "UPDATE sequences SET exit_on='{}' WHERE id=1",
      stepStatus: "UPDATE sequence_steps SET status='wrong' WHERE id=1",
      sendStatus: "UPDATE sends SET status='wrong' WHERE id=1",
      sendPair:
        "INSERT INTO sends(uuid,source,kind,to_email,enrollment_id,step_id,status,payload) VALUES ('duplicate','sequence','transactional','x',1,1,'queued','{}')",
      txIdempotency:
        "INSERT INTO sends(uuid,source,kind,to_email,idempotency_key,status,payload) VALUES ('duplicate','tx','transactional','x','tx-key','queued','{}')",
      viewNeither: "INSERT INTO campaign_views(subscriber_id) VALUES (1)",
      viewBoth: "INSERT INTO campaign_views(campaign_id,send_id,subscriber_id) VALUES (1,1,1)",
      viewForeignKey: "INSERT INTO campaign_views(send_id) VALUES (9999)",
      clickNeither: "INSERT INTO link_clicks(link_id) VALUES (1)",
      clickBoth: "INSERT INTO link_clicks(campaign_id,send_id,link_id) VALUES (1,1,1)",
      clickForeignKey: "INSERT INTO link_clicks(send_id,link_id) VALUES (9999,1)",
      webhookBoolean: "UPDATE webhooks SET enabled=2 WHERE id=1",
      webhookEvents: "UPDATE webhooks SET events='{}' WHERE id=1",
      deliveryStatus: "UPDATE webhook_deliveries SET status='wrong' WHERE id=1",
      sessionJson: "INSERT INTO sessions(id,data) VALUES ('bad','invalid')",
      rolePermissions: "UPDATE roles SET permissions='{}' WHERE id=1",
      userRole:
        "INSERT INTO users(username,email,name,user_role_id) VALUES ('bad','bad@example.test','Bad',9999)",
      referencedStep: "DELETE FROM sequence_steps WHERE id=1",
    };
    return Object.fromEntries(
      Object.entries(probes).map(([name, sql]) => [name, rejected(db, sql)]),
    );
  }
  function fts() {
    const result: Record<string, unknown> = {};
    result.insert = matches(db, "Ana");
    db.run("UPDATE subscribers SET name='Robin', email='robin@example.test' WHERE id=1");
    result.oldName = matches(db, "Ana");
    result.oldEmail = matches(db, '"Ana@example.test"');
    result.newName = matches(db, "Robin");
    result.newEmail = matches(db, '"robin@example.test"');
    try {
      writeTransaction(db, () => {
        db.run("UPDATE subscribers SET name='Transient',email='transient@example.test' WHERE id=1");
        db.run(
          "INSERT INTO subscribers(uuid,email,name) VALUES ('rollback','rollback@example.test','Rollback')",
        );
        throw new Error("rollback probe");
      });
    } catch {
      /* Expected rollback. */
    }
    result.rollback = matches(db, "Transient OR Rollback");
    result.afterRollback = matches(db, "Robin");
    db.run("DELETE FROM subscribers WHERE id=3");
    result.deleted = matches(db, "Cat");
    return result;
  }
  function deletions() {
    db.run("DELETE FROM events WHERE id=1");
    const eventReference = scalar(db, "SELECT trigger_event_id FROM enrollments WHERE id=1");
    db.run("UPDATE sequence_steps SET status='deleted' WHERE id=1");
    const softStep = scalar(db, "SELECT status FROM sequence_steps WHERE id=1");
    db.run("DELETE FROM subscribers WHERE id=1");
    const result = {
      eventReference,
      softStep,
      events: scalar(db, "SELECT count(*) FROM events WHERE subscriber_id=1"),
      memberships: scalar(db, "SELECT count(*) FROM subscriber_lists WHERE subscriber_id=1"),
      enrollments: scalar(db, "SELECT count(*) FROM enrollments WHERE subscriber_id=1"),
      retainedSends: scalar(db, "SELECT count(*) FROM sends WHERE id=1 AND subscriber_id IS NULL"),
      retainedViews: scalar(db, "SELECT count(*) FROM campaign_views WHERE subscriber_id IS NULL"),
      retainedClicks: scalar(db, "SELECT count(*) FROM link_clicks WHERE subscriber_id IS NULL"),
      bounces: scalar(db, "SELECT count(*) FROM bounces WHERE id=1"),
      deletedFts: matches(db, "Robin"),
    };
    db.run(
      "DELETE FROM lists WHERE id=1; DELETE FROM media WHERE id=1; DELETE FROM templates WHERE id=1",
    );
    return {
      ...result,
      listName: scalar(
        db,
        "SELECT list_name FROM campaign_lists WHERE campaign_id=1 AND list_id IS NULL",
      ),
      mediaName: scalar(
        db,
        "SELECT filename FROM campaign_media WHERE campaign_id=1 AND media_id IS NULL",
      ),
      campaignTemplate: scalar(db, "SELECT template_id FROM campaigns WHERE id=1"),
    };
  }
  function conflict() {
    db.run("CREATE TABLE subscribers(marker TEXT); INSERT INTO subscribers VALUES ('preserved')");
    return true;
  }
  function backup() {
    const names = backupNames(directory);
    const saved = new Database(join(directory, "backups", names[0]!), {
      readonly: true,
      safeIntegers: true,
    });
    try {
      return {
        version: scalar(saved, "PRAGMA user_version"),
        marker: scalar(saved, "SELECT marker FROM subscribers"),
        integrity: scalar(saved, "PRAGMA integrity_check"),
      };
    } finally {
      saved.close(true);
    }
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        const input = (await request.json()) as { action: string };
        let result: unknown;
        switch (input.action) {
          case "status":
            result = status();
            break;
          case "migrate":
            runMigrations(db, directory, clock, productionMigrations);
            result = status();
            break;
          case "seed":
            result = seed();
            break;
          case "constraints":
            result = constraints();
            break;
          case "fts":
            result = fts();
            break;
          case "search":
            result = {
              robin: matches(db, "Robin"),
              bob: matches(db, "Bob"),
              transient: matches(db, "Transient OR Rollback"),
            };
            break;
          case "delete":
            result = deletions();
            break;
          case "conflict":
            result = conflict();
            break;
          case "marker":
            result = scalar(db, "SELECT marker FROM subscribers");
            break;
          case "backup":
            result = backup();
            break;
          default:
            throw new Error("Unknown fixture action");
        }
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
