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
