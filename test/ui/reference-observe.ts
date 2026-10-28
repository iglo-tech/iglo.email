// Reference observations: listmonk v7.0.0-beta.1 (6fcd95f).
// Run only inside `bun run reference:run -- bun test/ui/reference-observe.ts`.
import { strict as assert } from "node:assert";
import { rawRequest } from "@/test/server/raw-request";

const origin = process.env.REFERENCE_URL;
if (!origin || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin)) {
  throw new Error("Expected the owned loopback reference runner");
}
for (const [method, path] of [
  ["POST", "/health"],
  ["GET", "/missing-public-page"],
] as const) {
  const response = await rawRequest(origin, path, { method });
  assert.equal(response.status, 404);
  assert.equal(response.contentType, "text/html; charset=UTF-8");
  assert.match(response.body, /<!DOCTYPE html>/i);
  assert.match(response.body, /<title>404 - Not found - Mailing list<\/title>/);
  assert.match(response.body, /<h2>404 - Not found<\/h2>/);
  assert.match(response.body, /href="\/public\/static\/style\.css\?v=[a-z0-9]+"/);
  assert.match(response.body, /src="\/public\/static\/logo\.svg\?v=[a-z0-9]+"/);
  assert.match(
    response.body,
    /<footer[^>]*>[\s\S]*Powered by[\s\S]*href="https:\/\/listmonk\.app"/,
  );
  console.log(`PASS ${method} ${path}: public HTML 404`);
}
const publicHead = await rawRequest(origin, "/missing-public-page", { method: "HEAD" });
assert.deepEqual(publicHead, { status: 404, contentType: "text/html; charset=UTF-8", body: "" });
console.log("PASS HEAD /missing-public-page: bodyless HTML 404");
for (const path of ["/public/static/style.css", "/admin/static/oat.min.css"]) {
  const get = await rawRequest(origin, path);
  assert.equal(get.status, 200);
  assert.equal(get.contentType, "text/css; charset=utf-8");
  assert.ok(get.body.length > 100);
  for (const method of ["HEAD", "POST", "OPTIONS"]) {
    const response: Response = await fetch(origin + path, {
      method,
      headers: { Connection: "close" },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, method === "OPTIONS" ? 204 : 405);
    assert.equal(response.headers.get("allow"), "OPTIONS, GET");
    await response.arrayBuffer();
  }
  const head = await rawRequest(origin, path, { method: "HEAD" });
  assert.deepEqual(head, { status: 405, contentType: null, body: "" });
  const post = await rawRequest(origin, path, { method: "POST" });
  assert.deepEqual(post, {
    status: 405,
    contentType: "application/json",
    body: '{"message":"Method Not Allowed"}\n',
  });
  console.log(`PASS GET/HEAD/POST ${path}: CSS 200, HEAD/POST 405`);
}
for (const path of [
  "/public/static/no-such-file.css",
  "/public/static/",
  "/public/static/%2e%2e/style.css",
  "/admin/static/no-such-file.css",
]) {
  const response = await rawRequest(origin, path);
  assert.deepEqual(response, {
    status: 404,
    contentType: "text/plain; charset=utf-8",
    body: "404 page not found\n",
  });
  console.log(`PASS GET ${path}: plain-text static 404`);
}
for (const path of [
  "/public/static/%73tyle.css",
  "/public/static/style%2ecss",
  "/public/static//style.css",
  "/admin/static/fonts/Geist%2dVariable.woff2",
]) {
  const response: Response = await fetch(origin + path, {
    headers: { Connection: "close" },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type"),
    path.endsWith("woff2") ? "font/woff2" : "text/css; charset=utf-8",
  );
  if (path.endsWith("woff2"))
    assert.equal(new TextDecoder().decode((await response.arrayBuffer()).slice(0, 4)), "wOF2");
  else assert.ok((await response.text()).includes("box-sizing"));
  console.log(`PASS GET ${path}: equivalent embedded resource spelling`);
}
