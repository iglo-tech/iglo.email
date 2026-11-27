// B172 (D200; 14-projects sections 2 and 5): no project-authored content runs script in the origin
// where the instance credentials are typed and sent. The compiled executable serves a primary
// project on the instance host (127.0.0.1) with an extra hostname, and project `b` on its own host.
// The primary's public custom JS is set through its own API, as any primary-project user with
// `settings:manage` could set it; it never reaches the instance login pages or the instance origin.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
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
import { readJson } from "@/test/read-body";
import { totp } from "@/test/e2e/totp";

setDefaultTimeout(30_000);

const PRIMARY = "127.0.0.1";
const UNCLAIMED = "unclaimed.example.test";
const EXTRA = "old.example.test";
const B = "b.example.test";
const PRIMARY_SCRIPT = "globalThis.primaryCustomScript = document.cookie;";
const B_SCRIPT = "globalThis.bCustomScript = 1;";

let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
let admin: Credentials;

beforeAll(async () => {
  admin = await adminCredentials();
  prepared = await prepareExecutable();
});

afterAll(async () => {
  await prepared?.cleanup();
});

/** A project settings write with a project session: one key, or the whole object with `key` "". */
async function putSetting(
  port: number,
  host: string,
  session: Session,
  key: string,
  value: unknown,
) {
  const response = await request(port, host, key ? `/api/settings/${key}` : "/api/settings", {
    method: "PUT",
    headers: sessionHeaders(session),
    body: JSON.stringify(value),
  });
  return { status: response.status, text: await response.text() };
}

/** Sets a project's public custom CSS and JS the one way there is (D201): the instance's route. */
async function putCustomCode(
  port: number,
  session: InstanceSession,
  slug: string,
  code: { custom_css?: string; custom_js?: string },
) {
  const path = `/api/instance/projects/${slug}/appearance`;
  const response = await instanceCall(port, PRIMARY, session, "PUT", path, code);
  expect(`${slug} ${response.status}`).toBe(`${slug} 200`);
}

/** The asset paths a page links to or loads as a script. */
function assetPaths(html: string): Array<string> {
  return [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((match) => match[1] ?? "");
}

test("the instance login and 2FA pages load no project custom asset; the primary's custom JS is empty on the instance origin", async () => {
  const dataDir = join(prepared.directory, crypto.randomUUID());
  registerProjects(dataDir, [
    { slug: "main", name: "Main", hostname: PRIMARY, primary: true, extra: [EXTRA] },
    { slug: "b", name: "B", hostname: B },
  ]);
  const server = await startInstance(prepared.executable, dataDir, admin);
  const { port } = server;
  try {
    // D201: only the instance writes them.
    const instance = (await instanceLogin(port, PRIMARY, admin)).session!;
    await putCustomCode(port, instance, "main", {
      custom_js: PRIMARY_SCRIPT,
      custom_css: "body{color:red}",
    });
    await putCustomCode(port, instance, "b", { custom_js: B_SCRIPT });

    // The login page: bundled assets only, with the admin pages' policy.
    for (const host of [PRIMARY, UNCLAIMED]) {
      const login = await request(port, host, "/admin/instance/login");
      expect(login.status).toBe(200);
      const html = await login.text();
      expect(html).toContain('data-testid="instance-login"');
      const paths = assetPaths(html);
      expect(paths.filter((path) => !path.startsWith("/admin/instance/"))).toEqual([
        expect.stringMatching(/^\/public\/static\/style\.css\?v=[a-f0-9]{10}$/),
        expect.stringMatching(/^\/public\/static\/favicon\.png\?v=[a-f0-9]{10}$/),
      ]);
      expect(html).not.toContain("/public/custom.");
      expect(html).not.toContain("/admin/custom.");
      expect(login.headers.get("content-security-policy")).toContain("script-src 'self'");
      // D201: an authentication page is never framed.
      expect(login.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }

    // The 2FA step, with TOTP on for the admin.
    const session = await instanceLogin(port, PRIMARY, admin);
    const provision = await instanceCall(
      port,
      PRIMARY,
      session.session!,
      "GET",
      "/api/instance/account/totp",
    );
    const { secret } = (await readJson<{ data: { secret: string } }>(provision)).data;
    const enabled = await instanceCall(
      port,
      PRIMARY,
      session.session!,
      "PUT",
      "/api/instance/account/twofa",
      { secret, code: totp(secret) },
    );
    expect(enabled.status).toBe(200);
    const challenged = await instanceLogin(port, PRIMARY, admin);
    expect(challenged.response.headers.get("location")).toStartWith("/admin/instance/login/twofa?");
    expect(challenged.body).toContain('name="totp_code"');
    expect(challenged.body).not.toContain("/public/custom.");
    expect(challenged.body).not.toContain("/admin/custom.");
    expect(
      assetPaths(challenged.body).filter((path) => !path.startsWith("/admin/instance/")),
    ).toEqual([
      expect.stringMatching(/^\/public\/static\/style\.css\?v=/),
      expect.stringMatching(/^\/public\/static\/favicon\.png\?v=/),
    ]);

    // Where the instance routes answer, the primary's custom JS is an empty script, for GET and
    // HEAD; its custom CSS is still served (a stylesheet runs no script).
    for (const host of [PRIMARY, UNCLAIMED]) {
      for (const path of [
        "/public/custom.js",
        "/public/custom.js?v=0123456789",
        "/public/./custom.js",
      ]) {
        const script = await request(port, host, path);
        expect(`${host} ${path} ${script.status}`).toBe(`${host} ${path} 200`);
        expect(script.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
        expect(script.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await script.text()).toBe("");
      }
      const head = await request(port, host, "/public/custom.js", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
      expect(await (await request(port, host, "/public/custom.css")).text()).toBe(
        "body{color:red}",
      );
      // A public page still links them, so its own markup is unchanged.
      const form = await (await request(port, host, "/subscription/form")).text();
      expect(form).toContain("/public/custom.js?v=");
    }
    // The primary's extra hostname is its own origin, with no instance route and no instance
    // cookie: the script is served there, as on any project's host.
    expect(await (await request(port, EXTRA, "/public/custom.js")).text()).toBe(PRIMARY_SCRIPT);
    expect((await request(port, EXTRA, "/admin/instance/login")).status).not.toBe(200);
    expect(await (await request(port, B, "/public/custom.js")).text()).toBe(B_SCRIPT);
  } finally {
    await server.stop();
  }
  expect((await server.stop()).code).toBe(0);
});

test("without a primary project the instance login's stylesheet and favicon answer", async () => {
  const dataDir = join(prepared.directory, crypto.randomUUID());
  registerProjects(dataDir, [{ slug: "b", name: "B", hostname: B }]);
  const server = await startInstance(prepared.executable, dataDir, admin);
  const { port } = server;
  try {
    for (const host of [PRIMARY, UNCLAIMED]) {
      const login = await request(port, host, "/admin/instance/login");
      expect(login.status).toBe(200);
      const paths = assetPaths(await login.text()).filter(
        (path) => !path.startsWith("/admin/instance/"),
      );
      expect(paths).toHaveLength(2);
      for (const path of paths) {
        const asset = await request(port, host, path);
        expect(`${host} ${path} ${asset.status}`).toBe(`${host} ${path} 200`);
        expect(asset.headers.get("content-type")).toMatch(/^(text\/css|image\/png)/);
      }
      // Nothing else of a project is served there.
      expect((await request(port, host, "/public/custom.js")).status).toBe(404);
      expect((await request(port, host, "/public/custom.css")).status).toBe(404);
    }
  } finally {
    await server.stop();
  }
  expect((await server.stop()).code).toBe(0);
});

/** The project settings as a project session reads them. */
async function projectSettings(port: number, host: string, session: Session) {
  const response = await request(port, host, "/api/settings", { headers: sessionHeaders(session) });
  return (await readJson<{ data: Record<string, unknown> }>(response)).data;
}

test("only the instance writes a project's public custom CSS and JS; a project write that keeps them succeeds (D201)", async () => {
  const dataDir = join(prepared.directory, crypto.randomUUID());
  registerProjects(dataDir, [
    { slug: "main", name: "Main", hostname: PRIMARY, primary: true },
    { slug: "b", name: "B", hostname: B },
  ]);
  const server = await startInstance(prepared.executable, dataDir, admin);
  const { port } = server;
  try {
    const b = await logIn(port, B, admin);
    const basic = await createApiUser(port, B, b, "b-api");
    for (const key of ["appearance.public.custom_js", "appearance.public.custom_css"]) {
      // One key, with the admin's own project session and with a Super Admin API credential.
      const one = await putSetting(port, B, b, key, "alert(1)");
      expect(`${key} ${one.status}`).toBe(`${key} 403`);
      expect(one.text).toContain(key);
      const byApi = await api(port, B, basic, "PUT", `/api/settings/${key}`, "alert(1)");
      expect(`${key} ${byApi.status}`).toBe(`${key} 403`);
      expect(byApi.text).toContain(key);
      // The whole object with the key changed.
      const stored = await projectSettings(port, B, b);
      const whole = await putSetting(port, B, b, "", { ...stored, [key]: "alert(1)" });
      expect(`${key} ${whole.status}`).toBe(`${key} 403`);
      expect(whole.text).toContain(key);
    }
    // The instance's route writes them; the project serves them.
    const instance = (await instanceLogin(port, PRIMARY, admin)).session!;
    await putCustomCode(port, instance, "b", { custom_js: B_SCRIPT, custom_css: "p{}" });
    const appearance = "/api/instance/projects/b/appearance";
    const read = await instanceCall(port, PRIMARY, instance, "GET", appearance);
    expect(await readJson(read)).toEqual({ data: { custom_css: "p{}", custom_js: B_SCRIPT } });
    expect(await (await request(port, B, "/public/custom.js")).text()).toBe(B_SCRIPT);
    // A listmonk-shaped full write repeating the stored values, or leaving them out, succeeds and
    // keeps them; so does a one-key write of the stored value.
    const stored = await projectSettings(port, B, b);
    expect(stored["appearance.public.custom_js"]).toBe(B_SCRIPT);
    expect((await putSetting(port, B, b, "", stored)).status).toBe(200);
    const without = { ...stored };
    delete without["appearance.public.custom_js"];
    delete without["appearance.public.custom_css"];
    expect((await putSetting(port, B, b, "", without)).status).toBe(200);
    const same = await putSetting(port, B, b, "appearance.public.custom_js", B_SCRIPT);
    expect(same.status).toBe(200);
    expect(await (await request(port, B, "/public/custom.js")).text()).toBe(B_SCRIPT);
    expect(await (await request(port, B, "/public/custom.css")).text()).toBe("p{}");
    // The route takes only the two fields, a served slug, and never an API credential.
    const other = await instanceCall(port, PRIMARY, instance, "PUT", appearance, {
      custom_js: "x",
      name: "B2",
    });
    expect(other.status).toBe(400);
    const missing = await instanceCall(
      port,
      PRIMARY,
      instance,
      "PUT",
      "/api/instance/projects/zz/appearance",
      {
        custom_js: "x",
      },
    );
    expect(missing.status).toBe(404);
    const credential = await api(port, PRIMARY, basic, "PUT", appearance, { custom_js: "x" });
    expect(credential.status).toBe(401);
    expect(await (await request(port, B, "/public/custom.js")).text()).toBe(B_SCRIPT);
  } finally {
    await server.stop();
  }
  expect((await server.stop()).code).toBe(0);
});

/** A project's sign-in as a browser posts it, with TOTP on: the 2FA page it redirects to. */
async function projectChallenge(port: number, host: string, credentials: Credentials) {
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
  const location = response.headers.get("location") ?? "";
  expect(location).toStartWith("/admin/login/twofa?");
  return request(port, host, location);
}

test("every project authentication page loads no custom asset or project image origin, and is never framed (D201)", async () => {
  const dataDir = join(prepared.directory, crypto.randomUUID());
  registerProjects(dataDir, [
    { slug: "main", name: "Main", hostname: PRIMARY, primary: true, extra: [EXTRA] },
    { slug: "b", name: "B", hostname: B },
  ]);
  const server = await startInstance(prepared.executable, dataDir, admin);
  const { port } = server;
  const favicon = "https://favicon.example.test/f.ico";
  try {
    const instance = (await instanceLogin(port, PRIMARY, admin)).session!;
    for (const [slug, host] of [
      ["main", PRIMARY],
      ["b", B],
    ] as const) {
      await putCustomCode(port, instance, slug, { custom_js: B_SCRIPT, custom_css: "p{}" });
      const session = await logIn(port, host, admin);
      expect((await putSetting(port, host, session, "app.favicon_url", favicon)).status).toBe(200);
    }
    // TOTP on for the admin, so every project's sign-in has its 2FA step.
    const copy = await logIn(port, B, admin);
    const profile = await request(port, B, "/api/profile", { headers: sessionHeaders(copy) });
    const me = (await readJson<{ data: { id: number } }>(profile)).data;
    const provision = await request(port, B, `/api/users/${me.id}/twofa/totp`, {
      headers: sessionHeaders(copy),
    });
    const { secret } = (await readJson<{ data: { secret: string } }>(provision)).data;
    const enabled = await request(port, B, `/api/users/${me.id}/twofa`, {
      method: "PUT",
      headers: sessionHeaders(copy),
      body: JSON.stringify({ secret, code: totp(secret), password: admin.password }),
    });
    expect(enabled.status).toBe(200);

    for (const host of [PRIMARY, EXTRA, B]) {
      const pages: Array<[string, Response]> = [
        ["login", await request(port, host, "/admin/login")],
        ["forgot", await request(port, host, "/admin/forgot")],
        ["reset", await request(port, host, "/admin/reset?token=nope&email=a%40example.test")],
        ["twofa", await projectChallenge(port, host, admin)],
      ];
      for (const [name, page] of pages) {
        const label = `${host} ${name}`;
        const html = await page.text();
        expect(`${label} ${page.headers.get("content-type")}`).toStartWith(`${label} text/html`);
        // The reset link here is invalid: its answer is the message page, with no form.
        expect(html.includes("<form"), label).toBe(name !== "reset");
        expect(html.includes("/public/custom."), label).toBe(false);
        expect(html.includes("favicon.example.test"), label).toBe(false);
        expect(html, label).toMatch(/\/public\/static\/favicon\.png\?v=[a-f0-9]{10}/);
        const policy = page.headers.get("content-security-policy") ?? "";
        expect(policy, label).toContain("frame-ancestors 'none'");
        expect(policy.includes("favicon.example.test"), label).toBe(false);
      }
    }
    // A public page still loads both.
    const form = await (await request(port, B, "/subscription/form")).text();
    expect(form).toContain("/public/custom.js?v=");
    expect(form).toContain(favicon);
  } finally {
    await server.stop();
  }
  expect((await server.stop()).code).toBe(0);
});

test("the admin's copy changes its password, email and TOTP from a project session only with its current password (D201)", async () => {
  const dataDir = join(prepared.directory, crypto.randomUUID());
  registerProjects(dataDir, [
    { slug: "main", name: "Main", hostname: PRIMARY, primary: true },
    { slug: "b", name: "B", hostname: B },
  ]);
  const server = await startInstance(prepared.executable, dataDir, admin);
  const { port } = server;
  const fresh = "a-new-instance-password";
  try {
    const copy = await logIn(port, B, admin);
    const read = await request(port, B, "/api/profile", { headers: sessionHeaders(copy) });
    const me = (await readJson<{ data: { id: number; email: string; name: string } }>(read)).data;
    const profile = (body: Record<string, unknown>) =>
      request(port, B, "/api/profile", {
        method: "PUT",
        headers: sessionHeaders(copy),
        body: JSON.stringify({ name: me.name, email: me.email, ...body }),
      });
    const refused = [
      await profile({ password: fresh, password2: fresh }),
      await profile({ password: fresh, password2: fresh, current_password: "wrong-password" }),
      await profile({ email: "attacker@example.test" }),
      await request(port, B, `/api/users/${me.id}`, {
        method: "PUT",
        headers: sessionHeaders(copy),
        body: JSON.stringify({
          username: admin.user,
          email: me.email,
          name: me.name,
          type: "user",
          status: "enabled",
          password_login: true,
          password: fresh,
          user_role_id: 1,
        }),
      }),
    ];
    for (const [index, response] of refused.entries()) {
      expect(`${index} ${response.status}`).toBe(`${index} 403`);
    }
    // Nothing reached the instance: the old password still signs in there, with no TOTP.
    const still = await instanceLogin(port, PRIMARY, admin);
    expect(still.session).toBeDefined();
    const provision = await request(port, B, `/api/users/${me.id}/twofa/totp`, {
      headers: sessionHeaders(copy),
    });
    const { secret } = (await readJson<{ data: { secret: string } }>(provision)).data;
    const enrol = (body: Record<string, unknown>) =>
      request(port, B, `/api/users/${me.id}/twofa`, {
        method: "PUT",
        headers: sessionHeaders(copy),
        body: JSON.stringify({ secret, code: totp(secret), ...body }),
      });
    expect((await enrol({})).status).toBe(403);
    expect((await enrol({ password: "wrong-password" })).status).toBe(403);
    const account = await instanceCall(
      port,
      PRIMARY,
      still.session!,
      "GET",
      "/api/instance/account",
    );
    expect((await readJson<{ data: { twofa_type: string } }>(account)).data.twofa_type).toBe(
      "none",
    );

    // With the current password both change, and write through.
    const changed = await profile({
      password: fresh,
      password2: fresh,
      current_password: admin.password,
    });
    expect(changed.status).toBe(200);
    const renewed = { user: admin.user, password: fresh };
    expect((await instanceLogin(port, PRIMARY, admin)).session).toBeUndefined();
    expect((await instanceLogin(port, PRIMARY, renewed)).session).toBeDefined();
    const again = await logIn(port, B, renewed);
    const enabled = await request(port, B, `/api/users/${me.id}/twofa`, {
      method: "PUT",
      headers: sessionHeaders(again),
      body: JSON.stringify({ secret, code: totp(secret), password: fresh }),
    });
    expect(enabled.status).toBe(200);
    // Written through: the instance sign-in now asks for the code.
    const challenged = await instanceLogin(port, PRIMARY, renewed);
    expect(challenged.response.headers.get("location")).toStartWith("/admin/instance/login/twofa?");

    // Another user's own profile is unchanged: no current password asked.
    const created = await request(port, B, "/api/users", {
      method: "POST",
      headers: sessionHeaders(again),
      body: JSON.stringify({
        username: "other",
        email: "other@example.test",
        name: "Other",
        type: "user",
        status: "enabled",
        password_login: true,
        password: "other-password-1",
        user_role_id: 1,
      }),
    });
    expect(created.status).toBe(200);
    const other = await logIn(port, B, { user: "other", password: "other-password-1" });
    const own = await request(port, B, "/api/profile", {
      method: "PUT",
      headers: sessionHeaders(other),
      body: JSON.stringify({
        name: "Other",
        email: "other@example.test",
        password: "other-password-2",
        password2: "other-password-2",
      }),
    });
    expect(own.status).toBe(200);
  } finally {
    await server.stop();
  }
  expect((await server.stop()).code).toBe(0);
});
