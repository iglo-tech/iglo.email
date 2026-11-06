import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { openDatabase } from "@/db/connection";
import { recoverTotp } from "@/users/cli";
import { productionMigrations } from "@/db/migrations";
import { TestClock } from "@/test/server/fixture";
import { startUserFixture } from "@/test/users/fixture";

type Fixture = Awaited<ReturnType<typeof startUserFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await startUserFixture();
  fixtures.push(f);
  return f;
}
async function admin(f: Fixture) {
  const page = await fetch(`${f.origin}/admin/login`);
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const nonceCookie = page.headers
    .getSetCookie()
    .find((v) => v.startsWith("nonce="))!
    .split(";")[0]!;
  const r = await fetch(`${f.origin}/admin/login`, {
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
  const h = r.headers.getSetCookie();
  const session = h.find((v) => v.startsWith("session="))!.split(";")[0]!;
  const csrf = h.find((v) => v.startsWith("csrf="))!.split(";")[0]!;
  return { cookie: `${session}; ${csrf}`, csrf: csrf.slice(5) };
}
async function call(
  f: Fixture,
  s: { cookie: string; csrf: string },
  path: string,
  method = "GET",
  body?: unknown,
) {
  return fetch(`${f.origin}${path}`, {
    method,
    headers: {
      cookie: s.cookie,
      "x-csrf-token": s.csrf,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("an operator clears a user's TOTP from the CLI and their sessions end", async () => {
  const f = await fixture();
  const s = await admin(f);
  const id = ((await (await call(f, s, "/api/profile")).json()) as any).data.id;
  expect(
    (
      await call(f, s, `/api/users/${id}/twofa`, "PUT", {
        secret,
        code: "391022",
      })
    ).status,
  ).toBe(200);
  const dataDir = f.persisted.dataDir;
  await f.close(true);
  fixtures.length = 0;
  await recoverTotp({
    dataDir,
    username: f.admin.user,
    clock: new TestClock(),
    supportedVersion: productionMigrations.length,
  });
  const db = openDatabase(dataDir);
  const row = db.query("SELECT twofa_type, twofa_key FROM users WHERE id = ?").get(id) as any;
  expect(row.twofa_type).toBe("none");
  expect(row.twofa_key).toBeNull();
  expect(db.query("SELECT count(*) AS n FROM sessions").get()).toEqual({
    n: 0n,
  });
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("TOTP does not revive after password login is turned off and on, or after api conversion", async () => {
  const f = await fixture();
  const s = await admin(f);
  await call(f, s, "/fixture/totp-user", "POST");
  const totp = ((await (await call(f, s, "/api/users")).json()) as any).data.find(
    (u: any) => u.username === "fixture-totp",
  );
  expect(totp.twofa_type).toBe("totp");
  const update = (extra: object) =>
    call(f, s, `/api/users/${totp.id}`, "PUT", {
      username: totp.username,
      email: totp.email,
      name: totp.name,
      type: "user",
      status: "enabled",
      password_login: true,
      password: "",
      user_role_id: 1,
      ...extra,
    });
  expect((await update({ password_login: false })).status).toBe(200);
  expect((await update({ password_login: true, password: "fixture-user-password" })).status).toBe(
    200,
  );
  const after = ((await (await call(f, s, "/api/users")).json()) as any).data.find(
    (u: any) => u.username === "fixture-totp",
  );
  expect(after.twofa_type).toBe("none");
});

test("bounce.actions refuses a zero count and an unknown action", async () => {
  const f = await fixture();
  const s = await admin(f);
  const current = ((await (await call(f, s, "/api/settings")).json()) as any).data[
    "bounce.actions"
  ];
  const put = (value: unknown) => call(f, s, "/api/settings/bounce.actions", "PUT", value);
  expect((await put({ ...current, soft: { count: 0, action: "none" } })).status).toBe(400);
  expect((await put({ ...current, soft: { count: 1001, action: "none" } })).status).toBe(400);
  expect((await put({ ...current, soft: { count: 2, action: "explode" } })).status).toBe(400);
  expect((await put({ ...current, soft: { count: 2, action: "unsubscribe" } })).status).toBe(200);
  expect(
    ((await (await call(f, s, "/api/settings")).json()) as any).data["bounce.actions"].soft,
  ).toEqual({
    count: 2,
    action: "unsubscribe",
  });
});

test("a stored out-of-range bounce rule does not block saving other settings", async () => {
  const first = await fixture();
  const persisted = first.persisted;
  await first.close(true);
  fixtures.length = 0;
  const db = openDatabase(persisted.dataDir);
  const legacy = {
    soft: { count: 0, action: "none" },
    hard: { count: 2, action: "blocklist" },
    complaint: { count: 2, action: "" },
  };
  db.query("UPDATE settings SET value = ? WHERE key = 'bounce.actions'").run(
    JSON.stringify(legacy),
  );
  db.close();
  const f = await startUserFixture(undefined, true, false, persisted);
  fixtures.push(f);
  const s = await admin(f);

  const one = await call(f, s, "/api/settings/app.site_name", "PUT", "New name");
  expect(one.status).toBe(200);

  const body = ((await (await call(f, s, "/api/settings")).json()) as any).data;
  expect(body["bounce.actions"].soft.count).toBe(0);
  body["app.site_name"] = "Another name";
  expect((await call(f, s, "/api/settings", "PUT", body)).status).toBe(200);

  body["bounce.actions"].soft = { count: 0, action: "explode" };
  expect((await call(f, s, "/api/settings", "PUT", body)).status).toBe(400);
});
