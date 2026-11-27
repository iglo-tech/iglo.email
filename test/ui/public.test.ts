import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTranslation } from "@/i18n/i18n";
import { startFixture } from "@/test/server/fixture";
import { adminLogin, lifetimeWithinTest, withProduction } from "@/test/contract/owned";
import { rawRequest } from "@/test/server/raw-request";
import { totp } from "@/test/e2e/totp";
import { readJson } from "@/test/read-body";

let directory = "";
let executable = "";
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "iglo-public-spec-"));
  executable = join(directory, "iglo.email");
  const build = Bun.spawn(
    [process.execPath, "build", "--compile", "src/main.ts", "--outfile", executable],
    { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  );
  const [code, error] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  if (code !== 0) {
    throw new Error(`Production build failed: ${error}`);
  }
}, 30_000);
afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compiled executable includes the vendored editor theme MIT notice", async () => {
  const started = Date.now();
  await withProduction(
    executable,
    new AbortController().signal,
    async (origin) => {
      const response = await fetch(
        `${origin}/admin/static/licenses/fsegurai-codemirror-themes-MIT.txt`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      const notice = await response.text();
      expect(notice).toContain("Copyright (c) 2025 fsegurai");
      expect(notice).toContain("Permission is hereby granted, free of charge");
      expect(notice).toContain(
        "The above copyright notice and this permission notice shall be included",
      );
      expect(notice).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
    },
    undefined,
    lifetimeWithinTest(started),
  );
}, 30_000);

test.each([
  "/public/static/%73tyle.css",
  "/public/static/style%2ecss",
  "/public/static//style.css",
  "/admin/static/fonts/Geist%2dVariable.woff2",
])(
  "compiled asset lookup accepts canonical spelling %s",
  async (path) => {
    const started = Date.now();
    await withProduction(
      executable,
      new AbortController().signal,
      async (origin) => {
        const response = await fetch(origin + path);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          path.endsWith("woff2") ? "font/woff2" : "text/css; charset=utf-8",
        );
        if (path.endsWith("woff2")) {
          expect(new TextDecoder().decode((await response.arrayBuffer()).slice(0, 4))).toBe("wOF2");
        } else {
          expect(await response.text()).toContain("box-sizing");
        }
        const head = await fetch(origin + path, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe("");
      },
      undefined,
      lifetimeWithinTest(started),
    );
  },
  30_000,
);

test.each(["OPTIONS", "POST", "HEAD"])(
  "embedded assets handle %s with the declared methods",
  async (method) => {
    const started = Date.now();
    await withProduction(
      executable,
      new AbortController().signal,
      async (origin) => {
        for (const path of ["/public/static/style.css", "/admin/static/oat.min.css"]) {
          const response = await fetch(origin + path, { method });
          if (method === "OPTIONS") {
            expect(response.status).toBe(204);
            expect(response.headers.get("allow")).toBe("OPTIONS, GET, HEAD");
            expect(await response.text()).toBe("");
          } else if (method === "POST") {
            expect(response.status).toBe(405);
            expect(response.headers.get("allow")).toBe("OPTIONS, GET, HEAD");
          } else {
            const get = await fetch(origin + path);
            const body = await get.arrayBuffer();
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toBe(get.headers.get("content-type"));
            expect(response.headers.get("cache-control")).toBe(get.headers.get("cache-control"));
            expect(response.headers.get("content-length")).toBe(String(body.byteLength));
            expect(await response.text()).toBe("");
          }
        }
      },
      undefined,
      lifetimeWithinTest(started),
    );
  },
  30_000,
);

test("compiled production serves the public message page and asset boundaries", async () => {
  const started = Date.now();
  await withProduction(
    executable,
    new AbortController().signal,
    async (origin) => {
      for (const [method, path] of [
        ["POST", "/health"],
        ["GET", "/missing-public-page"],
      ] as const) {
        const page = await rawRequest(origin, path, { method });
        expect(page.status).toBe(404);
        expect(page.contentType).toBe("text/html; charset=UTF-8");
        expect(page.body).toMatch(/<!DOCTYPE html>/i);
        // B121 (D119): the 404 is the branded public shell, with the site's name (the default here).
        // B126 (D123): titled "Page not found", with no footer and no product credit.
        expect(page.body).toContain("<title>Page not found - Mailing list</title>");
        expect(page.body).toContain("<h2>Page not found</h2>");
        expect(page.body).toMatch(/href="\/public\/static\/style\.css\?v=[a-z0-9]+"/);
        expect(page.body).toMatch(/href="\/public\/custom\.css\?v=[a-z0-9]+"/);
        // B129 (D127): with no logo set, the automatic header shows the site name.
        expect(page.body).toContain('<span class="site-name">Mailing list</span>');
        expect(page.body).not.toMatch(/<footer|Powered by|listmonk/);
      }
      expect(await rawRequest(origin, "/missing-public-page", { method: "HEAD" })).toEqual({
        status: 404,
        contentType: "text/html; charset=UTF-8",
        body: "",
      });
      for (const path of ["/public/static/style.css", "/admin/static/oat.min.css"]) {
        const asset = await rawRequest(origin, path);
        expect(asset.status).toBe(200);
        expect(asset.contentType).toBe("text/css; charset=utf-8");
        expect(asset.body.length).toBeGreaterThan(100);
        expect(await rawRequest(origin, path, { method: "HEAD" })).toEqual({
          status: 200,
          contentType: "text/css; charset=utf-8",
          body: "",
        });
        expect(await rawRequest(origin, path, { method: "POST" })).toEqual({
          status: 405,
          contentType: "application/json",
          body: '{"message":"Method Not Allowed","code":"method_not_allowed"}\n',
        });
      }
      for (const path of [
        "/public/static/no-such-file.css",
        "/public/static/",
        "/admin/static/no-such-file.css",
      ]) {
        expect(await rawRequest(origin, path)).toEqual({
          status: 404,
          contentType: "text/plain; charset=utf-8",
          body: "404 page not found\n",
        });
      }
      // D18: Bun removes encoded dot segments before the router sees the target.
      const traversal = await rawRequest(origin, "/public/static/%2e%2e/style.css");
      expect(traversal.status).toBe(404);
      expect(traversal.contentType).toBe("text/html; charset=UTF-8");
      expect(traversal.body).toContain("<h2>Page not found</h2>");
    },
    undefined,
    lifetimeWithinTest(started),
  );
}, 30_000);

// Request-local translations are escaped in the heading (B126: the heading is `public.pageNotFound`).
test("public fallback uses and escapes the injected translation instance", async () => {
  const i18n = createTranslation().Load({
    "public.pageNotFound": '<script>&"',
  });
  const fixture = startFixture({ i18n });
  try {
    const response = await fetch(`${fixture.origin}/missing`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = await response.text();
    expect(response.status).toBe(404);
    expect(body).toContain("<h2>&lt;script&gt;&amp;&quot;</h2>");
    expect(body).not.toContain("<script>");
  } finally {
    await fixture.close();
  }
});

// B121 review: the public catch-all must not take admin or API paths from their own handlers.
// Through the compiled server, which wires every route, as an operator's instance does.
const admin = { user: "branding-admin", password: "branding-admin-password" };
test("admin and API paths keep their own answers; only other paths get the public 404", async () => {
  const started = Date.now();
  await withProduction(
    executable,
    new AbortController().signal,
    async (origin) => {
      const anonymous = await fetch(`${origin}/admin/no-such-view`, { redirect: "manual" });
      expect(anonymous.status).toBe(307);
      expect(anonymous.headers.get("location")).toMatch(/^\/admin\/login\?next=/);

      const { cookie } = await adminLogin(origin, admin);
      const signedIn = await fetch(`${origin}/admin/no-such-view`, { headers: { Cookie: cookie } });
      const adminBody = await signedIn.text();
      expect(signedIn.status).toBe(404);
      expect(signedIn.headers.get("content-type")).toBe("text/html; charset=UTF-8");
      expect(adminBody).not.toContain('href="/public/custom.css');
      // The admin's own error page, with the admin shell's stylesheet: not the public 404.
      expect(adminBody).toContain("404 page not found");
      expect(adminBody).toContain("/admin/static/oat.min.css");

      const api = await fetch(`${origin}/api/no-such`);
      expect(api.status).toBe(404);
      expect(api.headers.get("content-type")).toBe("application/json");
      expect(await api.text()).toContain("404 unknown endpoint");

      const publicPage = await fetch(`${origin}/no-such`);
      const html = await publicPage.text();
      expect(publicPage.status).toBe(404);
      expect(html).toContain("<title>Page not found - Mailing list</title>");
      expect(html).toMatch(/href="\/public\/custom\.css\?v=[a-f0-9]{10}"/);
    },
    admin,
    lifetimeWithinTest(started),
  );
}, 30_000);

// B121 review (lead decision): sign-in, two-factor, password reset and the archive preview are
// branded like the public pages. The sign-in page shows the site's logo.
test("the sign-in, forgot-password and reset pages show the site's logo", async () => {
  const started = Date.now();
  const logo = "https://brand.example.test/logo.png";
  await withProduction(
    executable,
    new AbortController().signal,
    async (origin) => {
      const { cookie, token } = await adminLogin(origin, admin);
      const set = await fetch(`${origin}/api/settings/app.logo_url`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": token },
        body: JSON.stringify(logo),
      });
      expect(set.status).toBe(200);
      for (const path of ["/admin/login", "/admin/forgot", "/admin/reset"]) {
        const html = await (await fetch(`${origin}${path}`)).text();
        expect(html).toContain(`src="${logo}"`);
        // D201: an authentication page loads no custom asset.
        expect(html).not.toContain("/public/custom.");
        expect(html).not.toContain("/public/static/logo.svg");
      }
    },
    admin,
    lifetimeWithinTest(started),
  );
}, 30_000);

// B118f (B118b and B121 r2 gaps): the two-factor and archive-preview error pages are branded like
// the public pages, not the admin shell (09-decisions, B121 review: operator pages take the site
// getter). A signed-in admin with two-factor on reaches the challenge from a fresh sign-in, then
// answers a wrong code; the same session posts an archive preview whose `archive_meta` is broken.
test("the two-factor and archive-preview error pages show the site's logo, not the admin shell", async () => {
  const started = Date.now();
  const logo = "https://brand.example.test/factor.png";
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  await withProduction(
    executable,
    new AbortController().signal,
    async (origin) => {
      const { cookie, token } = await adminLogin(origin, admin);
      const signed = { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": token };
      const profile = await readJson<{ data: { id: number } }>(
        await fetch(`${origin}/api/profile`, { headers: { Cookie: cookie } }),
      );
      const set = await fetch(`${origin}/api/settings/app.logo_url`, {
        method: "PUT",
        headers: signed,
        body: JSON.stringify(logo),
      });
      expect(set.status).toBe(200);
      const enable = await fetch(`${origin}/api/users/${profile.data.id}/twofa`, {
        method: "PUT",
        headers: signed,
        // D201: the admin's copy enrols with its current password.
        body: JSON.stringify({ secret, code: totp(secret), password: admin.password }),
      });
      expect(enable.status).toBe(200);

      // A fresh sign-in with the right password waits on the second factor.
      const form = await fetch(`${origin}/admin/login`);
      const formNonce = /name="nonce"\s+value="([^"]+)"/.exec(await form.text())?.[1] ?? "";
      const formCookie =
        form.headers
          .getSetCookie()
          .find((item) => item.startsWith("nonce="))
          ?.split(";", 1)[0] ?? "";
      const challenge = await fetch(`${origin}/admin/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: formCookie },
        body: new URLSearchParams({
          username: admin.user,
          password: admin.password,
          nonce: formNonce,
          next: "/api/profile",
        }),
      });
      expect(challenge.status).toBe(302);
      const location = challenge.headers.get("location") ?? "";
      expect(location).toStartWith("/admin/login/twofa?");

      const twofa = await fetch(`${origin}${location}`);
      const twofaHtml = await twofa.text();
      expect(twofa.status).toBe(200);
      expect(twofaHtml).toContain(`src="${logo}"`);
      // D201: an authentication page loads no custom asset.
      expect(twofaHtml).not.toContain("/public/custom.");
      expect(twofaHtml).not.toContain("/admin/static/oat.min.css");

      // A code outside the window the server accepts, so the answer is the error page.
      const accepted = new Set(
        [-30_000, 0, 30_000].map((offset) => totp(secret, Date.now() + offset)),
      );
      const wrong = ["000000", "000001"].find((code) => !accepted.has(code)) ?? "000000";
      const twofaNonce = /name="nonce"\s+value="([^"]+)"/.exec(twofaHtml)?.[1] ?? "";
      const twofaCookie =
        twofa.headers
          .getSetCookie()
          .find((item) => item.startsWith("nonce="))
          ?.split(";", 1)[0] ?? "";
      const rejected = await fetch(`${origin}/admin/login/twofa`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: twofaCookie },
        body: new URLSearchParams({
          nonce: twofaNonce,
          token: new URL(location, origin).searchParams.get("token") ?? "",
          next: "/api/profile",
          totp_code: wrong,
        }),
      });
      const rejectedHtml = await rejected.text();
      expect(rejected.status).toBe(200);
      expect(rejectedHtml).toContain("Invalid value");
      expect(rejectedHtml).toContain(`src="${logo}"`);
      expect(rejectedHtml).not.toContain("/admin/static/oat.min.css");

      // The signed-in session's archive preview: broken `archive_meta` is the public error page.
      const list = await fetch(`${origin}/api/lists`, {
        method: "POST",
        headers: signed,
        body: JSON.stringify({ name: "Branding", type: "public", optin: "single" }),
      });
      expect(list.status).toBe(200);
      const listID = (await readJson<{ data: { id: number } }>(list)).data.id;
      const created = await fetch(`${origin}/api/campaigns`, {
        method: "POST",
        headers: signed,
        body: JSON.stringify({
          name: "Branding",
          subject: "Branding",
          lists: [listID],
          content_type: "richtext",
          type: "regular",
          messenger: "email",
          body: "<p>Hello</p>",
          from_email: "",
        }),
      });
      expect(created.status).toBe(200);
      const campaign = (await readJson<{ data: { id: number } }>(created)).data;
      const preview = await fetch(`${origin}/api/campaigns/${campaign.id}/preview/archive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookie,
          "X-CSRF-Token": token,
        },
        body: new URLSearchParams({ template_id: "", archive_meta: "{" }),
      });
      const previewHtml = await preview.text();
      expect(preview.status).toBe(500);
      expect(previewHtml).toContain("Error fetching e-mail message.");
      expect(previewHtml).toContain(`src="${logo}"`);
      expect(previewHtml).toMatch(/href="\/public\/custom\.css\?v=[a-f0-9]{10}"/);
      expect(previewHtml).not.toContain("/admin/static/oat.min.css");
    },
    admin,
    lifetimeWithinTest(started),
  );
}, 30_000);
