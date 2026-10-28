import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTranslation } from "@/i18n/i18n";
import { startFixture } from "@/test/server/fixture";
import { withProduction } from "@/test/contract/owned";
import { rawRequest } from "@/test/server/raw-request";

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
  if (code !== 0) throw new Error(`Production build failed: ${error}`);
}, 30_000);
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test.each([
  "/public/static/%73tyle.css",
  "/public/static/style%2ecss",
  "/public/static//style.css",
  "/admin/static/fonts/Geist%2dVariable.woff2",
])(
  "compiled asset lookup accepts canonical spelling %s",
  async (path) => {
    await withProduction(executable, new AbortController().signal, async (origin) => {
      const response = await fetch(origin + path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        path.endsWith("woff2") ? "font/woff2" : "text/css; charset=utf-8",
      );
      if (path.endsWith("woff2"))
        expect(new TextDecoder().decode((await response.arrayBuffer()).slice(0, 4))).toBe("wOF2");
      else expect(await response.text()).toContain("box-sizing");
      const head = await fetch(origin + path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    });
  },
  30_000,
);

test.each(["OPTIONS", "POST", "HEAD"])(
  "embedded assets handle %s with the declared methods",
  async (method) => {
    await withProduction(executable, new AbortController().signal, async (origin) => {
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
    });
  },
  30_000,
);

test("compiled production serves the public message page and asset boundaries", async () => {
  await withProduction(executable, new AbortController().signal, async (origin) => {
    for (const [method, path] of [
      ["POST", "/health"],
      ["GET", "/missing-public-page"],
    ] as const) {
      const page = await rawRequest(origin, path, { method });
      expect(page.status).toBe(404);
      expect(page.contentType).toBe("text/html; charset=UTF-8");
      expect(page.body).toMatch(/<!DOCTYPE html>/i);
      expect(page.body).toContain("<title>404 - Not found - iglo.email</title>");
      expect(page.body).toContain("<h2>404 - Not found</h2>");
      expect(page.body).toMatch(/href="\/public\/static\/style\.css\?v=[a-z0-9]+"/);
      expect(page.body).toMatch(/src="\/public\/static\/logo\.svg\?v=[a-z0-9]+"/);
      expect(page.body).toMatch(
        /<footer[^>]*>[\s\S]*Powered by[\s\S]*iglo\.email[\s\S]*<\/footer>/,
      );
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
        body: '{"message":"Method Not Allowed"}\n',
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
    expect(traversal.body).toContain("<h2>404 - Not found</h2>");
  });
}, 30_000);

// Request-local translations are escaped in both heading and footer.
test("public fallback uses and escapes the injected translation instance", async () => {
  const i18n = createTranslation().Load({
    "globals.terms.notFound": '<script>&"',
    "public.poweredBy": "By <unsafe>&",
  });
  const fixture = startFixture({ i18n });
  try {
    const response = await fetch(`${fixture.origin}/missing`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = await response.text();
    expect(response.status).toBe(404);
    expect(body).toContain("<h2>404 - &lt;script&gt;&amp;&quot;</h2>");
    expect(body).toContain("By &lt;unsafe&gt;&amp;");
    expect(body).not.toContain("<script>");
  } finally {
    await fixture.close();
  }
});
