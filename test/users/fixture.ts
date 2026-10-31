// Labelled, loopback-only composition of the production owners with a fake clock.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createTranslation } from "@/i18n/i18n";
import { createListReferences } from "@/lists/references";
import { createRoles } from "@/roles/roles";
import { ok, HttpError } from "@/server/response";
import { hasID } from "@/server/validation";
import { createRouter } from "@/server/server";
import { TestClock } from "@/test/server/fixture";
import { createAuthentication, defaultAuthPolicy, type AuthPolicy } from "@/users/auth";
import { bootstrapAdmin } from "@/users/bootstrap";
import { createUserHandlers } from "@/users/handlers";
import { createFactorHandlers } from "@/users/factor";
import { registerUserRoutes } from "@/users/routes";
import { createUserStore } from "@/users/store";
import { createSettings } from "@/settings/store";
import { registerSettingsRoutes } from "@/settings/routes";
import { sessionDuration } from "@/settings/duration";
import { createEmailer } from "@/messaging/email";
import { createSMTPTest } from "@/messaging/test";
import { createRenderer } from "@/templates/renderer";
import { registerAdminRoutes } from "@/admin/routes";
import type { Message } from "@/messaging/email";

export async function startUserFixture(
  policy: AuthPolicy = defaultAuthPolicy,
  initialize = true,
  liveSettings = false,
  persisted?: { dataDir: string; clock: TestClock },
  smtp = false,
) {
  const dataDir = persisted?.dataDir ?? mkdtempSync(join(tmpdir(), "iglo-users-fixture-"));
  const clock = persisted?.clock ?? new TestClock();
  const db = openDatabase(dataDir);
  runMigrations(db, dataDir, clock, productionMigrations);
  const lists = createListReferences(db);
  const roles = createRoles(db, lists);
  const users = createUserStore(db, clock, roles);
  const settings = createSettings(db, clock, "http://fixture.test", roles);
  try {
    let loginGate = false;
    let announceLogin!: () => void;
    let releaseLogin!: () => void;
    const loginEntered = new Promise<void>((resolve) => {
      announceLogin = resolve;
    });
    const loginRelease = new Promise<void>((resolve) => {
      releaseLogin = resolve;
    });
    const auth = await createAuthentication(
      users,
      roles,
      clock,
      "http://fixture.test",
      liveSettings
        ? {
            ...policy,
            get sessionDurationMs() {
              return sessionDuration(
                settings.read()["security.session_duration"],
                clock.now().getTime(),
              );
            },
          }
        : policy,
      async () => {
        if (loginGate) {
          loginGate = false;
          announceLogin();
          await loginRelease;
        }
      },
    );
    const admin = { user: "fixture-admin", password: "fixture-admin-password" };
    if (initialize) await bootstrapAdmin(users, auth, admin);
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
    const emailer = smtp
      ? createEmailer({
          clock,
          settings: () => ({
            smtp: settings.read().smtp,
            rootUrl: settings.read()["app.root_url"],
          }),
        })
      : undefined;
    registerSettingsRoutes(
      router,
      settings,
      auth,
      emailer && createSMTPTest(settings, emailer, app.i18n, createRenderer(clock, app.i18n)),
    );
    const outgoing: Message[] = [];
    registerAdminRoutes(router, {
      auth,
      roles,
      renderer: createRenderer(clock, app.i18n),
      logger: app.logger,
      send: (message) => {
        outgoing.push(message);
        return { messageId: "<fixture>", result: Promise.resolve({ status: "local" } as never) };
      },
      site: () => ({
        siteName: settings.read()["app.site_name"],
        faviconUrl: "",
        rootUrl: "http://fixture.test",
        lang: "en",
        cacheSlowQueries: settings.read()["app.cache_slow_queries"],
        fromEmails: ["Fixture <fixture@example.test>", "Other <other@example.test>"],
        messengers: ["email"],
        publicSubscription: settings.read()["app.enable_public_subscription_page"],
        trustedUrls: settings.read()["security.trusted_urls"],
        customCss: settings.read()["appearance.admin.custom_css"],
        customJs: settings.read()["appearance.admin.custom_js"],
      }),
      settings: () => ({
        siteName: settings.read()["app.site_name"],
        rootUrl: "http://fixture.test",
        fromEmail: "fixture@example.test",
        logoUrl: "",
      }),
    });
    router.route("GET", "/fixture/mail", () =>
      ok(
        outgoing.map(({ to, subject, body }) => ({
          to,
          subject,
          body: Buffer.from(body).toString(),
        })),
      ),
    );
    let announce!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    router.route(
      "POST",
      "/fixture/gated-create-user",
      createUserHandlers(users, roles, {
        ...auth,
        async hash(password) {
          const hashed = await auth.hash(password);
          announce();
          await gate;
          return hashed;
        },
      }).createUser,
      auth.middleware("users:manage"),
    );
    router.route(
      "PUT",
      "/fixture/gated-user/:id",
      createUserHandlers(users, roles, {
        ...auth,
        async hash(password) {
          const hashed = await auth.hash(password);
          announce();
          await gate;
          return hashed;
        },
      }).updateUser,
      auth.middleware("users:manage"),
      hasID,
    );
    router.route(
      "DELETE",
      "/fixture/gated-twofa/:id",
      createFactorHandlers(users, {
        ...auth,
        async verifyPassword(password, hash) {
          const verified = await auth.verifyPassword(password, hash);
          announce();
          await gate;
          return verified;
        },
      }).disable,
      auth.middleware(),
      hasID,
    );
    router.route(
      "PUT",
      "/fixture/gated-profile",
      createUserHandlers(users, roles, auth).updateProfile,
      auth.middleware(),
      async (_context, next) => {
        announce();
        await gate;
        return next();
      },
    );
    router.route("GET", "/fixture/gate-entered", async () => {
      await entered;
      return ok(true);
    });
    router.route("POST", "/fixture/gate-release", () => {
      release();
      return ok(true);
    });
    router.route("POST", "/fixture/gate-login", () => {
      loginGate = true;
      return ok(true);
    });
    router.route("GET", "/fixture/login-entered", async () => {
      await loginEntered;
      return ok(true);
    });
    router.route("POST", "/fixture/login-release", () => {
      releaseLogin();
      return ok(true);
    });
    router.route("POST", "/fixture/bootstrap", async () => {
      await bootstrapAdmin(users, auth, admin);
      return ok(true);
    });
    router.route("POST", "/fixture/clock", async ({ request }) => {
      const value: unknown = await request.json();
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        throw new HttpError(400);
      clock.advance(value);
      return ok(true);
    });
    router.route("POST", "/fixture/role", async ({ request }) => {
      const value = (await request.json()) as { name?: unknown; permissions?: unknown };
      if (
        typeof value.name !== "string" ||
        !Array.isArray(value.permissions) ||
        value.permissions.some((item) => typeof item !== "string")
      )
        throw new HttpError(400);
      return ok(
        Number(
          roles.createUserRole(
            value.name,
            value.permissions as string[],
            clock.now().toISOString(),
          ),
        ),
      );
    });
    router.route("POST", "/fixture/totp-user", async () => {
      const hash = await auth.hash("fixture-user-password");
      const user = users.create({
        username: "fixture-totp",
        email: "fixture-totp@example.test",
        name: "fixture-totp",
        type: "user",
        status: "enabled",
        passwordLogin: true,
        password: hash,
        userRoleId: 1n,
        listRoleId: null,
        twofaType: "totp",
      });
      return ok(Number(user.id));
    });
    // Synthetic list provisioning is a fixture boundary, not a production list API.
    router.route("POST", "/fixture/list", () => {
      const row = db
        .query("INSERT INTO lists(uuid, name, type) VALUES (?, ?, 'private') RETURNING id")
        .get(crypto.randomUUID(), "Synthetic list") as { id: bigint };
      return ok(Number(row.id));
    });
    router.route(
      "GET",
      "/fixture/list-permission/:id",
      (context) => {
        const principal = context.identity!;
        return ok(
          roles.canList(principal.role, principal.user.list_role_id, "list:get", [
            BigInt(context.id!),
          ]),
        );
      },
      auth.middleware(),
      hasID,
    );
    router.route("POST", "/fixture/list-role", () =>
      ok(Number(roles.createListRole("Fixture list role", clock.now().toISOString()))),
    );
    let bodyRead!: () => void;
    const bodyEntered = new Promise<void>((resolve) => {
      bodyRead = resolve;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (original, socket) => {
        let request = original;
        if (original.headers.has("x-m12-gated-body") && original.body) {
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
        return router.handle(
          app,
          request,
          request.headers.get("x-m13-fixture-peer") ??
            socket.requestIP(request)?.address ??
            "unknown",
        );
      },
    });
    return {
      admin,
      origin: `http://127.0.0.1:${server.port}`,
      bodyEntered,
      closeMessaging: () => emailer?.close() ?? Promise.resolve(),
      persisted: { dataDir, clock },
      // Arrange historical and damaged synthetic records; observations use HTTP.
      arrangeSession(
        cookie: string,
        expiry: "legacy" | "invalid" | "overflow" | "before-created" | "future-created",
      ) {
        const id = /(?:^|;\s*)session=([^;]+)/.exec(cookie)?.[1];
        if (!id) throw new Error("Missing synthetic session");
        if (expiry === "legacy")
          db.query("UPDATE sessions SET data = json_remove(data, '$.expires_at') WHERE id = ?").run(
            id,
          );
        else if (expiry === "invalid")
          db.query(
            "UPDATE sessions SET data = json_set(data, '$.expires_at', 'invalid') WHERE id = ?",
          ).run(id);
        else if (expiry === "overflow")
          db.query(
            "UPDATE sessions SET data = json_set(data, '$.expires_at', 8640000000000001) WHERE id = ?",
          ).run(id);
        else if (expiry === "before-created")
          db.query("UPDATE sessions SET data = json_set(data, '$.expires_at', 0) WHERE id = ?").run(
            id,
          );
        else
          db.query("UPDATE sessions SET created_at = ? WHERE id = ?").run(
            new Date(clock.now().getTime() + 1000).toISOString(),
            id,
          );
      },
      async close(preserve = false) {
        try {
          release();
          releaseLogin();
          await server.stop(true);
          await emailer?.close();
        } finally {
          users.close();
          settings.close();
          roles.close();
          lists.close();
          db.close(true);
          if (!preserve) rmSync(dataDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    users.close();
    settings.close();
    roles.close();
    lists.close();
    db.close(true);
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}
