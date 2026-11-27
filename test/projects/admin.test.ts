// B140 (14-projects sections 5, 6 and 15 "Admin"; D153): one admin account in instance.db, copied into
// every project. The compiled executable serves a primary project on the instance host (127.0.0.1)
// and projects `a` and `b` on their own hostnames. The tests share one process and run in order: each
// password change carries into the next test, as one operator's day would.
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { must } from "@/invariant";
import { openDatabase } from "@/db/connection";
import { createListReferences } from "@/lists/references";
import { createRoles } from "@/roles/roles";
import { hashPassword } from "@/users/password";
import { createUserStore } from "@/users/store";
import { handoff, instanceCall, instanceLogin, setCookies } from "@/test/projects/admin-fixture";
import type { InstanceSession } from "@/test/projects/admin-fixture";
import {
  adminCredentials,
  api,
  createApiUser,
  logIn,
  prepareExecutable,
  registerProjects,
  request,
  sessionHeaders,
  startInstance,
} from "@/test/projects/fixture";
import type { Credentials, Session } from "@/test/projects/fixture";
import { totp } from "@/test/e2e/totp";
import { readJson } from "@/test/read-body";
import { startSink } from "@/test/tx/sink";
import { untilState } from "@/test/wait";

setDefaultTimeout(30_000);

const PRIMARY = "127.0.0.1";
const A = "a.example.test";
const B = "b.example.test";

let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
let server: Awaited<ReturnType<typeof startInstance>> | undefined;
let sink: Awaited<ReturnType<typeof startSink>>;
let dataDir = "";
let port = 0;
/** The admin's name and current password: tests change it as they go. */
let admin: Credentials;
/** The environment's admin, which starts the process; never changes. */
let environment: Credentials;
/** One instance session for the tests that only read with it. */
let shared: InstanceSession;
/**
 * The client address of the running test's instance logins (B155a). The instance login allows 20
 * attempts a minute from one address, as a project's does; with loopback trusted as a proxy each
 * test sends its own `X-Forwarded-For`, so no test's logins count against another's.
 */
let peer = "";
let peers = 0;
beforeEach(() => {
  peers++;
  peer = `203.0.113.${peers}`;
});
/** The instance login on the instance host, from the running test's own address. */
const signIn = (credentials: Credentials, options: { next?: string; secret?: string } = {}) =>
  instanceLogin(port, PRIMARY, credentials, { ...options, peer });

interface UserBody {
  id: number;
  username: string;
  status: string;
  type: string;
  user_role: { id: number };
}

const users = async (host: string, session: Session) =>
  (
    await readJson<{ data: Array<UserBody> }>(
      await request(port, host, "/api/users", { headers: sessionHeaders(session) }),
    )
  ).data;

/** The project login, one attempt: where it sends the browser, or "" when it refused. */
async function projectLogin(host: string, credentials: Credentials): Promise<string> {
  const page = await request(port, host, "/admin/login");
  const nonceCookie = page.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  const nonce = /name="nonce" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const response = await request(port, host, "/admin/login", {
    method: "POST",
    headers: { cookie: nonceCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      nonce,
      username: credentials.user,
      password: credentials.password,
      next: "/admin",
    }).toString(),
  });
  return response.status === 302 ? (response.headers.get("location") ?? "") : "";
}

/** A cookie's attributes as a response set it, without its value. */
function attributes(response: Response, name: string): Array<string> | undefined {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`))
    ?.split(";")
    .slice(1)
    .map((part) => part.trim());
}

async function start() {
  server = await startInstance(prepared.executable, dataDir, environment);
  port = server.port;
}

beforeAll(async () => {
  environment = await adminCredentials();
  admin = environment;
  prepared = await prepareExecutable();
  sink = await startSink();
  dataDir = join(prepared.directory, "data");
  registerProjects(dataDir, [
    { slug: "main", name: "Main", hostname: PRIMARY, primary: true },
    { slug: "a", name: "A", hostname: A },
    { slug: "b", name: "B", hostname: B },
  ]);
  await start();
  // Loopback is the trusted proxy, so each test's X-Forwarded-For is its login address (B155a).
  const setup = must(
    (await instanceLogin(port, PRIMARY, environment, { peer: "203.0.113.250" })).session,
    "the setup's instance session",
  );
  const trusted = await instanceCall(
    port,
    PRIMARY,
    setup,
    "PUT",
    "/api/instance/settings/security.trusted_proxies",
    ["127.0.0.1"],
  );
  expect(trusted.status).toBe(200);
});

afterAll(async () => {
  await server?.stop();
  await sink?.close();
  await prepared?.cleanup();
});

test("the instance login checks instance.db: a wrong password or name is refused", async () => {
  for (const credentials of [
    { user: admin.user, password: "not-the-password" },
    { user: "someone-else", password: admin.password },
  ]) {
    const refused = await signIn(credentials);
    expect(refused.response.status).toBe(200);
    expect(refused.body).toContain("Invalid login or password");
    expect(refused.session).toBeUndefined();
  }
  const signedIn = await signIn(admin);
  expect(signedIn.response.status).toBe(302);
  expect(signedIn.response.headers.get("location")).toBe("/admin/instance/projects");
  const page = await request(port, PRIMARY, "/admin/instance/account", {
    headers: { cookie: signedIn.session!.cookie },
  });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(await page.text()).toContain(`@${admin.user}`);
  // Without the session, the page sends the browser to the login, which comes back to it.
  const anonymous = await request(port, PRIMARY, "/admin/instance/account");
  expect(anonymous.status).toBe(307);
  expect(anonymous.headers.get("location")).toBe(
    "/admin/instance/login?next=%2Fadmin%2Finstance%2Faccount",
  );
  // A safe `next` is where the login goes.
  const next = await signIn(admin, { next: "/admin/instance/open/a" });
  expect(next.response.headers.get("location")).toBe("/admin/instance/open/a");
  const foreign = await signIn(admin, { next: "//evil.example/" });
  expect(foreign.response.headers.get("location")).toBe("/admin/instance/projects");
});

test("instance_session has the project session's attributes, and both live on the instance host", async () => {
  const instance = (await signIn(admin)).response;
  const project = await (async () => {
    const page = await request(port, PRIMARY, "/admin/login");
    const nonceCookie = page.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const nonce = /name="nonce" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    return request(port, PRIMARY, "/admin/login", {
      method: "POST",
      headers: { cookie: nonceCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        nonce,
        username: admin.user,
        password: admin.password,
        next: "/admin",
      }).toString(),
    });
  })();
  expect(attributes(instance, "instance_session")).toEqual(attributes(project, "session"));
  expect(attributes(instance, "instance_csrf")).toEqual(attributes(project, "csrf"));
  expect(attributes(instance, "instance_session")).toContain("Path=/");

  const both = new Map([...setCookies(instance), ...setCookies(project)]);
  const cookie = [...both].map(([name, value]) => `${name}=${value}`).join("; ");
  const projectSession: Session = { cookie, csrf: both.get("csrf") ?? "" };
  const instanceSession: InstanceSession = { cookie, csrf: both.get("instance_csrf") ?? "" };
  expect((await request(port, PRIMARY, "/api/profile", { headers: { cookie } })).status).toBe(200);
  const account = await instanceCall(
    port,
    PRIMARY,
    instanceSession,
    "GET",
    "/api/instance/account",
  );
  expect(account.status).toBe(200);
  expect((await readJson<{ data: { username: string } }>(account)).data.username).toBe(admin.user);
  // A state change needs the instance CSRF token, not the project's.
  const wrongToken = await instanceCall(
    port,
    PRIMARY,
    { cookie, csrf: projectSession.csrf },
    "POST",
    "/api/instance/logout",
  );
  expect(wrongToken.status).toBe(403);
  // Logging out of the instance leaves the project session as it was.
  const logout = await instanceCall(port, PRIMARY, instanceSession, "POST", "/api/instance/logout");
  expect(logout.status).toBe(200);
  expect(setCookies(logout).get("instance_session")).toBe("");
  expect(
    (await instanceCall(port, PRIMARY, instanceSession, "GET", "/api/instance/account")).status,
  ).toBe(401);
  expect(
    (await request(port, PRIMARY, "/api/profile", { headers: sessionHeaders(projectSession) }))
      .status,
  ).toBe(200);
});

test("instance routes never accept API credentials, and belong to the project on its own host", async () => {
  const session = await logIn(port, PRIMARY, admin);
  const key = await createApiUser(port, PRIMARY, session, "primary-key");
  shared = (await signIn(admin)).session!;
  const instance = shared;
  for (const [method, path] of [
    ["GET", "/api/instance/account"],
    ["PUT", "/api/instance/account/password"],
    ["GET", "/admin/instance/account"],
    ["GET", "/admin/instance/open/a"],
  ] as const) {
    // With a valid instance session beside it, a credential is still refused.
    const response = await request(port, PRIMARY, path, {
      method,
      headers: { authorization: key, cookie: instance.cookie, "x-csrf-token": instance.csrf },
    });
    expect(response.status).toBe(401);
  }
  // On a project's host these paths are the project's: its unknown endpoint and its login.
  const api = await request(port, A, "/api/instance/account", {
    headers: { cookie: instance.cookie },
  });
  expect(api.status).toBe(404);
  const page = await request(port, A, "/admin/instance/login");
  expect(page.status).toBe(307);
  expect(page.headers.get("location")).toStartWith("/admin/login?");
});

test("the handoff signs the admin into a project once; spent, foreign and unknown tokens are 403", async () => {
  const instance = shared;
  const first = await handoff(port, PRIMARY, instance, "a", "/admin/lists");
  expect(first.open.status).toBe(303);
  expect(first.target.origin).toBe(`http://${A}`);
  expect(first.target.pathname).toBe("/admin/handoff");
  expect(first.target.searchParams.get("next")).toBe("/admin/lists");
  expect(first.target.searchParams.get("token")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(first.redeemed.status).toBe(303);
  expect(first.redeemed.headers.get("location")).toBe("/admin/lists");
  const profile = await request(port, A, "/api/profile", {
    headers: sessionHeaders(first.project!),
  });
  expect(profile.status).toBe(200);
  expect((await readJson<{ data: { username: string } }>(profile)).data.username).toBe(admin.user);

  // Spent: the same token again.
  const again = await request(port, A, first.target.pathname + first.target.search);
  expect(again.status).toBe(403);
  expect(setCookies(again).has("session")).toBe(false);
  // Foreign: a token for `a` presented to `b`.
  const open = await request(port, PRIMARY, "/admin/instance/open/a", {
    headers: { cookie: instance.cookie },
  });
  const target = new URL(open.headers.get("location")!);
  const foreign = await request(port, B, target.pathname + target.search);
  expect(foreign.status).toBe(403);
  expect(setCookies(foreign).has("session")).toBe(false);
  // Unknown and malformed tokens.
  for (const token of ["A".repeat(43), "short", ""]) {
    const unknown = await request(port, A, `/admin/handoff?token=${token}&next=/admin`);
    expect(unknown.status).toBe(403);
    expect(setCookies(unknown).has("session")).toBe(false);
  }
  // An unknown slug, and no instance session.
  const missing = await request(port, PRIMARY, "/admin/instance/open/nope", {
    headers: { cookie: instance.cookie },
  });
  expect(missing.status).toBe(404);
  const anonymous = await request(port, PRIMARY, "/admin/instance/open/a");
  expect(anonymous.status).toBe(307);
  expect(anonymous.headers.get("location")).toStartWith("/admin/instance/login?next=");
  // The primary project is reached through the same handoff, on the instance host.
  const primary = await handoff(port, PRIMARY, instance, "main");
  expect(primary.target.host).toBe(PRIMARY);
  expect(primary.redeemed.status).toBe(303);
});

test("next must be a local path: open-redirect attempts all land on /admin", async () => {
  const instance = shared;
  const attempts = [
    "//evil.example/",
    String.raw`/\evil.example/`,
    String.raw`\\evil.example/`,
    "http://evil.example/",
    "https://evil.example/admin",
    "evil.example",
    "/%2F%2Fevil.example/",
    "/%2f/evil.example",
    "/%5Cevil.example",
    "/%09/evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "javascript:alert(1)",
  ];
  for (const next of attempts) {
    const followed = await handoff(port, PRIMARY, instance, "a", next);
    expect(followed.target.searchParams.get("next")).toBe("/admin");
    expect(followed.redeemed.headers.get("location")).toBe("/admin");
  }
  // The project checks `next` again: a token presented with a foreign `next` still lands on /admin.
  for (const next of ["//evil.example/", "/%2F%2Fevil.example", "https://evil.example/"]) {
    const open = await request(port, PRIMARY, "/admin/instance/open/a", {
      headers: { cookie: instance.cookie },
    });
    const token = new URL(open.headers.get("location")!).searchParams.get("token")!;
    const redeemed = await request(
      port,
      A,
      `/admin/handoff?${new URLSearchParams({ token, next })}`,
    );
    expect(redeemed.status).toBe(303);
    expect(redeemed.headers.get("location")).toBe("/admin");
  }
});

test("the admin's credentials log in on every project host, as a normal user row", async () => {
  for (const host of [PRIMARY, A, B, "unclaimed.example.test"]) {
    expect(await projectLogin(host, admin)).toBe("/admin");
  }
});

test("the copy cannot be deleted, disabled, renamed or have its role or password login changed", async () => {
  const session = await logIn(port, A, admin);
  const headers = sessionHeaders(session);
  // A second human Super Admin, so the last-admin rule is not what answers.
  const second = await readJson<{ data: UserBody }>(
    await request(port, A, "/api/users", {
      method: "POST",
      headers,
      body: JSON.stringify({
        username: "second-admin",
        email: "second-admin@a.example.test",
        name: "Second",
        type: "user",
        status: "enabled",
        password_login: true,
        password: "second-admin-password",
        user_role_id: 1,
      }),
    }),
  );
  const role = await readJson<{ data: { id: number } }>(
    await request(port, A, "/api/roles/users", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "viewer", permissions: ["lists:get_all"] }),
    }),
  );
  const viewer = await readJson<{ data: UserBody }>(
    await request(port, A, "/api/users", {
      method: "POST",
      headers,
      body: JSON.stringify({
        username: "viewer-of-a",
        email: "viewer@a.example.test",
        type: "user",
        status: "enabled",
        user_role_id: role.data.id,
      }),
    }),
  );
  const listed = await users(A, session);
  const copy = listed.find((user) => user.username === admin.user)!;
  expect(copy.user_role.id).toBe(1);
  expect((await request(port, A, `/api/users/${copy.id}`, { headers })).status).toBe(200);
  const base = {
    username: admin.user,
    name: admin.user,
    email: "initial-admin@localhost.invalid",
    type: "user",
    status: "enabled",
    password_login: true,
    user_role_id: 1,
  };
  for (const change of [
    { status: "disabled" },
    { username: "renamed-admin" },
    { user_role_id: role.data.id },
    { password_login: false },
    { type: "api" },
  ]) {
    const response = await request(port, A, `/api/users/${copy.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...base, ...change }),
    });
    expect(response.status).toBe(403);
  }
  for (const path of [`/api/users/${copy.id}`, `/api/users?id=${copy.id}&id=${viewer.data.id}`]) {
    expect((await request(port, A, path, { method: "DELETE", headers })).status).toBe(403);
  }
  // Nothing was written, and the bulk delete took nobody either.
  const after = await users(A, session);
  const unchanged = after.find((user) => user.id === copy.id)!;
  expect(unchanged).toMatchObject({
    username: admin.user,
    status: "enabled",
    type: "user",
    user_role: { id: 1 },
  });
  expect(after.some((user) => user.id === second.data.id)).toBe(true);
  expect(after.some((user) => user.id === viewer.data.id)).toBe(true);
  // Its own session still works; changing its name, a field of its own, is allowed.
  const renamedDisplay = await request(port, A, `/api/users/${copy.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...base, name: "The Admin" }),
  });
  expect(renamedDisplay.status).toBe(200);
});

test("only the copy itself changes its password or email: another Super Admin or an API user gets 403", async () => {
  const session = await logIn(port, A, admin);
  const headers = sessionHeaders(session);
  const token = await createApiUser(port, A, session, "automation-a");
  const other: Credentials = { user: "other-admin-of-a", password: "other-admin-password" };
  const created = await request(port, A, "/api/users", {
    method: "POST",
    headers,
    body: JSON.stringify({
      username: other.user,
      email: "other-admin@a.example.test",
      name: other.user,
      type: "user",
      status: "enabled",
      password_login: true,
      password: other.password,
      user_role_id: 1,
    }),
  });
  expect(created.status).toBe(200);
  const otherSession = await logIn(port, A, other);
  const copy = (await users(A, session)).find((user) => user.username === admin.user)!;
  const base = {
    username: admin.user,
    name: "The Admin",
    email: "initial-admin@localhost.invalid",
    type: "user",
    status: "enabled",
    password_login: true,
    user_role_id: 1,
  };
  const changes = [{ password: "attacker-chosen-pw" }, { email: "attacker@a.example.test" }];
  for (const change of changes) {
    const byToken = await api(port, A, token, "PUT", `/api/users/${copy.id}`, {
      ...base,
      ...change,
    });
    expect(byToken.status).toBe(403);
    const bySession = await request(port, A, `/api/users/${copy.id}`, {
      method: "PUT",
      headers: sessionHeaders(otherSession),
      body: JSON.stringify({ ...base, ...change }),
    });
    expect(bySession.status).toBe(403);
  }
  // Another field of the copy is still theirs to edit, as for any user.
  const named = await api(port, A, token, "PUT", `/api/users/${copy.id}`, base);
  expect(named.status).toBe(200);
  // Nothing was written: the email stands, the old password works everywhere, the new one nowhere.
  const viewed = await readJson<{ data: { email: string } }>(
    await request(port, A, `/api/users/${copy.id}`, { headers }),
  );
  expect(viewed.data.email).toBe("initial-admin@localhost.invalid");
  const attacker = { user: admin.user, password: "attacker-chosen-pw" };
  for (const host of [PRIMARY, A, B]) {
    expect(await projectLogin(host, admin)).toBe("/admin");
    expect(await projectLogin(host, attacker)).toBe("");
  }
  expect((await signIn(admin)).session).toBeDefined();
  expect((await signIn(attacker)).session).toBeUndefined();
});

test("a name-only edit of the copy by another user works when the admin stored a mixed-case email (B149d)", async () => {
  const session = await logIn(port, A, admin);
  const copy = (await users(A, session)).find((user) => user.username === admin.user)!;
  const own = await request(port, A, "/api/profile", {
    method: "PUT",
    headers: sessionHeaders(session),
    body: JSON.stringify({ name: "The Admin", email: "Initial-Admin@Localhost.Invalid" }),
  });
  expect(own.status).toBe(200);
  const other = await logIn(port, A, {
    user: "other-admin-of-a",
    password: "other-admin-password",
  });
  const base = {
    username: admin.user,
    type: "user",
    status: "enabled",
    password_login: true,
    user_role_id: 1,
  };
  // The admin UI sends the email it read back; another client may send it lowercased.
  for (const [name, email] of [
    ["Renamed Once", "Initial-Admin@Localhost.Invalid"],
    ["Renamed Twice", "initial-admin@localhost.invalid"],
  ]) {
    const renamed = await request(port, A, `/api/users/${copy.id}`, {
      method: "PUT",
      headers: sessionHeaders(other),
      body: JSON.stringify({ ...base, name, email }),
    });
    expect(renamed.status).toBe(200);
    const viewed = await readJson<{ data: { name: string; email: string } }>(
      await request(port, A, `/api/users/${copy.id}`, { headers: sessionHeaders(session) }),
    );
    // Another user never rewrites the copy's email, not even its case.
    expect(viewed.data).toMatchObject({ name, email: "Initial-Admin@Localhost.Invalid" });
  }
  // A different address is still the copy's own to set.
  const changed = await request(port, A, `/api/users/${copy.id}`, {
    method: "PUT",
    headers: sessionHeaders(other),
    body: JSON.stringify({ ...base, name: "The Admin", email: "someone-else@a.example.test" }),
  });
  expect(changed.status).toBe(403);
  const restored = await request(port, A, "/api/profile", {
    method: "PUT",
    headers: sessionHeaders(session),
    body: JSON.stringify({ name: "The Admin", email: "initial-admin@localhost.invalid" }),
  });
  expect(restored.status).toBe(200);
});

test("the admin's own PUT /api/users/<own id> changes its password everywhere (B149d)", async () => {
  const onA = await logIn(port, A, admin);
  const copy = (await users(A, onA)).find((user) => user.username === admin.user)!;
  const next = { user: admin.user, password: "self-edit-password-1" };
  const edited = await request(port, A, `/api/users/${copy.id}`, {
    method: "PUT",
    headers: sessionHeaders(onA),
    body: JSON.stringify({
      username: admin.user,
      name: "The Admin",
      email: "self-edit@a.example.test",
      type: "user",
      status: "enabled",
      password_login: true,
      password: next.password,
      user_role_id: 1,
      // D201: the copy proves its current password to change its credentials.
      current_password: admin.password,
    }),
  });
  expect(edited.status).toBe(200);
  const old = admin;
  admin = next;
  // Each test signs in from its own client address (B155a), so the old password's refusal is
  // checked on the instance too.
  expect((await signIn(admin)).session).toBeDefined();
  expect((await signIn(old)).session).toBeUndefined();
  expect(await projectLogin(B, admin)).toBe("/admin");
  expect(await projectLogin(B, old)).toBe("");
  const onANow = await logIn(port, A, admin);
  const restored = await request(port, A, "/api/profile", {
    method: "PUT",
    headers: sessionHeaders(onANow),
    body: JSON.stringify({
      name: "The Admin",
      email: "initial-admin@localhost.invalid",
      current_password: admin.password,
    }),
  });
  expect(restored.status).toBe(200);
});

test("the admin's username is reserved in every project: 409, nothing written", async () => {
  const session = await logIn(port, B, admin);
  const headers = sessionHeaders(session);
  const taken = await request(port, B, "/api/users", {
    method: "POST",
    headers,
    body: JSON.stringify({
      username: admin.user,
      email: "imposter@b.example.test",
      type: "user",
      status: "enabled",
      user_role_id: 1,
    }),
  });
  expect(taken.status).toBe(409);
  const carol = await readJson<{ data: UserBody }>(
    await request(port, B, "/api/users", {
      method: "POST",
      headers,
      body: JSON.stringify({
        username: "carol",
        email: "carol@b.example.test",
        type: "user",
        status: "enabled",
        user_role_id: 1,
      }),
    }),
  );
  const renamed = await request(port, B, `/api/users/${carol.data.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      username: admin.user,
      name: "carol",
      email: "carol@b.example.test",
      type: "user",
      status: "enabled",
      user_role_id: 1,
    }),
  });
  expect(renamed.status).toBe(409);
  const after = await users(B, session);
  expect(after.filter((user) => user.username === admin.user)).toHaveLength(1);
  expect(after.find((user) => user.id === carol.data.id)?.username).toBe("carol");
  expect(after.some((user) => user.username === "imposter")).toBe(false);
});

test("a password change on the instance Account page reaches every project", async () => {
  const instance = (await signIn(admin)).session!;
  const other = (await signIn(admin)).session!;
  const onA = await logIn(port, A, admin);
  const wrong = await instanceCall(
    port,
    PRIMARY,
    instance,
    "PUT",
    "/api/instance/account/password",
    {
      current: "not-the-password",
      password: "instance-password-1",
    },
  );
  expect(wrong.status).toBe(403);
  const changed = await instanceCall(
    port,
    PRIMARY,
    instance,
    "PUT",
    "/api/instance/account/password",
    { current: admin.password, password: "instance-password-1" },
  );
  expect(changed.status).toBe(200);
  const before = admin;
  admin = { user: admin.user, password: "instance-password-1" };
  for (const host of [PRIMARY, A, B]) {
    expect(await projectLogin(host, admin)).toBe("/admin");
    expect(await projectLogin(host, before)).toBe("");
  }
  // Each copy's sessions end, as a reset's do; the instance keeps only the session that changed it.
  expect((await request(port, A, "/api/profile", { headers: sessionHeaders(onA) })).status).toBe(
    403,
  );
  expect((await instanceCall(port, PRIMARY, instance, "GET", "/api/instance/account")).status).toBe(
    200,
  );
  expect((await instanceCall(port, PRIMARY, other, "GET", "/api/instance/account")).status).toBe(
    401,
  );
});

test("a password change from a project's profile reaches the instance and the other projects", async () => {
  const onB = await logIn(port, B, admin);
  const onA = await logIn(port, A, admin);
  const instance = (await signIn(admin)).session!;
  const profile = await request(port, B, "/api/profile", {
    method: "PUT",
    headers: sessionHeaders(onB),
    body: JSON.stringify({
      name: admin.user,
      email: "initial-admin@localhost.invalid",
      password: "profile-password-2",
      current_password: admin.password,
    }),
  });
  expect(profile.status).toBe(200);
  admin = { user: admin.user, password: "profile-password-2" };
  expect((await signIn(admin)).session).toBeDefined();
  for (const host of [PRIMARY, A, B]) {
    expect(await projectLogin(host, admin)).toBe("/admin");
  }
  // B keeps the session that changed it, as today; A's and the instance's end.
  expect((await request(port, B, "/api/profile", { headers: sessionHeaders(onB) })).status).toBe(
    200,
  );
  expect((await request(port, A, "/api/profile", { headers: sessionHeaders(onA) })).status).toBe(
    403,
  );
  expect((await instanceCall(port, PRIMARY, instance, "GET", "/api/instance/account")).status).toBe(
    401,
  );
});

test("a password reset by email in one project reaches the instance and the other projects", async () => {
  // B139 (D154): SMTP is an instance key, set once with the instance session for every project.
  const operator = (await signIn(admin)).session!;
  const settings = await readJson<{ data: Record<string, unknown> }>(
    await instanceCall(port, PRIMARY, operator, "GET", "/api/instance/settings"),
  );
  const smtp = {
    enabled: true,
    host: "127.0.0.1",
    port: sink.port,
    auth_protocol: "none",
    username: "",
    password: "",
    tls_type: "none",
    tls_skip_verify: false,
    max_conns: 2,
    max_msg_retries: 0,
    msg_retry_delay: "10ms",
    idle_timeout: "15s",
    wait_timeout: "5s",
    hello_hostname: "",
    name: "",
    from_addresses: [],
    email_headers: [],
    exclude_from_default: false,
  };
  const saved = await instanceCall(port, PRIMARY, operator, "PUT", "/api/instance/settings", {
    ...settings.data,
    smtp: [smtp],
  });
  expect(saved.status).toBe(200);
  // The copy's email is the project's own field.
  const mailbox = "admin-of-a@example.test";
  const fresh = await logIn(port, A, admin);
  const email = await request(port, A, "/api/profile", {
    method: "PUT",
    headers: sessionHeaders(fresh),
    body: JSON.stringify({
      name: admin.user,
      email: mailbox,
      password: "",
      current_password: admin.password,
    }),
  });
  expect(email.status).toBe(200);
  const forgot = await request(port, A, "/admin/forgot", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: mailbox }).toString(),
  });
  expect(forgot.status).toBe(200);
  await untilState(() => sink.messages.some((message) => message.to.includes(mailbox)), {
    label: "the reset mail from project a",
    progress: () => String(sink.messages.length),
    stallMs: 15_000,
  });
  const mail = sink.messages.find((message) => message.to.includes(mailbox))!.data;
  const link = new URL(
    /http:\/\/a\.example\.test\/admin\/reset\?[^\s"<>]+/
      .exec(mail.replaceAll("=\r\n", "").replaceAll("=3D", "="))![0]
      .replaceAll("&amp;", "&"),
  );
  const reset = await request(port, A, link.pathname + link.search, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      password: "reset-password-3",
      password2: "reset-password-3",
    }).toString(),
  });
  expect(reset.status).toBe(302);
  admin = { user: admin.user, password: "reset-password-3" };
  const signedIn = await signIn(admin);
  expect(signedIn.session).toBeDefined();
  shared = signedIn.session!;
  for (const host of [PRIMARY, B]) {
    expect(await projectLogin(host, admin)).toBe("/admin");
  }
});

test("TOTP enabled on the instance reaches every project; disabled in a project, it leaves them all", async () => {
  const instance = shared;
  const provision = await instanceCall(
    port,
    PRIMARY,
    instance,
    "GET",
    "/api/instance/account/totp",
  );
  expect(provision.status).toBe(200);
  const { secret, qr } = (await readJson<{ data: { secret: string; qr: string } }>(provision)).data;
  expect(qr.length).toBeGreaterThan(0);
  const bad = await instanceCall(port, PRIMARY, instance, "PUT", "/api/instance/account/twofa", {
    secret,
    code: "000000" === totp(secret) ? "111111" : "000000",
  });
  expect(bad.status).toBe(400);
  const enabled = await instanceCall(
    port,
    PRIMARY,
    instance,
    "PUT",
    "/api/instance/account/twofa",
    {
      secret,
      code: totp(secret),
    },
  );
  expect(enabled.status).toBe(200);
  // Every project's login now asks for the second factor, and so does the instance's.
  for (const host of [PRIMARY, A, B]) {
    expect(await projectLogin(host, admin)).toStartWith("/admin/login/twofa?");
  }
  const challenged = await signIn(admin);
  expect(challenged.response.headers.get("location")).toStartWith("/admin/instance/login/twofa?");
  expect(challenged.session).toBeUndefined();
  const withCode = await signIn(admin, { secret });
  expect(withCode.session).toBeDefined();

  // Disabled from b's profile with the handoff's session.
  const onB = (await handoff(port, PRIMARY, withCode.session!, "b")).project!;
  const listed = await users(B, onB);
  const copy = listed.find((user) => user.username === admin.user)!;
  const disabled = await request(port, B, `/api/users/${copy.id}/twofa`, {
    method: "DELETE",
    headers: sessionHeaders(onB),
    body: JSON.stringify({ password: admin.password }),
  });
  expect(disabled.status).toBe(200);
  for (const host of [PRIMARY, A, B]) {
    expect(await projectLogin(host, admin)).toBe("/admin");
  }
  expect((await signIn(admin)).response.headers.get("location")).toBe("/admin/instance/projects");
});

test("the CLI resets the admin in the instance and every project; a restart repairs a stale copy", async () => {
  await server!.stop();
  server = undefined;
  const run = async (args: Array<string>, stdin = "") => {
    const child = Bun.spawn([prepared.executable, ...args, "--data-dir", dataDir], {
      env: { PATH: "" },
      stdin: Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  const reset = await run(["reset-password", "--user", admin.user], "cli-password-4\n");
  expect(reset.stderr).toBe("");
  expect(reset.code).toBe(0);
  const totpReset = await run(["reset-totp", "--user", admin.user]);
  expect(totpReset.code).toBe(0);
  expect(totpReset.stdout).toContain("nothing to turn off");
  admin = { user: admin.user, password: "cli-password-4" };

  // A crash between the instance write and b's copy, made by hand through b's own store.
  const db = openDatabase(join(dataDir, "projects", "b"));
  const lists = createListReferences(db);
  const roles = createRoles(db, lists);
  const store = createUserStore(db, createRealClock(), roles);
  try {
    const copy = store.copy()!;
    expect(store.setPassword(copy.id, await hashPassword("stale-password-5"))).not.toBeNull();
  } finally {
    store.close();
    roles.close();
    lists.close();
    db.close();
  }

  await start();
  for (const host of [PRIMARY, A, B]) {
    expect(await projectLogin(host, admin)).toBe("/admin");
  }
  expect(await projectLogin(B, { user: admin.user, password: "stale-password-5" })).toBe("");
  expect((await signIn(admin)).session).toBeDefined();
});

test("the instance login has the project login's attempt limit", async () => {
  // Its own process and data directory, so no other test's attempts count.
  const own = join(prepared.directory, "limits");
  registerProjects(own, [{ slug: "main", name: "Main", hostname: PRIMARY, primary: true }]);
  const limited = await startInstance(prepared.executable, own, environment);
  try {
    const statuses: Array<number> = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      const refused = await instanceLogin(limited.port, PRIMARY, {
        user: environment.user,
        password: `wrong-password-${attempt}`,
      });
      statuses.push(refused.response.status);
    }
    expect(statuses).toEqual(Array(20).fill(200));
    // Locked out for the window, the right password included.
    const locked = await instanceLogin(limited.port, PRIMARY, environment);
    expect(locked.response.status).toBe(429);
    expect(locked.session).toBeUndefined();
  } finally {
    await limited.stop();
  }
});
