// Test-only composition of the shared modules; no production routes are added.
import { randomInt } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/app";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { createTranslation } from "@/i18n/i18n";
import type { Middleware } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import { createRouter, startServer } from "@/server/server";
import { bindJSON, getID, hasID, strHasLen } from "@/server/validation";
import type { Credentials } from "@/test/contract/types";

export function startContractFixture(credentials: Credentials) {
  const dataDir = mkdtempSync(join(tmpdir(), "iglo-contract-fixture-"));
  const clock = createRealClock();
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(dataDir);
    const app = createApp({
      bootstrap: {
        host: "127.0.0.1",
        port: 0,
        dataDir,
        rootUrl: "http://127.0.0.1",
        initialAdmin: { user: undefined, password: undefined },
      },
      clock,
      db,
      i18n: createTranslation(),
      logger: { error: () => {} },
    });
    const router = createRouter();
    const auth: Middleware = (context, next) => {
      const pair = `${credentials.user}:${credentials.token}`;
      const header = context.request.headers.get("authorization");
      if (header !== `Basic ${Buffer.from(pair).toString("base64")}` && header !== `token ${pair}`)
        throw new HttpError(403, "invalid API credentials");
      return next();
    };
    router.route("GET", "/api/health", () => ok(true), auth);
    router.route(
      "GET",
      "/fixture/id/:id",
      (context) => {
        const id = getID(context);
        return ok(typeof id === "bigint" ? id.toString() : id);
      },
      auth,
      hasID,
    );
    router.route(
      "POST",
      "/fixture/input",
      async (context) => {
        const value = await bindJSON(context.request);
        const input =
          typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
        if (typeof input.name !== "string" || !strHasLen(input.name, 1, 2000))
          throw new HttpError(400, context.app.i18n.T("globals.messages.invalidName"));
        if (
          input.type !== undefined &&
          input.type !== "" &&
          input.type !== "public" &&
          input.type !== "private"
        )
          throw new HttpError(
            400,
            context.app.i18n.Ts("globals.messages.invalidFields", "name", "type"),
          );
        return ok(true);
      },
      auth,
    );
    const id = randomInt(1, 1_000_000_000);
    const other = id + 1;
    const created = clock.now();
    const updated = new Date(created.getTime() + 1000);
    router.route("GET", "/fixture/probe", () =>
      ok({
        id,
        owner_id: id,
        other_id: other,
        created_at: created.toISOString(),
        created_copy: created.toISOString(),
        updated_at: updated.toISOString(),
        label: "synthetic 101",
        fixed: { id: 77 },
      }),
    );
    router.route("GET", "/fixture/probe/reference", () => ok({ id }));
    const server = startServer(app, router);
    return {
      origin: `http://127.0.0.1:${server.port}`,
      async close() {
        try {
          await server.stop(true);
        } finally {
          try {
            db!.close(true);
          } finally {
            rmSync(dataDir, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error) {
    try {
      db?.close(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
    throw error;
  }
}
