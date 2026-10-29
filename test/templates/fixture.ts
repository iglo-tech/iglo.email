// Test-only composition and campaign-owner controls; no fixture routes enter production.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { createCampaignTemplateReferences } from "@/campaigns/template-references";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { createListReferences } from "@/lists/references";
import { createRoles } from "@/roles/roles";
import { ok } from "@/server/response";
import { createRouter } from "@/server/server";
import { createRenderer } from "@/templates/renderer";
import { registerTemplateRoutes } from "@/templates/routes";
import { createTemplateStore } from "@/templates/store";
import { TestClock } from "@/test/server/fixture";
import { createAuthentication, defaultAuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { registerUserRoutes } from "@/users/routes";
import { createUserStore } from "@/users/store";

export async function startTemplateFixture(
  options: { saturateFirstPreview?: boolean; holdPreview?: boolean } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), "iglo-template-fixture-"));
  const db = openDatabase(dataDir),
    clock = new TestClock();
  runMigrations(db, dataDir, clock, productionMigrations);
  const references = createListReferences(db),
    roles = createRoles(db, references),
    users = createUserStore(db, clock, roles),
    campaigns = createCampaignTemplateReferences(db);
  const admin = { user: "fixture-admin", password: "fixture-admin-password" };
  const i18n = createTranslation(),
    errors: unknown[] = [];
  const logger = { error: (error: unknown) => errors.push(error) };
  const renderer = createRenderer(clock, i18n),
    templates = createTemplateStore(db, clock, renderer, campaigns);
  try {
    templates.initialize();
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
      i18n,
      logger,
    });
    const router = createRouter();
    registerUserRoutes(router, users, roles, auth);
    let saturate = options.saturateFirstPreview === true;
    let previewEntered!: () => void;
    let releasePreview!: () => void;
    const previewHeld = new Promise<void>((resolve) => {
      previewEntered = resolve;
    });
    const previewRelease = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    const previewRenderer = {
      ...renderer,
      render(request: Parameters<typeof renderer.render>[0]) {
        if (!saturate) {
          const rendered = renderer.render(request);
          if (!options.holdPreview) return rendered;
          return (async () => {
            const result = await rendered;
            previewEntered();
            await previewRelease;
            return result;
          })();
        }
        saturate = false;
        // All four real admissions are entered synchronously before their awaited
        // continuation can run. The route makes the fifth real admission.
        const held = Array.from({ length: 4 }, () => renderer.render(request));
        const fifth = renderer.render(request);
        void Promise.allSettled(held);
        return fifth;
      },
    };
    registerTemplateRoutes(router, templates, previewRenderer, auth);
    router.route("POST", "/fixture/campaign", async ({ request }) => {
      const { template } = (await request.json()) as { template: string };
      db.query(
        "INSERT INTO campaigns(uuid,name,subject,from_email,body,messenger,template_id,archive_template_id) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        crypto.randomUUID(),
        "Synthetic",
        "Synthetic",
        "from@example.test",
        "body",
        "email",
        BigInt(template),
        BigInt(template),
      );
      return ok(true);
    });
    router.route("GET", "/fixture/campaign", () => {
      const row = db
        .query("SELECT template_id, archive_template_id FROM campaigns LIMIT 1")
        .get() as { template_id: bigint | null; archive_template_id: bigint | null };
      return ok({
        primary: row.template_id === null ? null : row.template_id.toString(),
        archive: row.archive_template_id === null ? null : row.archive_template_id.toString(),
      });
    });
    // Synthetic future-owner references, exposed only through this fixture.
    router.route("POST", "/fixture/history", async ({ request }) => {
      const { template } = (await request.json()) as { template: string };
      const sequence = db
        .query("INSERT INTO sequences(uuid,name,trigger) VALUES(?,?,'{}') RETURNING id")
        .get(crypto.randomUUID(), "Synthetic sequence") as { id: bigint };
      db.query(
        "INSERT INTO sequence_steps(uuid,sequence_id,position,wait,kind,template_id) VALUES(?,?,1,'0s','transactional',?)",
      ).run(crypto.randomUUID(), sequence.id, BigInt(template));
      db.query(
        "INSERT INTO sends(uuid,source,kind,to_email,template_id) VALUES(?,'tx','transactional','synthetic@example.test',?)",
      ).run(crypto.randomUUID(), BigInt(template));
      return ok(true);
    });
    router.route("GET", "/fixture/history", () => {
      const sequence = db.query("SELECT template_id FROM sequence_steps LIMIT 1").get() as {
        template_id: bigint | null;
      };
      const send = db.query("SELECT template_id FROM sends LIMIT 1").get() as {
        template_id: bigint | null;
      };
      return ok({
        sequence: sequence.template_id === null ? null : sequence.template_id.toString(),
        send: send.template_id === null ? null : send.template_id.toString(),
      });
    });
    router.route("POST", "/fixture/sequence", () => {
      db.query("UPDATE sqlite_sequence SET seq=? WHERE name='templates'").run(9007199254740992n);
      return ok(true);
    });
    router.route("POST", "/fixture/clear-default", () => {
      db.query("UPDATE templates SET is_default=0").run();
      return ok(true);
    });
    router.route("POST", "/fixture/initialize", () => {
      templates.initialize();
      return ok(true);
    });
    router.route("GET", "/fixture/diagnostics", () => ok(errors.map(String)));
    let bodyRead!: () => void;
    const bodyEntered = new Promise<void>((resolve) => {
      bodyRead = resolve;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (original, socket) => {
        let request = original;
        if (original.headers.has("x-m18-gated-body") && original.body) {
          const reader = original.body.getReader();
          const stream = new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                bodyRead();
                const result = await reader.read();
                if (result.done) controller.close();
                else controller.enqueue(result.value);
              },
              cancel: () => reader.cancel(),
            },
            { highWaterMark: 0 },
          );
          request = new Request(original, { method: original.method, body: stream });
        }
        return router.handle(app, request, socket.requestIP(request)?.address ?? "unknown");
      },
    });
    return {
      origin: `http://127.0.0.1:${server.port}`,
      admin,
      bodyEntered,
      previewHeld,
      releasePreview,
      async close() {
        await server.stop(true);
        templates.close();
        campaigns.close();
        users.close();
        roles.close();
        references.close();
        db.close(true);
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    templates.close();
    campaigns.close();
    users.close();
    roles.close();
    references.close();
    db.close(true);
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}
