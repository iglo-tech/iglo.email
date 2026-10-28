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

export async function startUserFixture(policy: AuthPolicy = defaultAuthPolicy, initialize = true) {
  const dataDir = mkdtempSync(join(tmpdir(), "iglo-users-fixture-"));
  const clock = new TestClock();
  const db = openDatabase(dataDir);
  runMigrations(db, dataDir, clock, productionMigrations);
  const lists = createListReferences(db);
  const roles = createRoles(db, lists);
  const users = createUserStore(db, clock, roles);
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
      policy,
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
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, socket) =>
        router.handle(
          app,
          request,
          request.headers.get("x-m13-fixture-peer") ??
            socket.requestIP(request)?.address ??
            "unknown",
        ),
    });
    return {
      admin,
      origin: `http://127.0.0.1:${server.port}`,
      async close() {
        try {
          release();
          releaseLogin();
          await server.stop(true);
        } finally {
          users.close();
          roles.close();
          lists.close();
          db.close(true);
          rmSync(dataDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    users.close();
    roles.close();
    lists.close();
    db.close(true);
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}
