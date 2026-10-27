// Bounded, compiled, test-only browser-resource and public-page verification.
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command, spawnGroup, stopGroup, type GroupChild } from "@/test/reference/command";
import { withProduction } from "@/test/contract/owned";
import { rawRequest } from "@/test/server/raw-request";

const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(join(tmpdir(), "iglo-ui-verify-"));
const controller = new AbortController();
const interrupt = () => controller.abort(new Error("ui:verify interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
let fixture: GroupChild | undefined;
let closed: Promise<number> | undefined;
try {
  const fixturePath = join(directory, "fixture");
  const productionPath = join(directory, "iglo.email");
  for (const [source, output] of [
    ["test/ui/shell-fixture.tsx", fixturePath],
    ["src/main.ts", productionPath],
  ]) {
    const result = await command(
      [process.execPath, "build", "--compile", source!, "--outfile", output!],
      { cwd: root, timeout: 30_000, signal: controller.signal },
    );
    if (result.code !== 0) throw new Error(`Compile failed: ${result.stderr}`);
  }
  fixture = spawnGroup(fixturePath, [], {
    cwd: directory,
    env: { PATH: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  closed = new Promise((resolveClose, reject) => {
    fixture!.once("error", reject);
    fixture!.once("close", (code) => resolveClose(code ?? 1));
  });
  void closed.catch(() => {});
  const origin = await new Promise<string>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture readiness timeout")), 5_000);
    const abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", abort, { once: true });
    fixture!.stdout!.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      const value = chunk.toString().trim();
      if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(value))
        reject(new Error("Invalid fixture origin"));
      else resolveReady(value);
    });
    fixture!.once("error", reject);
    fixture!.once("exit", () => reject(new Error("Fixture exited before readiness")));
  });
  const get = (path: string, method = "GET") =>
    rawRequest(origin, path, { method, signal: controller.signal });
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(
    page.body,
    /<title>Fixture &lt;&amp;&quot; title - Synthetic &lt;&amp;&quot; site<\/title>/,
  );
  assert.match(page.body, /Nav &lt;&amp;&quot;/);
  assert.match(page.body, /User &lt;&amp;&quot;/);
  assert.ok(!page.body.includes("globalThis.fixtureInjected=true</script>"));
  const bootstrap = /window\._LM_I18N=(.*?);window\._LM_CONFIG=(.*?);<\/script>/.exec(page.body);
  assert.ok(bootstrap);
  for (const value of [bootstrap[1]!, bootstrap[2]!]) assert.ok(!/[<>&\u2028\u2029]/.test(value));
  const payload = "</script><script>globalThis.fixtureInjected=true</script>&\u2028\u2029";
  assert.equal(JSON.parse(bootstrap[1]!)["fixture.hostile"], payload);
  assert.equal(JSON.parse(bootstrap[2]!).hostile, payload);
  assert.equal((await get("/invalid-navigation")).status, 400);
  assert.equal((await get("/invalid-config")).status, 400);
  for (const [path, contentType] of [
    ["/admin/static/oat.min.css", "text/css; charset=utf-8"],
    ["/admin/static/style.css", "text/css; charset=utf-8"],
    ["/admin/static/js/main.js", "text/javascript; charset=utf-8"],
    ["/admin/static/js/code-editor.js", "text/javascript; charset=utf-8"],
    ["/admin/static/js/richtext-editor.js", "text/javascript; charset=utf-8"],
    ["/admin/static/js/charts.js", "text/javascript; charset=utf-8"],
    ["/admin/static/fonts/Geist-Variable.woff2", "font/woff2"],
    ["/admin/static/logo.svg", "image/svg+xml"],
  ] as const) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.contentType, contentType, path);
    assert.ok(response.body.length > 100, path);
    if (path.endsWith("oat.min.css")) assert.ok(response.body.includes("@layer"));
    if (path.endsWith("/style.css")) assert.ok(response.body.includes("@font-face"));
    if (path.endsWith("logo.svg")) assert.ok(response.body.includes("<svg"));
    assert.deepEqual(await get(path, "HEAD"), { status: 405, contentType: null, body: "" });
    if (path.endsWith(".js")) {
      for (const match of response.body.matchAll(
        /(?:from|import)\s*["'](\.\.?\/[^"']+\.js)["']/g,
      )) {
        const chunk = new URL(match[1]!, `http://127.0.0.1${path}`).pathname;
        const response = await get(chunk);
        assert.equal(response.status, 200, chunk);
        assert.equal(response.contentType, "text/javascript; charset=utf-8");
      }
    }
  }
  for (const [path, contentType, magic] of [
    ["/admin/static/fonts/Geist-Variable.woff2", "font/woff2", [0x77, 0x4f, 0x46, 0x32]],
    ["/admin/static/favicon.png", "image/png", [0x89, 0x50, 0x4e, 0x47]],
  ] as const) {
    const response = await fetch(`${origin}${path}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), contentType);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(0, 4)], [...magic]);
  }
  assert.equal((await get("/admin/static/no-such-file.css")).status, 404);
  assert.equal((await get("/admin/static/%2e%2e/style.css")).status, 404);
  await withProduction(productionPath, controller.signal, async (production) => {
    const response = await rawRequest(production, "/missing-public-page", {
      signal: controller.signal,
    });
    assert.equal(response.status, 404);
    assert.equal(response.contentType, "text/html; charset=UTF-8");
    assert.match(response.body, /<h2>404 - Not found<\/h2>/);
    const css = await rawRequest(production, "/public/static/style.css", {
      signal: controller.signal,
    });
    assert.equal(css.status, 200);
    assert.equal(css.contentType, "text/css; charset=utf-8");
    assert.ok(css.body.includes("box-sizing"));
    assert.equal(
      (await rawRequest(production, "/public/static/missing.css", { signal: controller.signal }))
        .status,
      404,
    );
  });
  console.log(
    "ui:verify passed: compiled shell, script-safe bootstrap, embedded assets and production public 404",
  );
} finally {
  if (fixture && closed) {
    if (fixture.exitCode === null && fixture.signalCode === null) stopGroup(fixture);
    const force = setTimeout(() => stopGroup(fixture!, "SIGKILL"), 2000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  }
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  await rm(directory, { recursive: true, force: true });
}
