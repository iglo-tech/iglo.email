// B24 (D84): migration 18 normalizes what an older build stored: a bounce rule with count 0 and
// the TOTP key of a user who is an API user or has password login off. Seen through the API.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { permissions } from "@/roles/roles";
import { hashPassword } from "@/users/password";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { TestClock } from "@/test/server/fixture";
import { startUserFixture } from "@/test/users/fixture";
import { txFixture } from "@/test/tx/fixture";

const apiKey = "legacy-api-key-0123456789";
async function legacy(
  admin: { user: string; password: string },
  extraRules: Record<string, unknown> = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), "iglo-b24-"));
  const clock = new TestClock();
  const db = openDatabase(dataDir);
  runMigrations(db, dataDir, clock, productionMigrations.slice(0, 17));
  db.run(`INSERT INTO roles(id, type, name, permissions) VALUES (1, 'user', 'Super Admin', ?)`, [
    JSON.stringify(permissions),
  ]);
  db.run(
    `INSERT INTO users(username, password_login, password, email, name, type, status, user_role_id)
     VALUES (?, 1, ?, 'admin@example.test', 'Admin', 'user', 'enabled', 1)`,
    [admin.user, await hashPassword(admin.password)],
  );
  const user = db.prepare(
    `INSERT INTO users(username, email, name, type, password_login, status, user_role_id, twofa_type, twofa_key)
     VALUES (?1, ?1 || '@example.test', ?1, ?2, ?3, 'enabled', 1, 'totp', 'GEZDGNBVGY3TQOJQ')`,
  );
  user.run("api-user", "api", 0);
  db.run("UPDATE users SET password = ? WHERE username = 'api-user'", [
    createHash("sha256").update(apiKey).digest("hex"),
  ]);
  user.run("no-password", "user", 0);
  user.run("password-user", "user", 1);
  db.run(`INSERT INTO settings(key, value) VALUES ('bounce.actions', ?)`, [
    JSON.stringify({
      soft: { count: 0, action: "unsubscribe" },
      hard: { count: 3, action: "blocklist" },
      complaint: { count: 0, action: "none" },
      ...extraRules,
    }),
  ]);
  db.close(true);
  return { dataDir, clock };
}

test("migration 18 clears stale TOTP keys and raises a stored zero bounce count to 1", async () => {
  const persisted = await legacy({
    user: "fixture-admin",
    password: "fixture-admin-password",
  });
  const f = await startUserFixture(undefined, true, false, persisted);
  try {
    const page = await fetch(`${f.origin}/admin/login`);
    const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const nonceCookie = page.headers
      .getSetCookie()
      .find((v) => v.startsWith("nonce="))!
      .split(";")[0]!;
    const login = await fetch(`${f.origin}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: nonceCookie,
      },
      body: new URLSearchParams({
        username: f.admin.user,
        password: f.admin.password,
        nonce,
      }),
    });
    const set = login.headers.getSetCookie();
    const cookie = ["session", "csrf"]
      .map((n) => set.find((v) => v.startsWith(`${n}=`))!.split(";")[0])
      .join("; ");
    const get = async (path: string) =>
      ((await (await fetch(`${f.origin}${path}`, { headers: { cookie } })).json()) as any).data;
    const users = await get("/api/users");
    const type = (name: string) => users.find((u: any) => u.username === name).twofa_type;
    expect(type("api-user")).toBe("none");
    expect(type("no-password")).toBe("none");
    expect(type("password-user")).toBe("totp");
    const rules = (await get("/api/settings"))["bounce.actions"];
    expect(rules.soft).toEqual({ count: 1, action: "unsubscribe" });
    expect(rules.hard).toEqual({ count: 3, action: "blocklist" });
    expect(rules.complaint).toEqual({ count: 1, action: "none" });
  } finally {
    await f.close();
    rmSync(persisted.dataDir, { recursive: true, force: true });
  }
});

test("a bounce rule that is not a JSON object cannot block migration 18", async () => {
  const persisted = await legacy(
    { user: "fixture-admin", password: "fixture-admin-password" },
    { text: "by hand", number: 7, list: [1, 2], flag: true, nothing: null },
  );
  try {
    const db = openDatabase(persisted.dataDir);
    runMigrations(db, persisted.dataDir, persisted.clock, productionMigrations);
    const row = db.query("SELECT value FROM settings WHERE key = 'bounce.actions'").get() as {
      value: string;
    };
    db.close(true);
    expect(JSON.parse(row.value)).toEqual({
      soft: { count: 1, action: "unsubscribe" },
      hard: { count: 3, action: "blocklist" },
      complaint: { count: 1, action: "none" },
      text: "by hand",
      number: 7,
      list: [1, 2],
      flag: true,
      nothing: null,
    });
  } finally {
    rmSync(persisted.dataDir, { recursive: true, force: true });
  }
});

test("after the count 0 rewrite a bounce is recorded and its action fires", async () => {
  const persisted = await legacy(
    { user: "fixture-admin", password: "fixture-admin-password" },
    { soft: { count: 0, action: "blocklist" } },
  );
  const f = await txFixture({ webhooks: {}, persisted });
  try {
    const stored = f.db.query("SELECT value FROM settings WHERE key = 'bounce.actions'").get() as {
      value: string;
    };
    Object.assign(f.bounceSettings.actions, JSON.parse(stored.value));
    const id = await f.subscriber("legacy-bounce@example.com");
    const post = await f.json("/webhooks/bounce", "POST", {
      email: "legacy-bounce@example.com",
      type: "soft",
      source: "api",
    });
    expect(post.status).toBe(200);
    // The rewritten soft rule is "1 bounce, blocklist"; with count 0 it recorded no row.
    const bounces = (await f.json("/api/bounces")).body.data.results;
    expect(bounces.map((b: any) => [b.email, b.type])).toEqual([
      ["legacy-bounce@example.com", "soft"],
    ]);
    expect((await f.json(`/api/subscribers/${id}`)).body.data.status).toBe("blocklisted");
  } finally {
    await f.close();
  }
});

test("migrated accounts: the API user keeps its key, the password-off user has no TOTP prompt", async () => {
  const persisted = await legacy({ user: "fixture-admin", password: "fixture-admin-password" });
  const f = await startUserFixture(undefined, true, false, persisted);
  try {
    const key = await fetch(`${f.origin}/api/profile`, {
      headers: { authorization: `token api-user:${apiKey}` },
    });
    expect(key.status).toBe(200);
    expect(((await key.json()) as any).data.username).toBe("api-user");
    const attempt = async (username: string) => {
      const page = await fetch(`${f.origin}/admin/login`);
      const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
      const nonceCookie = page.headers
        .getSetCookie()
        .find((v) => v.startsWith("nonce="))!
        .split(";")[0]!;
      const response = await fetch(`${f.origin}/admin/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie },
        body: new URLSearchParams({ username, password: apiKey, nonce }),
      });
      return {
        location: response.headers.get("location") ?? "",
        session: response.headers.getSetCookie().some((v) => v.startsWith("session=")),
      };
    };
    // Neither account can use a password. Neither is asked for a second factor.
    for (const name of ["api-user", "no-password"]) {
      const result = await attempt(name);
      expect(result.session).toBe(false);
      expect(result.location).not.toContain("totp");
    }
  } finally {
    await f.close();
    rmSync(persisted.dataDir, { recursive: true, force: true });
  }
});
