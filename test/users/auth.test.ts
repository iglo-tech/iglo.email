import { afterEach, expect, test } from "bun:test";
import { startUserFixture } from "@/test/users/fixture";
import { defaultAuthPolicy } from "@/users/auth";

type Fixture = Awaited<ReturnType<typeof startUserFixture>>;
type Session = { cookie: string; csrf: string; headers: string[] };
const fixtures: Fixture[] = [];
async function fixture(policy = defaultAuthPolicy) {
  const value = await startUserFixture(policy);
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  for (const value of fixtures.splice(0)) await value.close();
});

async function login(
  fixture: Fixture,
  username: string,
  password: string,
  prior = "",
): Promise<Session> {
  const page = await fetch(`${fixture.origin}/admin/login?next=%2Fapi%2Fprofile`);
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1];
  const nonceCookie = page.headers
    .getSetCookie()
    .find((value) => value.startsWith("nonce="))
    ?.split(";", 1)[0];
  expect(nonce).toBeTruthy();
  expect(nonceCookie).toBeTruthy();
  const response = await fetch(`${fixture.origin}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: [nonceCookie, prior].filter(Boolean).join("; "),
    },
    body: new URLSearchParams({ username, password, nonce: nonce!, next: "/api/profile" }),
  });
  expect(response.status).toBe(302);
  const headers = response.headers.getSetCookie();
  const cookie = headers.find((value) => value.startsWith("session="))?.split(";", 1)[0] ?? "";
  const csrfCookie = headers.find((value) => value.startsWith("csrf="))?.split(";", 1)[0] ?? "";
  expect(cookie).not.toBe("");
  expect(csrfCookie).not.toBe("");
  return { cookie: `${cookie}; ${csrfCookie}`, csrf: csrfCookie.slice("csrf=".length), headers };
}
async function call(
  fixture: Fixture,
  path: string,
  options: {
    method?: string;
    session?: Session;
    auth?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = new Headers(options.headers);
  if (options.session) {
    headers.set("cookie", options.session.cookie);
    headers.set("x-csrf-token", options.session.csrf);
  }
  if (options.auth) headers.set("authorization", options.auth);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${fixture.origin}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: "manual",
  });
}
async function createHuman(fixture: Fixture, session: Session, username: string) {
  const input = {
    username,
    email: `${username}@example.test`,
    type: "user",
    status: "enabled",
    password_login: true,
    password: "fixture-user-password",
    user_role_id: 1,
  };
  const response = await call(fixture, "/api/users", { method: "POST", session, body: input });
  expect(response.status).toBe(200);
  return { input, user: ((await response.json()) as { data: { id: number } }).data };
}

test("session cookies rotate on login and expire according to the injected clock", async () => {
  const f = await fixture();
  const first = await login(f, f.admin.user, f.admin.password);
  expect(first.headers.find((value) => value.startsWith("session="))).toContain("HttpOnly");
  for (const item of first.headers) {
    expect(item).toContain("Path=/");
    expect(item).toContain("SameSite=Lax");
    expect(item).not.toContain("Secure");
  }
  const second = await login(f, f.admin.user, f.admin.password, first.cookie);
  expect(second.cookie).not.toBe(first.cookie);
  expect((await call(f, "/api/profile", { session: first })).status).toBe(403);
  expect((await call(f, "/api/profile", { session: second })).status).toBe(200);
  await call(f, "/fixture/clock", {
    method: "POST",
    body: defaultAuthPolicy.sessionDurationMs - 1,
  });
  expect((await call(f, "/api/profile", { session: second })).status).toBe(200);
  await call(f, "/fixture/clock", { method: "POST", body: 1 });
  expect((await call(f, "/api/profile", { session: second })).status).toBe(403);
});

test("profile and admin password changes, disable and delete revoke the right sessions", async () => {
  const f = await fixture();
  const admin = await login(f, f.admin.user, f.admin.password);
  const { input, user } = await createHuman(f, admin, "fixture-human");
  const first = await login(f, input.username, input.password);
  const second = await login(f, input.username, input.password);
  const profile = await call(f, "/api/profile", {
    method: "PUT",
    session: first,
    body: { name: "Fixture", email: input.email, password: "  fixture-changed-password  " },
  });
  expect(profile.status).toBe(200);
  expect((await call(f, "/api/profile", { session: first })).status).toBe(200);
  expect((await call(f, "/api/profile", { session: second })).status).toBe(403);
  const third = await login(f, input.username, "  fixture-changed-password  ");
  const changed = await call(f, `/api/users/${user.id}`, {
    method: "PUT",
    session: admin,
    body: { ...input, password: "  fixture-admin-reset-password  " },
  });
  expect(changed.status).toBe(200);
  expect((await call(f, "/api/profile", { session: first })).status).toBe(403);
  expect((await call(f, "/api/profile", { session: third })).status).toBe(403);
  const fourth = await login(f, input.username, "  fixture-admin-reset-password  ");
  for (const status of ["disabled", "enabled"]) {
    const update = await call(f, `/api/users/${user.id}`, {
      method: "PUT",
      session: admin,
      body: { ...input, password: "", status },
    });
    expect(update.status).toBe(200);
  }
  expect((await call(f, "/api/profile", { session: fourth })).status).toBe(403);
  const fifth = await login(f, input.username, "  fixture-admin-reset-password  ");
  expect(
    (await call(f, `/api/users/${user.id}`, { method: "DELETE", session: admin })).status,
  ).toBe(200);
  const replacement = await createHuman(f, admin, input.username);
  expect(replacement.user.id).toBeGreaterThan(user.id);
  expect((await call(f, "/api/profile", { session: fifth })).status).toBe(403);
  expect(
    (await call(f, `/api/users/${replacement.user.id}`, { method: "DELETE", session: admin }))
      .status,
  ).toBe(200);
  const adminProfile = await call(f, "/api/profile", { session: admin });
  const adminId = ((await adminProfile.json()) as { data: { id: number } }).data.id;
  expect(
    (await call(f, `/api/users/${adminId}`, { method: "DELETE", session: admin })).status,
  ).toBe(400);
  expect((await call(f, "/api/profile", { session: admin })).status).toBe(200);
});

test("a profile write already in flight cannot outlive revocation", async () => {
  const f = await fixture();
  const admin = await login(f, f.admin.user, f.admin.password);
  const { input, user } = await createHuman(f, admin, "fixture-in-flight");
  const victim = await login(f, input.username, input.password);
  const pending = call(f, "/fixture/gated-profile", {
    method: "PUT",
    session: victim,
    body: { name: "Unexpected change", email: input.email, password: "fixture-revoked-password" },
  });
  expect((await call(f, "/fixture/gate-entered")).status).toBe(200);
  expect(
    (
      await call(f, `/api/users/${user.id}`, {
        method: "PUT",
        session: admin,
        body: { ...input, password: "", status: "disabled" },
      })
    ).status,
  ).toBe(200);
  expect((await call(f, "/fixture/gate-release", { method: "POST" })).status).toBe(200);
  expect((await pending).status).toBe(403);
  expect(
    (
      await call(f, `/api/users/${user.id}`, {
        method: "PUT",
        session: admin,
        body: { ...input, password: "", status: "enabled" },
      })
    ).status,
  ).toBe(200);
  const valid = await login(f, input.username, input.password);
  const profile = (await (await call(f, "/api/profile", { session: valid })).json()) as {
    data: { name: string };
  };
  expect(profile.data.name).toBe(input.username);
});

for (const scenario of ["omitted", "zero-empty", "converted-api", "explicit"] as const) {
  test(`password update preserves concurrent target changes: ${scenario}`, async () => {
    const f = await fixture();
    const admin = await login(f, f.admin.user, f.admin.password);
    const { input, user } = await createHuman(f, admin, "fixture-concurrent-target");
    const victim = await login(f, input.username, input.password);
    const roleResponse = await call(f, "/fixture/role", {
      method: "POST",
      body: { name: "Reader", permissions: ["users:get"] },
    });
    const role = ((await roleResponse.json()) as { data: number }).data;
    const listResponse = await call(f, "/fixture/list-role", { method: "POST" });
    const listRole = ((await listResponse.json()) as { data: number }).data;
    const defaults =
      scenario === "explicit"
        ? { type: "user", status: "enabled", user_role_id: 1 }
        : scenario === "zero-empty"
          ? { type: "", status: "", user_role_id: 0 }
          : {};
    const pending = call(f, `/fixture/gated-user/${user.id}`, {
      method: "PUT",
      session: admin,
      body: {
        username: input.username,
        name: "Password changed",
        email: input.email,
        password_login: true,
        password: "fixture-concurrent-new-password",
        list_role_id: 0,
        ...defaults,
      },
    });
    void pending.catch(() => {});
    expect((await call(f, "/fixture/gate-entered")).status).toBe(200);
    const concurrent = await call(f, `/api/users/${user.id}`, {
      method: "PUT",
      session: admin,
      body: {
        ...input,
        password: "",
        status: "disabled",
        user_role_id: role,
        list_role_id: listRole,
        type: scenario === "converted-api" ? "api" : "user",
        password_login: scenario !== "converted-api",
      },
    });
    expect(concurrent.status).toBe(200);
    expect(((await concurrent.json()) as { data: { status: string } }).data.status).toBe(
      "disabled",
    );
    expect((await call(f, "/fixture/gate-release", { method: "POST" })).status).toBe(200);
    expect((await pending).status).toBe(200);
    const response = await call(f, `/api/users/${user.id}`, { session: admin });
    const result = (
      (await response.json()) as {
        data: {
          name: string;
          type: string;
          status: string;
          password: string | null;
          password_login: boolean;
          user_role: { id: number };
          list_role: { id: number };
        };
      }
    ).data;
    expect(result.name).toBe("Password changed");
    expect(result.status).toBe(scenario === "explicit" ? "enabled" : "disabled");
    expect(result.user_role.id).toBe(scenario === "explicit" ? 1 : role);
    expect(result.list_role.id).toBe(listRole);
    expect(result.type).toBe(scenario === "converted-api" ? "api" : "user");
    expect(result.password).toBeNull();
    expect(result.password_login).toBe(scenario !== "converted-api");
    expect((await call(f, "/api/profile", { session: victim })).status).toBe(403);
    if (scenario !== "converted-api") {
      const enabled = await call(f, `/api/users/${user.id}`, {
        method: "PUT",
        session: admin,
        body: {
          ...input,
          name: result.name,
          password: "",
          status: "enabled",
          user_role_id: 0,
          list_role_id: 0,
        },
      });
      expect(enabled.status).toBe(200);
      expect((await call(f, "/api/profile", { session: victim })).status).toBe(403);
      const fresh = await login(f, input.username, "fixture-concurrent-new-password");
      expect((await call(f, "/api/profile", { session: fresh })).status).toBe(200);
    }
  });
}

test("lower-permission API users can read only where granted and cannot escalate their profiles", async () => {
  const f = await fixture();
  const admin = await login(f, f.admin.user, f.admin.password);
  const roleResponse = await call(f, "/fixture/role", {
    method: "POST",
    body: { name: "Reader", permissions: ["users:get"] },
  });
  const role = ((await roleResponse.json()) as { data: number }).data;
  const response = await call(f, "/api/users", {
    method: "POST",
    session: admin,
    body: { username: "fixture-reader", type: "api", status: "enabled", user_role_id: role },
  });
  const api = ((await response.json()) as { data: { id: number; password: string } }).data;
  const auth = `token fixture-reader:${api.password}`;
  expect((await call(f, "/api/users", { auth })).status).toBe(200);
  expect((await call(f, "/api/users", { method: "POST", auth, body: {} })).status).toBe(403);
  expect((await call(f, `/api/users/${api.id}`, { method: "DELETE", auth })).status).toBe(403);
  expect(
    (
      await call(f, "/api/logout", {
        method: "POST",
        auth,
        headers: { origin: "https://foreign.example.test" },
      })
    ).status,
  ).toBe(403);
  expect((await call(f, "/api/health", { auth })).status).toBe(200);
  const updated = await call(f, "/api/profile", {
    method: "PUT",
    auth,
    body: { name: "Reader", type: "user", username: "admin", user_role_id: 1 },
  });
  expect(updated.status).toBe(200);
  const profile = (
    (await updated.json()) as {
      data: { username: string; type: string; user_role: { id: number } };
    }
  ).data;
  expect(profile.username).toBe("fixture-reader");
  expect(profile.type).toBe("api");
  expect(profile.user_role.id).toBe(role);
});

test("user detail and user list preserve the reference's distinct empty list-role projections", async () => {
  const f = await fixture();
  const admin = await login(f, f.admin.user, f.admin.password);
  const roleResponse = await call(f, "/fixture/list-role", { method: "POST" });
  const roleId = ((await roleResponse.json()) as { data: number }).data;
  const response = await call(f, "/api/users", {
    method: "POST",
    session: admin,
    body: {
      username: "fixture-list-role",
      email: "fixture-list-role@example.test",
      type: "user",
      status: "enabled",
      user_role_id: 1,
      list_role_id: roleId,
    },
  });
  expect(response.status).toBe(200);
  const created = ((await response.json()) as { data: { id: number; list_role: unknown } }).data;
  expect(created.list_role).toEqual({ id: roleId, name: "Fixture list role", lists: null });
  const detail = await call(f, `/api/users/${created.id}`, { session: admin });
  expect(((await detail.json()) as { data: { list_role: unknown } }).data.list_role).toEqual(
    created.list_role,
  );
  const list = await call(f, "/api/users", { session: admin });
  const users = ((await list.json()) as { data: { id: number; list_role: unknown }[] }).data;
  expect(users.find((entry) => entry.id === created.id)?.list_role).toEqual({
    id: roleId,
    name: "Fixture list role",
    lists: [{ id: 0, name: "", permissions: [] }],
  });
});

test("login limits count attempts by fixture transport peer, ignore forwarded headers and expire without sleeping", async () => {
  const f = await fixture({ ...defaultAuthPolicy, loginAttempts: 2, maxPeers: 2 });
  const attempt = (peer: string, forwarded: string) =>
    call(f, "/admin/login", {
      method: "POST",
      headers: {
        "x-m13-fixture-peer": peer,
        "x-forwarded-for": forwarded,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: undefined,
    });
  expect((await attempt("peer-one", "a")).status).toBe(403);
  expect((await attempt("peer-one", "b")).status).toBe(403);
  expect((await attempt("peer-one", "c")).status).toBe(429);
  expect((await attempt("peer-two", "a")).status).toBe(403);
  expect((await attempt("peer-three", "a")).status).toBe(429);
  await call(f, "/fixture/clock", { method: "POST", body: defaultAuthPolicy.loginWindowMs });
  expect((await attempt("peer-three", "a")).status).toBe(403);
});

test("the default policy permits 20 login posts per peer in a minute", async () => {
  const f = await fixture();
  const attempt = () =>
    call(f, "/admin/login", {
      method: "POST",
      headers: {
        "x-m13-fixture-peer": "peer-default",
        "content-type": "application/x-www-form-urlencoded",
      },
    });
  for (let i = 0; i < 20; i++) expect((await attempt()).status).toBe(403);
  expect((await attempt()).status).toBe(429);
  await call(f, "/fixture/clock", { method: "POST", body: 60_000 });
  expect((await attempt()).status).toBe(403);
});

test("an unexpected first role is not silently granted bootstrap authority", async () => {
  const f = await startUserFixture(defaultAuthPolicy, false);
  fixtures.push(f);
  const role = await call(f, "/fixture/role", {
    method: "POST",
    body: { name: "Unrelated role", permissions: ["users:get"] },
  });
  expect(((await role.json()) as { data: number }).data).toBe(1);
  expect((await call(f, "/fixture/bootstrap", { method: "POST" })).status).toBe(500);
  expect((await call(f, "/health")).status).toBe(200);
  expect((await call(f, "/api/health")).status).toBe(403);
  expect((await call(f, "/fixture/bootstrap", { method: "POST" })).status).toBe(500);
});

test("a TOTP-marked user cannot bypass the deferred second factor or use a human password as an API token", async () => {
  const f = await fixture();
  expect((await call(f, "/fixture/totp-user", { method: "POST" })).status).toBe(200);
  const page = await fetch(`${f.origin}/admin/login`);
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1];
  const cookie = page.headers
    .getSetCookie()
    .find((value) => value.startsWith("nonce="))
    ?.split(";", 1)[0];
  expect(nonce).toBeTruthy();
  expect(cookie).toBeTruthy();
  const response = await fetch(`${f.origin}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie! },
    body: new URLSearchParams({
      username: "fixture-totp",
      password: "fixture-user-password",
      nonce: nonce!,
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("Invalid login or password");
  expect(response.headers.getSetCookie().some((value) => value.startsWith("session="))).toBe(false);
  const header = `Basic ${Buffer.from("fixture-totp:fixture-user-password").toString("base64")}`;
  expect((await call(f, "/api/health", { auth: header })).status).toBe(403);
});

test("TOTP accepts the independent SHA-1 vector and enforces challenge lifetime, attempts and revocation", async () => {
  const f = await fixture({ ...defaultAuthPolicy, loginAttempts: 100 });
  const first = await login(f, f.admin.user, f.admin.password);
  const other = await login(f, f.admin.user, f.admin.password);
  const profile = await call(f, "/api/profile", { session: first });
  const id = ((await profile.json()) as { data: { id: number } }).data.id;
  // RFC 6238 SHA-1 key; these independent codes are for the fixture clock at 2026-01-02T03:04:05Z.
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  expect(
    (
      await call(f, `/api/users/${id}/twofa`, {
        method: "PUT",
        session: first,
        body: { secret, code: "594060" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(f, `/api/users/${id}/twofa`, {
        method: "PUT",
        session: first,
        body: { secret, code: "391022" },
      })
    ).status,
  ).toBe(200);
  expect((await call(f, "/api/profile", { session: other })).status).toBe(403);
  expect((await call(f, "/api/profile", { session: first })).status).toBe(200);
  async function challenge() {
    const page = await fetch(`${f.origin}/admin/login`);
    const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const nonceCookie =
      page.headers
        .getSetCookie()
        .find((v) => v.startsWith("nonce="))
        ?.split(";", 1)[0] ?? "";
    const response = await fetch(`${f.origin}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie },
      body: new URLSearchParams({
        username: f.admin.user,
        password: f.admin.password,
        nonce,
        next: "/api/profile",
      }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.getSetCookie().some((v) => v.startsWith("session="))).toBe(false);
    const location = response.headers.get("location")!;
    expect(location.startsWith("/admin/login/twofa?")).toBe(true);
    return location;
  }
  async function verify(location: string, code: string) {
    const page = await fetch(`${f.origin}${location}`, { redirect: "manual" });
    if (page.status !== 200) return page;
    const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const nonceCookie =
      page.headers
        .getSetCookie()
        .find((v) => v.startsWith("nonce="))
        ?.split(";", 1)[0] ?? "";
    const token = new URL(location, f.origin).searchParams.get("token") ?? "";
    return fetch(`${f.origin}/admin/login/twofa`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie },
      body: new URLSearchParams({ nonce, token, next: "/api/profile", totp_code: code }),
    });
  }
  const guarded = await challenge();
  const guardPage = await fetch(`${f.origin}${guarded}`);
  const guardNonce = /name="nonce"\s+value="([^"]+)"/.exec(await guardPage.text())?.[1] ?? "";
  const guardCookie =
    guardPage.headers
      .getSetCookie()
      .find((v) => v.startsWith("nonce="))
      ?.split(";", 1)[0] ?? "";
  const guardToken = new URL(guarded, f.origin).searchParams.get("token") ?? "";
  async function guardedPost(peer: string, nonce: string, origin?: string) {
    return fetch(`${f.origin}/admin/login/twofa`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: guardCookie,
        "x-m13-fixture-peer": peer,
        ...(origin ? { origin } : {}),
      },
      body: new URLSearchParams({ nonce, token: guardToken, totp_code: "652348" }),
    });
  }
  expect((await guardedPost("origin-peer", guardNonce, "https://foreign.example")).status).toBe(
    403,
  );
  expect((await guardedPost("nonce-peer", "wrong")).status).toBe(403);
  for (let i = 0; i < 100; i++)
    expect((await guardedPost("limited-peer", "wrong")).status).toBe(403);
  expect((await guardedPost("limited-peer", guardNonce)).status).toBe(429);
  expect(
    (await guardedPost("valid-peer", guardNonce)).headers
      .getSetCookie()
      .some((v) => v.startsWith("session=")),
  ).toBe(true);
  const superseded = await challenge();
  const replacement = await challenge();
  expect(
    (await verify(superseded, "652348")).headers
      .getSetCookie()
      .some((v) => v.startsWith("session=")),
  ).toBe(false);
  expect(
    (await verify(replacement, "652348")).headers
      .getSetCookie()
      .some((v) => v.startsWith("session=")),
  ).toBe(true);
  const valid = await challenge();
  const verified = await verify(valid, "751330");
  expect(verified.status).toBe(302);
  expect(verified.headers.get("location")).toBe("/api/profile");
  expect(verified.headers.getSetCookie().some((v) => v.startsWith("session="))).toBe(true);
  expect((await verify(valid, "652348")).status).toBe(302);
  const attempts = await challenge();
  for (let i = 0; i < 5; i++) expect((await verify(attempts, "bad")).status).toBe(200);
  expect((await verify(attempts, "652348")).status).toBe(302);
  const expired = await challenge();
  await call(f, "/fixture/clock", { method: "POST", body: 300_000 });
  expect((await verify(expired, "652348")).status).toBe(302);
  const revoked = await challenge();
  expect(
    (
      await call(f, `/api/users/${id}/twofa`, {
        method: "DELETE",
        session: first,
        body: { password: f.admin.password },
      })
    ).status,
  ).toBe(200);
  expect((await verify(revoked, "652348")).status).toBe(302);
});

test("role permissions are resolved live for retained API tokens and sessions", async () => {
  const f = await fixture({ ...defaultAuthPolicy, loginAttempts: 100 });
  const admin = await login(f, f.admin.user, f.admin.password);
  const createRole = await call(f, "/api/roles/users", {
    method: "POST",
    session: admin,
    body: { name: "Limited role", permissions: ["roles:get", "users:get"] },
  });
  expect(createRole.status).toBe(200);
  const role = ((await createRole.json()) as { data: { id: number } }).data.id;
  const humanName = "m14-limited-human";
  const createHumanResponse = await call(f, "/api/users", {
    method: "POST",
    session: admin,
    body: {
      username: humanName,
      name: humanName,
      email: `${humanName}@example.test`,
      type: "user",
      status: "enabled",
      password_login: true,
      password: "fixture-user-password",
      user_role_id: role,
    },
  });
  expect(createHumanResponse.status).toBe(200);
  const humanId = ((await createHumanResponse.json()) as { data: { id: number } }).data.id;
  const human = await login(f, humanName, "fixture-user-password");
  const createApi = await call(f, "/api/users", {
    method: "POST",
    session: admin,
    body: { username: "m14-limited-api", type: "api", status: "enabled", user_role_id: role },
  });
  expect(createApi.status).toBe(200);
  const api = (
    (await createApi.json()) as { data: { id: number; username: string; password: string } }
  ).data;
  const authorization = `token ${api.username}:${api.password}`;
  for (const auth of [{ session: human }, { auth: authorization }]) {
    expect((await call(f, "/api/roles/users", auth)).status).toBe(200);
    expect((await call(f, "/api/users", auth)).status).toBe(200);
    expect((await call(f, "/api/profile", auth)).status).toBe(200);
    expect((await call(f, "/api/health", auth)).status).toBe(200);
    expect(
      (await call(f, "/api/roles/users", { ...auth, method: "POST", body: { name: "Denied" } }))
        .status,
    ).toBe(403);
    expect((await call(f, "/api/users", { ...auth, method: "POST", body: {} })).status).toBe(403);
  }
  expect((await call(f, `/api/roles/${role}`, { method: "DELETE", session: admin })).status).toBe(
    400,
  );
  expect(
    (
      await call(f, `/api/roles/users/${role}`, {
        method: "PUT",
        session: admin,
        body: { name: "Limited role", permissions: ["roles:manage"] },
      })
    ).status,
  ).toBe(200);
  for (const auth of [{ session: human }, { auth: authorization }]) {
    expect((await call(f, "/api/roles/users", auth)).status).toBe(403);
    expect((await call(f, "/api/users", auth)).status).toBe(403);
    const created = await call(f, "/api/roles/users", {
      ...auth,
      method: "POST",
      body: { name: auth.session ? "session-write" : "api-write", permissions: [] },
    });
    expect(created.status).toBe(200);
  }
  expect(
    (
      await call(f, `/api/roles/users/${role}`, {
        method: "PUT",
        session: admin,
        body: { name: "Limited role", permissions: [] },
      })
    ).status,
  ).toBe(200);
  // After revocation, every ported users/roles permission-protected route denies.
  for (const auth of [{ session: human }, { auth: authorization }]) {
    for (const [method, path] of [
      ["GET", "/api/users"],
      ["GET", `/api/users/${humanId}`],
      ["POST", "/api/users"],
      ["PUT", `/api/users/${humanId}`],
      ["DELETE", `/api/users/${humanId}`],
      ["DELETE", `/api/users?id=${humanId}`],
      ["GET", "/api/roles/users"],
      ["GET", "/api/roles/lists"],
      ["POST", "/api/roles/users"],
      ["POST", "/api/roles/lists"],
      ["PUT", `/api/roles/users/${role}`],
      ["PUT", `/api/roles/lists/${role}`],
      ["DELETE", `/api/roles/${role}`],
    ] as const) {
      expect(
        (
          await call(f, path, {
            ...auth,
            method,
            ...(method === "POST" || method === "PUT" ? { body: {} } : {}),
          })
        ).status,
      ).toBe(403);
    }
  }
  // Both retained identities gain only users:manage on the next request.
  expect(
    (
      await call(f, `/api/roles/users/${role}`, {
        method: "PUT",
        session: admin,
        body: {
          name: "Limited role",
          permissions: [
            "users:manage",
            "sequences:get",
            "sequences:manage",
            "subscriber_events:create",
            "subscriber_events:get",
            "sends:get",
            "sends:manage",
            "webhooks:manage",
          ],
        },
      })
    ).status,
  ).toBe(200);
  for (const [auth, name] of [
    [{ session: human }, "writer-session"],
    [{ auth: authorization }, "writer-token"],
  ] as const) {
    expect((await call(f, "/api/users", auth)).status).toBe(403);
    expect((await call(f, "/api/roles/users", auth)).status).toBe(403);
    const created = await call(f, "/api/users", {
      ...auth,
      method: "POST",
      body: { username: name, type: "api", status: "enabled", user_role_id: role },
    });
    expect(created.status).toBe(200);
    const createdId = ((await created.json()) as { data: { id: number } }).data.id;
    expect(
      (await call(f, `/api/users/${createdId}`, { method: "DELETE", session: admin })).status,
    ).toBe(200);
  }
  for (const method of ["GET", "PUT", "DELETE"] as const) {
    const suffix = method === "GET" ? "/totp" : "";
    expect(
      (
        await call(f, `/api/users/${api.id}/twofa${suffix}`, {
          method,
          session: human,
          ...(method === "GET" ? {} : { body: {} }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(f, `/api/users/${api.id}/twofa${suffix}`, {
          method,
          auth: authorization,
          ...(method === "GET" ? {} : { body: {} }),
        })
      ).status,
    ).toBe(403);
  }
  expect(
    (await call(f, `/api/users/${humanId}`, { method: "DELETE", session: admin })).status,
  ).toBe(200);
  expect((await call(f, `/api/users/${api.id}`, { method: "DELETE", session: admin })).status).toBe(
    200,
  );
  expect((await call(f, `/api/roles/${role}`, { method: "DELETE", session: admin })).status).toBe(
    200,
  );
});

test("list roles project child permissions and roll back invalid replacement and assigned deletion", async () => {
  const f = await fixture();
  const admin = await login(f, f.admin.user, f.admin.password);
  const listResponse = await call(f, "/fixture/list", { method: "POST" });
  const list = ((await listResponse.json()) as { data: number }).data;
  const userRoleResponse = await call(f, "/api/roles/users", {
    method: "POST",
    session: admin,
    body: { name: "No permissions", permissions: [] },
  });
  const userRole = ((await userRoleResponse.json()) as { data: { id: number } }).data.id;
  const roleResponse = await call(f, "/api/roles/lists", {
    method: "POST",
    session: admin,
    body: { name: "Synthetic list role", lists: [{ id: list, permissions: ["list:get"] }] },
  });
  expect(roleResponse.status).toBe(200);
  const role = ((await roleResponse.json()) as { data: { id: number } }).data.id;
  // The child is allocated immediately after its parent in this isolated fixture.
  // A missing ID would return 500, so the 400 response also identifies a real child.
  for (const kind of ["users", "lists"]) {
    expect(
      (
        await call(f, `/api/roles/${kind}/${role + 1}`, {
          method: "PUT",
          session: admin,
          body: { name: "Child target", permissions: [], lists: [] },
        })
      ).status,
    ).toBe(400);
  }
  const createApi = await call(f, "/api/users", {
    method: "POST",
    session: admin,
    body: {
      username: "m14-list-api",
      type: "api",
      status: "enabled",
      user_role_id: userRole,
      list_role_id: role,
    },
  });
  expect(createApi.status).toBe(200);
  const api = (
    (await createApi.json()) as { data: { id: number; username: string; password: string } }
  ).data;
  const authorization = `token ${api.username}:${api.password}`;
  expect(
    (
      (await (
        await call(f, `/fixture/list-permission/${list}`, { auth: authorization })
      ).json()) as { data: boolean }
    ).data,
  ).toBe(true);
  const bad = await call(f, `/api/roles/lists/${role}`, {
    method: "PUT",
    session: admin,
    body: {
      name: "Should roll back",
      lists: [
        { id: list, permissions: ["list:manage"] },
        { id: list + 999, permissions: ["list:get"] },
      ],
    },
  });
  expect(bad.status).toBe(500);
  const duplicate = await call(f, `/api/roles/lists/${role}`, {
    method: "PUT",
    session: admin,
    body: {
      name: "Duplicate child",
      lists: [
        { id: list, permissions: ["list:get"] },
        { id: list, permissions: ["list:manage"] },
      ],
    },
  });
  expect(duplicate.status).toBe(500);
  const roles = (
    (await (await call(f, "/api/roles/lists", { session: admin })).json()) as {
      data: Array<{
        id: number;
        name: string;
        lists: Array<{ id: number; name: string; permissions: string[] }>;
      }>;
    }
  ).data;
  expect(roles.find((entry) => entry.id === role)).toMatchObject({
    name: "Synthetic list role",
    lists: [{ id: list, name: "Synthetic list", permissions: ["list:get"] }],
  });
  expect(
    (
      (await (
        await call(f, `/fixture/list-permission/${list}`, { auth: authorization })
      ).json()) as { data: boolean }
    ).data,
  ).toBe(true);
  for (const variant of ["omitted", "null", "empty"] as const) {
    const restored = await call(f, `/api/roles/lists/${role}`, {
      method: "PUT",
      session: admin,
      body: { name: "Synthetic list role", lists: [{ id: list, permissions: ["list:get"] }] },
    });
    expect(restored.status).toBe(200);
    const permission = async () =>
      (
        (await (
          await call(f, `/fixture/list-permission/${list}`, { auth: authorization })
        ).json()) as { data: boolean }
      ).data;
    expect(await permission()).toBe(true);
    const cleared = await call(f, `/api/roles/lists/${role}`, {
      method: "PUT",
      session: admin,
      body: {
        name: "Synthetic list role",
        lists: [
          {
            id: list,
            ...(variant === "omitted" ? {} : { permissions: variant === "null" ? null : [] }),
          },
        ],
      },
    });
    expect(cleared.status).toBe(200);
    const entries = (
      (await (await call(f, "/api/roles/lists", { session: admin })).json()) as {
        data: { id: number; lists: unknown[] }[];
      }
    ).data;
    expect(entries.find((entry) => entry.id === role)?.lists).toEqual([]);
    expect(await permission()).toBe(false);
  }
  expect((await call(f, `/api/roles/${role}`, { method: "DELETE", session: admin })).status).toBe(
    400,
  );
  expect((await call(f, "/api/profile", { auth: authorization })).status).toBe(200);
  expect((await call(f, `/api/users/${api.id}`, { method: "DELETE", session: admin })).status).toBe(
    200,
  );
  expect((await call(f, `/api/roles/${role}`, { method: "DELETE", session: admin })).status).toBe(
    200,
  );
});

for (const scenario of ["password", "type", "status", "factor"] as const) {
  test(`a factor disable in flight cannot outlive a concurrent ${scenario} change`, async () => {
    const f = await fixture();
    const admin = await login(f, f.admin.user, f.admin.password);
    const { input, user } = await createHuman(f, admin, "m14-race-human");
    const session = await login(f, input.username, input.password);
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(
      (
        await call(f, `/api/users/${user.id}/twofa`, {
          method: "PUT",
          session,
          body: { secret, code: "652348" },
        })
      ).status,
    ).toBe(200);
    const pending = call(f, `/fixture/gated-twofa/${user.id}`, {
      method: "DELETE",
      session,
      body: { password: input.password },
    });
    expect((await call(f, "/fixture/gate-entered")).status).toBe(200);
    if (scenario === "factor") {
      expect(
        (
          await call(f, `/api/users/${user.id}/twofa`, {
            method: "DELETE",
            session,
            body: { password: input.password },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call(f, `/api/users/${user.id}/twofa`, {
            method: "PUT",
            session,
            body: { secret, code: "652348" },
          })
        ).status,
      ).toBe(200);
    } else {
      const changed = await call(f, `/api/users/${user.id}`, {
        method: "PUT",
        session: admin,
        body: {
          ...input,
          password: scenario === "password" ? "new-synthetic-password" : "",
          ...(scenario === "type" ? { type: "api" } : {}),
          ...(scenario === "status" ? { status: "disabled" } : {}),
        },
      });
      expect(changed.status).toBe(200);
      if (scenario === "status") {
        expect(
          (
            await call(f, `/api/users/${user.id}`, {
              method: "PUT",
              session: admin,
              body: { ...input, password: "", status: "enabled" },
            })
          ).status,
        ).toBe(200);
      }
    }
    expect((await call(f, "/fixture/gate-release", { method: "POST" })).status).toBe(200);
    expect((await pending).status).toBe(403);
    const after = await call(f, `/api/users/${user.id}`, { session: admin });
    expect(((await after.json()) as { data: { twofa_type: string } }).data.twofa_type).toBe("totp");
  });
}

test("user creation revalidates a role deleted during password hashing", async () => {
  const f = await fixture();
  const admin = await login(f, f.admin.user, f.admin.password);
  const response = await call(f, "/api/roles/users", {
    method: "POST",
    session: admin,
    body: { name: "Ephemeral", permissions: [] },
  });
  const role = ((await response.json()) as { data: { id: number } }).data.id;
  const pending = call(f, "/fixture/gated-create-user", {
    method: "POST",
    session: admin,
    body: {
      username: "m14-race-new",
      name: "Race",
      email: "m14-race-new@example.test",
      type: "user",
      status: "enabled",
      password_login: true,
      password: "fixture-user-password",
      user_role_id: role,
    },
  });
  expect((await call(f, "/fixture/gate-entered")).status).toBe(200);
  expect((await call(f, `/api/roles/${role}`, { method: "DELETE", session: admin })).status).toBe(
    200,
  );
  expect((await call(f, "/fixture/gate-release", { method: "POST" })).status).toBe(200);
  const created = await pending;
  expect(created.status).toBe(400);
  expect(((await created.json()) as { message: string }).message).toBe("invalid role");
});

test("an unrelated account update does not cancel a password proof", async () => {
  const f = await fixture();
  const admin = await login(f, f.admin.user, f.admin.password);
  const a = await createHuman(f, admin, "independent-a");
  const b = await createHuman(f, admin, "independent-b");
  await call(f, "/fixture/gate-login", { method: "POST" });
  const pending = login(f, a.input.username, a.input.password);
  expect((await call(f, "/fixture/login-entered")).status).toBe(200);
  expect(
    (
      await call(f, `/api/users/${b.user.id}`, {
        method: "PUT",
        session: admin,
        body: { ...b.input, password: "", name: "Changed B" },
      })
    ).status,
  ).toBe(200);
  await call(f, "/fixture/login-release", { method: "POST" });
  const session = await pending;
  expect((await call(f, "/api/profile", { session })).status).toBe(200);
});

test("a password proof cannot survive disabling and restoring the same account", async () => {
  const f = await fixture();
  const admin = await login(f, f.admin.user, f.admin.password);
  const { input, user } = await createHuman(f, admin, "revoked-proof");
  const page = await fetch(`${f.origin}/admin/login`);
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const nonceCookie =
    page.headers
      .getSetCookie()
      .find((v) => v.startsWith("nonce="))
      ?.split(";", 1)[0] ?? "";
  await call(f, "/fixture/gate-login", { method: "POST" });
  const pending = fetch(`${f.origin}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie },
    body: new URLSearchParams({ username: input.username, password: input.password, nonce }),
  });
  expect((await call(f, "/fixture/login-entered")).status).toBe(200);
  for (const status of ["disabled", "enabled"]) {
    expect(
      (
        await call(f, `/api/users/${user.id}`, {
          method: "PUT",
          session: admin,
          body: { ...input, password: "", status },
        })
      ).status,
    ).toBe(200);
  }
  await call(f, "/fixture/login-release", { method: "POST" });
  const rejected = await pending;
  expect(rejected.headers.getSetCookie().some((v) => v.startsWith("session="))).toBe(false);
  const fresh = await login(f, input.username, input.password);
  expect((await call(f, "/api/profile", { session: fresh })).status).toBe(200);
});

test("challenge capacity refuses safely and expiry frees slots", async () => {
  const f = await fixture({
    ...defaultAuthPolicy,
    loginAttempts: 100,
    challengeCapacity: 2,
    challengeTtlMs: 1000,
  });
  const admin = await login(f, f.admin.user, f.admin.password);
  const users = [];
  for (const name of ["capacity-a", "capacity-b", "capacity-c"]) {
    const user = await createHuman(f, admin, name);
    const session = await login(f, name, user.input.password);
    expect(
      (
        await call(f, `/api/users/${user.user.id}/twofa`, {
          method: "PUT",
          session,
          body: { secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", code: "391022" },
        })
      ).status,
    ).toBe(200);
    users.push(user);
  }
  async function attempt(username: string, password = "fixture-user-password") {
    const page = await fetch(`${f.origin}/admin/login`);
    const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const nonceCookie =
      page.headers
        .getSetCookie()
        .find((v) => v.startsWith("nonce="))
        ?.split(";", 1)[0] ?? "";
    return fetch(`${f.origin}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie },
      body: new URLSearchParams({ username, password, nonce }),
    });
  }
  const invalidBefore = await attempt(users[2]!.input.username, "wrong-password");
  expect(invalidBefore.headers.getSetCookie().some((v) => v.startsWith("session="))).toBe(false);
  const first = await attempt(users[0]!.input.username);
  const second = await attempt(users[1]!.input.username);
  expect(first.status).toBe(302);
  expect(second.status).toBe(302);
  const full = await attempt(users[2]!.input.username);
  expect(full.status).toBe(429);
  expect(full.headers.getSetCookie().some((v) => v.startsWith("session="))).toBe(false);
  const wrong = await attempt(users[2]!.input.username, "wrong-password");
  expect(wrong.headers.getSetCookie().some((v) => v.startsWith("session="))).toBe(false);
  expect(
    (await fetch(`${f.origin}${first.headers.get("location")}`, { redirect: "manual" })).status,
  ).toBe(200);
  await call(f, "/fixture/clock", { method: "POST", body: 1000 });
  expect(
    (await fetch(`${f.origin}${first.headers.get("location")}`, { redirect: "manual" })).status,
  ).toBe(302);
  const fresh = await attempt(users[2]!.input.username);
  expect(fresh.status).toBe(302);
  expect(fresh.headers.get("location")).toStartWith("/admin/login/twofa?");
  const location = fresh.headers.get("location")!;
  const page = await fetch(`${f.origin}${location}`);
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const nonceCookie =
    page.headers
      .getSetCookie()
      .find((v) => v.startsWith("nonce="))
      ?.split(";", 1)[0] ?? "";
  const verified = await fetch(`${f.origin}/admin/login/twofa`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie },
    body: new URLSearchParams({
      nonce,
      token: new URL(location, f.origin).searchParams.get("token") ?? "",
      totp_code: "391022",
    }),
  });
  expect(verified.headers.getSetCookie().some((v) => v.startsWith("session="))).toBe(true);
});

test("an unrelated two-factor challenge does not cancel a password proof", async () => {
  const f = await fixture();
  const admin = await login(f, f.admin.user, f.admin.password);
  const a = await createHuman(f, admin, "independent-challenge-a");
  const b = await createHuman(f, admin, "independent-challenge-b");
  const bSession = await login(f, b.input.username, b.input.password);
  expect(
    (
      await call(f, `/api/users/${b.user.id}/twofa`, {
        method: "PUT",
        session: bSession,
        body: { secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", code: "391022" },
      })
    ).status,
  ).toBe(200);
  await call(f, "/fixture/gate-login", { method: "POST" });
  const pending = login(f, a.input.username, a.input.password);
  expect((await call(f, "/fixture/login-entered")).status).toBe(200);
  const page = await fetch(`${f.origin}/admin/login`);
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const nonceCookie =
    page.headers
      .getSetCookie()
      .find((v) => v.startsWith("nonce="))
      ?.split(";", 1)[0] ?? "";
  const challenge = await fetch(`${f.origin}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie },
    body: new URLSearchParams({ username: b.input.username, password: b.input.password, nonce }),
  });
  expect(challenge.headers.get("location")).toStartWith("/admin/login/twofa?");
  expect(challenge.headers.getSetCookie().some((v) => v.startsWith("session="))).toBe(false);
  await call(f, "/fixture/login-release", { method: "POST" });
  const session = await pending;
  expect((await call(f, "/api/profile", { session })).status).toBe(200);
});

for (const scenario of ["password", "type", "delete", "factor"] as const) {
  test(`an in-flight password proof is revoked by ${scenario}`, async () => {
    const f = await fixture();
    const admin = await login(f, f.admin.user, f.admin.password);
    const { input, user } = await createHuman(f, admin, `proof-${scenario}`);
    const self = scenario === "factor" ? await login(f, input.username, input.password) : undefined;
    const page = await fetch(`${f.origin}/admin/login`);
    const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const nonceCookie =
      page.headers
        .getSetCookie()
        .find((v) => v.startsWith("nonce="))
        ?.split(";", 1)[0] ?? "";
    await call(f, "/fixture/gate-login", { method: "POST" });
    const pending = fetch(`${f.origin}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie },
      body: new URLSearchParams({ username: input.username, password: input.password, nonce }),
    });
    expect((await call(f, "/fixture/login-entered")).status).toBe(200);
    if (scenario === "delete") {
      expect(
        (await call(f, `/api/users/${user.id}`, { method: "DELETE", session: admin })).status,
      ).toBe(200);
      const replacement = await createHuman(f, admin, input.username);
      expect(replacement.user.id).toBeGreaterThan(user.id);
    } else if (scenario === "factor") {
      expect(
        (
          await call(f, `/api/users/${user.id}/twofa`, {
            method: "PUT",
            session: self!,
            body: { secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", code: "391022" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call(f, `/api/users/${user.id}/twofa`, {
            method: "DELETE",
            session: self!,
            body: { password: input.password },
          })
        ).status,
      ).toBe(200);
    } else {
      const body =
        scenario === "password"
          ? { ...input, password: "replacement-password" }
          : { ...input, password: "", type: "api" };
      expect(
        (await call(f, `/api/users/${user.id}`, { method: "PUT", session: admin, body })).status,
      ).toBe(200);
      expect(
        (await call(f, `/api/users/${user.id}`, { method: "PUT", session: admin, body: input }))
          .status,
      ).toBe(200);
    }
    await call(f, "/fixture/login-release", { method: "POST" });
    const response = await pending;
    expect(response.headers.getSetCookie().some((v) => v.startsWith("session="))).toBe(false);
    expect(response.headers.get("location")?.startsWith("/admin/login/twofa?") ?? false).toBe(
      false,
    );
  });
}

for (const scenario of ["status", "password", "type", "delete", "factor"] as const) {
  test(`a pending challenge is revoked by ${scenario}`, async () => {
    const f = await fixture();
    const admin = await login(f, f.admin.user, f.admin.password);
    const { input, user } = await createHuman(f, admin, `pending-${scenario}`);
    const self = await login(f, input.username, input.password);
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(
      (
        await call(f, `/api/users/${user.id}/twofa`, {
          method: "PUT",
          session: self,
          body: { secret, code: "391022" },
        })
      ).status,
    ).toBe(200);
    const page = await fetch(`${f.origin}/admin/login`);
    const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const nonceCookie =
      page.headers
        .getSetCookie()
        .find((v) => v.startsWith("nonce="))
        ?.split(";", 1)[0] ?? "";
    const challenged = await fetch(`${f.origin}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie },
      body: new URLSearchParams({ username: input.username, password: input.password, nonce }),
    });
    const location = challenged.headers.get("location") ?? "";
    expect(location).toStartWith("/admin/login/twofa?");
    const form = await fetch(`${f.origin}${location}`);
    const formNonce = /name="nonce"\s+value="([^"]+)"/.exec(await form.text())?.[1] ?? "";
    const formCookie =
      form.headers
        .getSetCookie()
        .find((v) => v.startsWith("nonce="))
        ?.split(";", 1)[0] ?? "";
    if (scenario === "factor") {
      expect(
        (
          await call(f, `/api/users/${user.id}/twofa`, {
            method: "DELETE",
            session: self,
            body: { password: input.password },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call(f, `/api/users/${user.id}/twofa`, {
            method: "PUT",
            session: self,
            body: { secret, code: "391022" },
          })
        ).status,
      ).toBe(200);
    } else if (scenario === "delete") {
      expect(
        (await call(f, `/api/users/${user.id}`, { method: "DELETE", session: admin })).status,
      ).toBe(200);
      expect((await createHuman(f, admin, input.username)).user.id).toBeGreaterThan(user.id);
    } else if (scenario === "status") {
      for (const status of ["disabled", "enabled"])
        expect(
          (
            await call(f, `/api/users/${user.id}`, {
              method: "PUT",
              session: admin,
              body: { ...input, password: "", status },
            })
          ).status,
        ).toBe(200);
    } else if (scenario === "type") {
      expect(
        (
          await call(f, `/api/users/${user.id}`, {
            method: "PUT",
            session: admin,
            body: { ...input, password: "", type: "api" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call(f, `/api/users/${user.id}`, {
            method: "PUT",
            session: admin,
            body: { ...input, password: input.password },
          })
        ).status,
      ).toBe(200);
    } else {
      expect(
        (
          await call(f, `/api/users/${user.id}`, {
            method: "PUT",
            session: admin,
            body: { ...input, password: "replacement-password" },
          })
        ).status,
      ).toBe(200);
      expect(
        (await call(f, `/api/users/${user.id}`, { method: "PUT", session: admin, body: input }))
          .status,
      ).toBe(200);
    }
    const rejected = await fetch(`${f.origin}/admin/login/twofa`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: formCookie },
      body: new URLSearchParams({
        nonce: formNonce,
        token: new URL(location, f.origin).searchParams.get("token") ?? "",
        totp_code: "391022",
      }),
    });
    expect(rejected.status).toBe(302);
    expect(rejected.headers.getSetCookie().some((v) => v.startsWith("session="))).toBe(false);
  });
}
