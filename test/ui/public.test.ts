import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
        status: 405,
        contentType: null,
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
  });
}, 30_000);
