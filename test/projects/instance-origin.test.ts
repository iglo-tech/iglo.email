// B172 (D200; 14-projects sections 2 and 5): no project-authored content runs script in the origin
// where the instance credentials are typed and sent. The compiled executable serves a primary
// project on the instance host (127.0.0.1) with an extra hostname, and project `b` on its own host.
// The primary's public custom JS is set through its own API, as any primary-project user with
// `settings:manage` could set it; it never reaches the instance login pages or the instance origin.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import {
  adminCredentials,
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

async function putSetting(
  port: number,
  host: string,
  session: Session,
  key: string,
  value: unknown,
) {
  const response = await request(port, host, `/api/settings/${key}`, {
    method: "PUT",
    headers: sessionHeaders(session),
    body: JSON.stringify(value),
  });
  expect(`${host} ${key} ${response.status}`).toBe(`${host} ${key} 200`);
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
    const primary = await logIn(port, PRIMARY, admin);
    await putSetting(port, PRIMARY, primary, "appearance.public.custom_js", PRIMARY_SCRIPT);
    await putSetting(port, PRIMARY, primary, "appearance.public.custom_css", "body{color:red}");
    const b = await logIn(port, B, admin);
    await putSetting(port, B, b, "appearance.public.custom_js", B_SCRIPT);

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
