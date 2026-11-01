// The policy of admin pages (D71), read over HTTP, and every Alpine expression those pages render,
// through the parser of the CSP build they load.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateRuntimeFunction, Parser, Tokenizer } from "@alpinejs/csp/src/parser.js";
import { admin, get, login, type Fixture } from "@/test/admin/support";
import { startUserFixture } from "@/test/users/fixture";

const screens = [
  "/admin",
  "/admin/user/profile",
  "/admin/lists",
  "/admin/lists/new",
  "/admin/lists/1",
  "/admin/lists/1/edit",
  "/admin/lists/analytics",
  "/admin/lists/forms",
  "/admin/subscribers",
  "/admin/subscribers/new",
  "/admin/subscribers/lists/1",
  "/admin/subscribers/1",
  "/admin/subscribers/1/edit",
  "/admin/subscribers/1/lists",
  "/admin/subscribers/1/bounces",
  "/admin/subscribers/1/events",
  "/admin/subscribers/1/enrollments",
  "/admin/subscribers/1/sends",
  "/admin/subscribers/import",
  "/admin/subscribers/bounces",
  "/admin/campaigns",
  "/admin/campaigns/new",
  "/admin/campaigns/1",
  "/admin/campaigns/media",
  "/admin/campaigns/media/fragment",
  "/admin/campaigns/analytics",
  "/admin/templates",
  "/admin/templates/new",
  "/admin/templates/1",
  "/admin/sequences",
  "/admin/sequences/new",
  "/admin/sequences/enrollments",
  "/admin/sequences/enrollments/1",
  "/admin/sequences/1",
  "/admin/users",
  "/admin/users/new",
  "/admin/users/roles",
  "/admin/users/roles/new",
  "/admin/users/roles/lists",
  "/admin/users/roles/lists/new",
  "/admin/users/roles/1",
  "/admin/users/1",
  "/admin/settings",
  "/admin/settings/logs",
  "/admin/settings/maintenance",
];

const policy = (images: string) =>
  [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${images}`,
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
  ].join("; ");

let f: Fixture;
let cookie = "";
let strict = "";
beforeAll(async () => {
  f = await startUserFixture();
  cookie = (await login(f, admin.user, admin.password)).cookie;
  strict = (await get(f, "/admin/login")).headers.get("content-security-policy") ?? "";
});
afterAll(() => f.close());

test("the policy names only what the admin uses", () => {
  const images = /img-src ([^;]+)/.exec(strict)?.[1] ?? "";
  expect(images.split(" ").slice(0, 3)).toEqual(["'self'", "data:", "blob:"]);
  expect(strict).toBe(policy(images));
  expect(strict).not.toContain("unsafe-eval");
  expect(images).not.toContain("https:");
});

test("every screen carries it, and loads no inline script", async () => {
  for (const path of screens) {
    const response = await get(f, path, cookie);
    expect(`${path} ${response.status}`).toBe(`${path} 200`);
    expect(response.headers.get("content-security-policy")).toBe(strict);
    const inline: string[] = [];
    await new HTMLRewriter()
      .on("script", {
        element(element) {
          const type = element.getAttribute("type");
          if (!element.hasAttribute("src") && type !== "application/json") inline.push(path);
        },
      })
      .on("*", {
        element(element) {
          for (const [name] of element.attributes)
            if (/^on[a-z]+$/.test(name)) inline.push(`${path} ${element.tagName} ${name}`);
        },
      })
      .transform(response)
      .text();
    expect(inline).toEqual([]);
  }
});

test("pages outside the session check and error pages carry it", async () => {
  for (const [path, status, session] of [
    ["/admin/login", 200, ""],
    ["/admin/forgot", 200, ""],
    ["/admin/reset?token=missing", 400, ""],
    ["/admin/no-such-page", 404, cookie],
    ["/admin/lists/not-a-number", 400, cookie],
  ] as const) {
    const response = await get(f, path, session);
    expect([path, response.status]).toEqual([path, status]);
    expect(response.headers.get("content-type")).toStartWith("text/html");
    expect(response.headers.get("content-security-policy")).toBe(strict);
  }
});

test("remote images are allowed on the one screen that asks, for that response only", async () => {
  const asked = await get(f, "/admin/campaigns/1?remote_images=1", cookie);
  const header = asked.headers.get("content-security-policy") ?? "";
  expect(/img-src ([^;]+)/.exec(header)?.[1]).toEndWith(" http: https:");
  expect(header).not.toContain("unsafe-eval");
  expect(await asked.text()).toContain('"remote_images":true');
  const other = await get(f, "/admin/lists?remote_images=1", cookie);
  expect(other.headers.get("content-security-policy")).toBe(strict);
  const plain = await get(f, "/admin/campaigns/1", cookie);
  expect(plain.headers.get("content-security-policy")).toBe(strict);
  expect(await plain.text()).toContain('"remote_images":false');
});

test("assets and the session's custom files are not pages", async () => {
  const script = await get(f, "/admin/custom.js", cookie);
  expect(script.headers.get("content-type")).toStartWith("application/javascript");
  expect(script.headers.has("content-security-policy")).toBe(false);
});

// Attribute values as the browser reads them.
const decode = (value: string) =>
  value
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

interface Node {
  readonly type: string;
  readonly name?: string;
  readonly left?: Node;
  readonly argument?: Node;
  readonly object?: Node;
  readonly [child: string]: unknown;
}

/** What the CSP build refuses at run time rather than when it parses. */
function refused(node: Node, found: string[]): void {
  if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") {
    let target = node.left ?? node.argument;
    while (target?.type === "MemberExpression") target = target.object;
    if (target?.name?.startsWith("$")) found.push(`assigns through ${target.name}`);
  }
  if (node.type === "Identifier" && node.name && node.name in globalThis)
    found.push(`reads global ${node.name}`);
  for (const [key, child] of Object.entries(node)) {
    if (key === "property" && !node.computed) continue;
    if (key === "key") continue;
    for (const item of Array.isArray(child) ? child : [child])
      if (item && typeof item === "object") refused(item as Node, found);
  }
}

test("every rendered Alpine expression is one the CSP build can run", async () => {
  const seen = new Map<string, string>();
  const framed: string[] = [];
  for (const path of screens)
    await new HTMLRewriter()
      .on("*", {
        element(element) {
          for (const [name, value] of element.attributes) {
            if (!/^(x-|@|:)/.test(name) || /^x-(ref|cloak|ignore|transition)\b/.test(name)) continue;
            if (/^(iframe|script)$/.test(element.tagName)) framed.push(`${path} ${name}`);
            if (value) seen.set(`${name}\0${decode(value)}`, path);
          }
        },
      })
      .transform(await get(f, path, cookie))
      .text();
  expect(framed).toEqual([]);
  expect(seen.size).toBeGreaterThan(900);

  const failures: string[] = [];
  for (const [key, path] of seen) {
    const [name, value] = key.split("\0") as [string, string];
    const expression = name === "x-for" ? value.replace(/^.*?\s(?:in|of)\s/, "") : value;
    try {
      generateRuntimeFunction(expression);
      const found: string[] = [];
      refused(new Parser(new Tokenizer(expression).tokenize()).parse(), found);
      for (const reason of found) failures.push(`${path} ${name}="${value}": ${reason}`);
    } catch (error) {
      failures.push(`${path} ${name}="${value}": ${(error as Error).message}`);
    }
  }
  expect(failures).toEqual([]);
});
