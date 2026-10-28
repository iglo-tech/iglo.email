import { isDeepStrictEqual } from "node:util";
import { cases as corpus } from "@/test/contract/cases";
import type {
  ContractCase,
  ContractTarget,
  Credentials,
  Difference,
  ExpectedBody,
  VolatileField,
} from "@/test/contract/types";
import { rawRequest } from "@/test/server/raw-request";

const differences: Readonly<
  Record<Difference, { readonly cases: readonly string[]; readonly reason: string }>
> = {
  D17: {
    cases: ["positive-id-overflow", "users-positive-id-overflow"],
    reason:
      "reject unrepresentable IDs before storage; docs/design/07-api-and-ui.md and 09-decisions.md#d17-reject-positive-route-id-overflow-before-storage",
  },
  D18: {
    cases: ["encoded-dot", "encoded-dot-dot", "literal-backslash", "public-static-dot-escape"],
    reason:
      "Bun canonicalizes request paths before routing; docs/design/07-api-and-ui.md and 09-decisions.md#d18-use-buns-normalized-request-path",
  },
  D21: {
    cases: [
      "public-asset-head",
      "public-asset-post",
      "public-asset-options",
      "missing-public-asset-head",
    ],
    reason:
      "metadata-only HEAD for embedded assets and matching Allow; docs/design/07-api-and-ui.md and 09-decisions.md#d21-support-head-for-embedded-assets",
  },
};

export interface ContractReport {
  readonly passed: boolean;
  readonly lines: readonly string[];
}

export function validateTarget(target: ContractTarget): void {
  const validProfile =
    (target.mode === "reference" &&
      target.target === "upstream" &&
      ["all", "core", "staged"].includes(target.profile)) ||
    (target.mode === "normal" && target.target === "production" && target.profile === "core") ||
    (target.mode === "normal" &&
      target.target === "fixture" &&
      ["staged", "probe"].includes(target.profile));
  if (!validProfile) throw new Error("Unsupported mode, target, or profile combination");
  // Numeric loopback only: DNS, external services, credentials and URL paths are forbidden.
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}\/?$/.test(target.baseUrl))
    throw new Error(
      "Invalid base URL: use a loopback HTTP origin with an explicit port and no credentials or path",
    );
  let url: URL;
  try {
    url = new URL(target.baseUrl);
  } catch {
    throw new Error("Invalid base URL");
  }
  const match = /:([0-9]+)\/?$/.exec(target.baseUrl);
  const port = Number(match?.[1]);
  if (!url || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid loopback port");
  if (target.credentials) validateCredentials(target.credentials);
}

function validateCredentials(credentials: Credentials): void {
  if (
    !/^[A-Za-z0-9._-]{1,128}$/.test(credentials.user) ||
    !/^[A-Za-z0-9._-]{1,256}$/.test(credentials.token)
  ) {
    throw new Error("Invalid synthetic credentials");
  }
}

function validateCorpus(items: readonly ContractCase[], complete: boolean): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) || ids.has(item.id))
      throw new Error("Invalid or duplicate contract case ID");
    ids.add(item.id);
    for (const endpoint of [item.reference, item.production, item.fixture]) {
      const invalidCharacter =
        endpoint &&
        [...endpoint.path].some((character) => {
          const code = character.charCodeAt(0);
          return code <= 32 || code === 127 || character === "#";
        });
      if (
        endpoint &&
        (!endpoint.path.startsWith("/") ||
          endpoint.path.startsWith("//") ||
          endpoint.path.startsWith("/\\") ||
          invalidCharacter)
      ) {
        throw new Error("Invalid contract request target: expected an origin-form path");
      }
    }
    const prescribed = Object.entries(differences).find(([, metadata]) =>
      metadata.cases.includes(item.id),
    )?.[0];
    if (item.difference !== prescribed)
      throw new Error("Unknown, missing, duplicate, or orphaned deliberate-difference marker");
    if (item.difference && items !== corpus) {
      const canonical = corpus.find((entry) => entry.id === item.id);
      if (
        !canonical ||
        !isDeepStrictEqual(item.reference, canonical.reference) ||
        !isDeepStrictEqual(item.production, canonical.production) ||
        !isDeepStrictEqual(item.fixture, canonical.fixture)
      )
        throw new Error("Deliberate-difference expectations do not match the declared contract");
    }
    if (
      item.difference &&
      (!item.reference ||
        !item.fixture ||
        isDeepStrictEqual(item.reference.expect, item.fixture.expect))
    ) {
      throw new Error("Deliberate difference must declare distinct reference and fixture results");
    }
  }
  if (complete) {
    for (const metadata of Object.values(differences))
      for (const id of metadata.cases) {
        if (!ids.has(id)) throw new Error("Orphaned deliberate-difference metadata");
      }
  }
}

function selected(item: ContractCase, target: ContractTarget): boolean {
  if (target.profile === "all") return item.group !== "probe" && item.group !== "production-only";
  return (
    item.group === target.profile ||
    (target.target === "fixture" && item.fixtureGroup === target.profile) ||
    (target.target === "production" && item.group === "production-only")
  );
}

function redact(message: string, credentials?: Credentials): string {
  if (!credentials) return message;
  const pair = `${credentials.user}:${credentials.token}`;
  const encoded = Buffer.from(pair).toString("base64");
  const secrets = [
    credentials.user,
    credentials.token,
    pair,
    encoded,
    `Basic ${encoded}`,
    `token ${pair}`,
    "invalid-synthetic-token",
  ];
  let result = message;
  for (const value of secrets.sort((a, b) => b.length - a.length)) {
    if (value)
      for (const representation of [
        value,
        encodeURIComponent(value),
        JSON.stringify(value).slice(1, -1),
      ])
        result = result.replaceAll(representation, "[redacted]");
  }
  return result;
}

interface Binding {
  readonly kind: "id" | "timestamp";
  readonly value: number | string;
}
function normalize(
  value: unknown,
  fields: readonly VolatileField[],
  bindings: Map<string, Binding>,
  numericTokens: WeakMap<object, Map<string, string>>,
): unknown {
  for (const field of fields) {
    if (!field.path.length || !/^[a-z][a-z0-9-]*$/.test(field.bind))
      throw new Error("Invalid volatile field declaration");
    let parent: unknown = value;
    for (const component of field.path.slice(0, -1)) {
      if (typeof parent !== "object" || parent === null || !Object.hasOwn(parent, component))
        throw new Error(`Missing volatile field ${field.path.join(".")}`);
      parent = (parent as Record<string, unknown>)[component];
    }
    const key = field.path.at(-1)!;
    if (typeof parent !== "object" || parent === null || !Object.hasOwn(parent, key))
      throw new Error(`Missing volatile field ${field.path.join(".")}`);
    const object = parent as Record<string, unknown>;
    const original = object[key];
    if (field.kind === "id") {
      const token = numericTokens.get(parent)?.get(key);
      if (
        typeof original !== "number" ||
        !Number.isSafeInteger(original) ||
        original < 1 ||
        !token ||
        !/^[1-9][0-9]*$/.test(token) ||
        BigInt(token) > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw new Error(`Invalid or unsafe ID at ${field.path.join(".")}`);
    } else if (field.kind === "timestamp") {
      if (
        typeof original !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(original) ||
        Number.isNaN(Date.parse(original)) ||
        new Date(original).toISOString() !== original
      )
        throw new Error(`Invalid timestamp at ${field.path.join(".")}`);
    } else throw new Error("Unknown volatile field type");
    const previous = bindings.get(field.bind);
    if (field.requireBound && !previous)
      throw new Error(`${field.kind} ${field.bind} requires an existing binding`);
    if (previous && (previous.kind !== field.kind || previous.value !== original))
      throw new Error(`Inconsistent ${field.kind} binding ${field.bind}`);
    if (
      !previous &&
      field.kind === "id" &&
      [...bindings.values()].some((entry) => entry.kind === "id" && entry.value === original)
    )
      throw new Error(`Distinct ID binding ${field.bind} reused another entity`);
    if (field.after) {
      const earlier = bindings.get(field.after);
      if (
        field.kind !== "timestamp" ||
        !earlier ||
        earlier.kind !== "timestamp" ||
        Date.parse(original as string) <= Date.parse(earlier.value as string)
      )
        throw new Error(`Timestamp ${field.bind} is not after ${field.after}`);
    }
    bindings.set(field.bind, { kind: field.kind, value: original as number | string });
    object[key] = `<${field.kind}:${field.bind}>`;
  }
  return value;
}

async function comparePublic404(
  actual: string,
  expected: Extract<ExpectedBody, { kind: "public-404" }>,
): Promise<void> {
  const counts: Record<string, number> = Object.create(null);
  let title = "",
    heading = "",
    footer = "",
    message = "";
  let styleVersion = "",
    logoVersion = "",
    iconVersion = "";
  const count = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
  };
  const version = (value: string | null, path: string): string => {
    const match = value?.match(new RegExp(`^${path.replaceAll(".", "\\.")}\\?v=([a-f0-9]{10})$`));
    if (!match) throw new Error(`Invalid versioned ${path}`);
    return match[1]!;
  };
  // This is the specified default 404 page, not an arbitrary HTML sanitizer.
  const attributes: Readonly<Record<string, readonly string[]>> = {
    html: [],
    head: [],
    body: [],
    title: [],
    h2: [],
    meta: ["http-equiv", "content", "name"],
    link: ["href", "rel", "type", "title"],
    div: ["class"],
    header: ["class"],
    footer: ["class"],
    img: ["src", "alt"],
    a: ["href", "target", "rel"],
    script: ["src", "async", "defer"],
  };
  const classes: Readonly<Record<string, readonly string[]>> = {
    div: ["container", "wrap", "logo"],
    header: ["header"],
    footer: ["container"],
  };
  // HTMLRewriter exposes tokens without a browser's tree-repair step. Validate
  // every token's parent instead of letting selectors silently skip misplaced
  // content that a browser would move into the visible document.
  const stack: { tag: string; role: string; text: string }[] = [];
  let headClosed = false,
    bodyClosed = false,
    documentClosed = false;
  const parents: Readonly<Record<string, string>> = {
    html: "document",
    head: "html",
    body: "html",
    title: "head",
    meta: "head",
    link: "head",
    script: "head",
    header: "wrap",
    h2: "wrap",
    footer: "body",
  };
  const voidTags = new Set(["meta", "link", "img"]);
  const rewriter = new HTMLRewriter()
    .onDocument({
      doctype(node) {
        if (node.name !== "html" || stack.length || counts.html || documentClosed)
          throw new Error("Invalid doctype");
        count("doctype");
      },
      text(chunk) {
        const current = stack.at(-1);
        if (current?.role === "footer-link") current.text += chunk.text;
        if (
          chunk.text.trim() &&
          !["title", "h2", "message", "footer", "footer-link"].includes(current?.role ?? "")
        )
          throw new Error("Unexpected public page text");
      },
    })
    .on("*", {
      element(element) {
        if (!Object.hasOwn(attributes, element.tagName)) throw new Error("Unexpected HTML element");
        const tag = element.tagName;
        const parent = stack.at(-1)?.role ?? "document";
        let role = tag;
        let requiredParent = parents[tag];
        if (tag === "div") {
          const names = element.getAttribute("class")?.split(/\s+/) ?? [];
          if (names.includes("wrap")) {
            role = "wrap";
            requiredParent = "body";
          } else if (names.includes("logo")) {
            role = "logo";
            requiredParent = "header";
          } else if (!names.length) {
            role = "message";
            requiredParent = "wrap";
          }
        } else if (tag === "img") {
          requiredParent = expected.customScript ? "logo-link" : "logo";
        } else if (tag === "a") {
          if (parent === "footer") {
            role = "footer-link";
            requiredParent = "footer";
            const link = expected.footerLinks[counts.footerLinks ?? 0];
            if (!link || element.getAttribute("href") !== link.href)
              throw new Error("Unexpected footer link");
            count("footerLinks");
          } else if (expected.customScript) {
            role = "logo-link";
            requiredParent = "logo";
            const href = element.getAttribute("href");
            if (href !== "") {
              const url = new URL(href ?? "");
              if (
                url.protocol !== "http:" ||
                url.hostname !== "127.0.0.1" ||
                !url.port ||
                url.pathname !== "/subscription/form" ||
                url.search ||
                url.hash
              )
                throw new Error("Unexpected logo link");
            }
            count("logoLink");
          }
        }
        if (
          requiredParent !== parent ||
          bodyClosed ||
          documentClosed ||
          (tag === "html" && counts.doctype !== 1) ||
          (tag === "body" && !headClosed)
        )
          throw new Error("Unexpected public page element placement");
        if (!voidTags.has(tag)) {
          const entry = { tag, role, text: "" };
          const footerLink =
            role === "footer-link" ? expected.footerLinks[counts.footerLinks! - 1] : null;
          stack.push(entry);
          element.onEndTag(() => {
            if (stack.pop() !== entry) throw new Error("Unclosed public page element");
            if (footerLink && entry.text.trim() !== footerLink.text)
              throw new Error("Wrong footer link text");
            if (tag === "head") headClosed = true;
            if (tag === "body") bodyClosed = true;
            if (tag === "html") documentClosed = true;
          });
        }
        if (element.tagName === "h2") count("allHeadings");
        for (const [name, value] of element.attributes) {
          if (!attributes[element.tagName]!.includes(name))
            throw new Error(`Unexpected HTML attribute ${element.tagName}.${name}`);
          if (
            name === "class" &&
            value.split(/\s+/).some((value) => !classes[element.tagName]?.includes(value))
          )
            throw new Error("Unexpected HTML class");
          if (name === "href" || name === "src") {
            // These fixed URLs contain neither character references nor raw
            // control characters. HTMLRewriter exposes attribute spellings,
            // not browser-decoded values, so reject unsupported encodings.
            if (
              [...value].some(
                (character) =>
                  character === "&" ||
                  character.charCodeAt(0) <= 32 ||
                  character.charCodeAt(0) === 127,
              )
            )
              throw new Error("Unsupported encoded HTML URL");
            // WHATWG URL parsing removes embedded ASCII tabs/newlines just as
            // a browser does; a literal scheme-prefix regex misses those URLs.
            const url = new URL(value, "http://127.0.0.1/");
            if (url.protocol !== "http:" && url.protocol !== "https:")
              throw new Error("Unsafe HTML URL");
          }
        }
        if (element.tagName === "meta") {
          const kind = element.getAttribute("http-equiv")?.toLowerCase();
          const name = element.getAttribute("name");
          const content = element.getAttribute("content");
          if (
            !(kind === "content-type" && content?.toLowerCase() === "text/html; charset=utf-8") &&
            !(name === "description" && content === "") &&
            !(
              name === "viewport" &&
              content === "width=device-width, initial-scale=1, minimum-scale=1"
            )
          )
            throw new Error("Unexpected public metadata");
        }
      },
    })
    .on("html", {
      element() {
        count("html");
      },
    })
    .on("head", {
      element() {
        count("head");
      },
    })
    .on("body", {
      element() {
        count("body");
      },
    })
    .on("head title", {
      element() {
        count("title");
      },
      text(chunk) {
        title += chunk.text;
      },
    })
    .on("body > .wrap", {
      element(element) {
        count("wrap");
        if (
          element
            .getAttribute("class")
            ?.split(/\s+/)
            .some((name) => name !== "wrap" && name !== "container")
        )
          throw new Error("Unexpected page wrapper class");
      },
    })
    .on("body > .wrap > header", {
      element() {
        count("header");
      },
    })
    .on("body > .wrap > header .logo", {
      element() {
        count("logo");
      },
    })
    .on("body > .wrap > h2", {
      element() {
        count("heading");
      },
      text(chunk) {
        heading += chunk.text;
      },
    })
    .on("body > .wrap > div", {
      element() {
        count("message");
      },
      text(chunk) {
        message += chunk.text;
      },
    })
    .on("body link, body script", {
      element() {
        throw new Error("Unexpected body asset");
      },
    })
    .on("link", {
      element(element) {
        const relation = element.getAttribute("rel");
        const href = element.getAttribute("href");
        if (relation === "icon") {
          count("icon");
          iconVersion = version(href, "/public/static/favicon.png");
        } else if (relation === "stylesheet" && href?.startsWith("/public/static/style.css")) {
          count("style");
          styleVersion = version(href, "/public/static/style.css");
        } else if (
          relation === "stylesheet" &&
          expected.customScript &&
          /^\/public\/custom\.css\?v=[a-f0-9]{10}$/.test(href ?? "")
        ) {
          count("customStyle");
        } else if (relation === "alternate" && expected.archiveTitle) {
          const url = new URL(href ?? "");
          if (
            element.getAttribute("type") !== "application/rss+xml" ||
            element.getAttribute("title") !== expected.archiveTitle ||
            url.protocol !== "http:" ||
            url.hostname !== "127.0.0.1" ||
            !url.port ||
            url.pathname !== "/archive.xml" ||
            url.search ||
            url.hash
          )
            throw new Error("Unexpected archive metadata");
          count("archive");
        } else {
          throw new Error("Unexpected public stylesheet");
        }
      },
    })
    .on("img", {
      element(element) {
        count("images");
        logoVersion = version(element.getAttribute("src"), "/public/static/logo.svg");
        const alt = expected.customScript ? "404 - Not found" : expected.siteName;
        if (element.getAttribute("alt") !== alt) throw new Error("Wrong logo context");
      },
    })
    .on("body > footer", {
      element() {
        count("footer");
      },
      text(chunk) {
        footer += chunk.text;
      },
    })
    .on("script", {
      element(element) {
        count("script");
        if (
          !expected.customScript ||
          !/^\/public\/custom\.js\?v=[a-f0-9]{10}$/.test(element.getAttribute("src") ?? "")
        )
          throw new Error("Unexpected script");
      },
    });
  await rewriter.transform(new Response(actual)).text();
  if (stack.length || !bodyClosed || !documentClosed)
    throw new Error("Unclosed public page document");
  for (const name of [
    "doctype",
    "html",
    "head",
    "body",
    "title",
    "heading",
    "allHeadings",
    "wrap",
    "header",
    "logo",
    "message",
    "style",
    "icon",
    "images",
    "footer",
  ]) {
    if (counts[name] !== 1) throw new Error(`Expected exactly one ${name}`);
  }
  if ((counts.script ?? 0) !== (expected.customScript ? 1 : 0))
    throw new Error("Wrong script count");
  if (
    counts.footerLinks !== expected.footerLinks.length ||
    (counts.logoLink ?? 0) !== (expected.customScript ? 1 : 0)
  )
    throw new Error("Wrong public link count");
  if (
    (counts.customStyle ?? 0) !== (expected.customScript ? 1 : 0) ||
    (counts.archive ?? 0) !== (expected.archiveTitle ? 1 : 0)
  )
    throw new Error("Wrong reference-only asset count");
  if (title !== `404 - Not found - ${expected.siteName}` || heading !== "404 - Not found")
    throw new Error("Wrong public 404 title or heading");
  if (message.trim() !== "" || footer.replace(/\s+/g, " ").trim() !== expected.footerText)
    throw new Error("Wrong public 404 message or attribution");
  if (styleVersion !== logoVersion || styleVersion !== iconVersion)
    throw new Error("Inconsistent asset versions");
}

async function compareBody(
  actual: string,
  expected: ExpectedBody,
  bindings: Map<string, Binding>,
): Promise<void> {
  if (expected.kind === "public-404") return comparePublic404(actual, expected);
  if (expected.kind === "public-css") {
    if (actual.length < 100 || !actual.includes("box-sizing"))
      throw new Error("Invalid public stylesheet");
    return;
  }
  if (expected.kind === "wire") {
    if (actual !== expected.value)
      throw new Error(`body ${JSON.stringify(actual)}; expected ${JSON.stringify(expected.value)}`);
    return;
  }
  if (!actual.endsWith("\n") || actual.endsWith("\n\n"))
    throw new Error("JSON response must end with exactly one newline");
  let value: unknown;
  // Preserve the original JSON number token so a rounded value cannot masquerade
  // as a safe integer after parsing. Other fields retain their original values.
  const numericTokens = new WeakMap<object, Map<string, string>>();
  try {
    const parse = JSON.parse as (
      text: string,
      reviver: (
        this: object,
        key: string,
        entry: unknown,
        context?: { source?: string },
      ) => unknown,
    ) => unknown;
    value = parse(actual, function (key, entry, context) {
      if (typeof entry === "number" && context?.source) {
        let tokens = numericTokens.get(this);
        if (!tokens) {
          tokens = new Map();
          numericTokens.set(this, tokens);
        }
        tokens.set(key, context.source);
      }
      return entry;
    });
  } catch {
    throw new Error("Invalid JSON response");
  }
  const normalized = normalize(value, expected.volatile, bindings, numericTokens);
  if (!isDeepStrictEqual(normalized, expected.value))
    throw new Error(
      `JSON body ${JSON.stringify(normalized)}; expected ${JSON.stringify(expected.value)}`,
    );
}

export async function runContract(
  target: ContractTarget,
  options: { readonly caseId?: string; readonly cases?: readonly ContractCase[] } = {},
): Promise<ContractReport> {
  validateTarget(target);
  const items = options.cases ?? corpus;
  validateCorpus(items, options.cases === undefined);
  const filtered = items.filter((item) => selected(item, target));
  const selectedCases =
    options.caseId === undefined ? filtered : filtered.filter((item) => item.id === options.caseId);
  if (!selectedCases.length)
    throw new Error("Unsupported or unknown case for the selected target/profile");
  for (const item of selectedCases) {
    if (!item[target.target === "upstream" ? "reference" : target.target])
      throw new Error("Unsupported case for the selected target/profile");
    if (item.auth && !target.credentials)
      throw new Error("Synthetic credentials are required for the selected cases");
  }
  const lines = [`mode=${target.mode} target=${target.target} profile=${target.profile}`];
  const bindings = new Map<string, Binding>();
  let failures = 0;
  for (const item of selectedCases) {
    target.signal?.throwIfAborted();
    const endpoint = item[target.target === "upstream" ? "reference" : target.target]!;
    const marker = item.difference
      ? ` [${item.difference}: ${differences[item.difference].reason}]`
      : "";
    const headers: Record<string, string> = {};
    if (item.auth) {
      const credentials = target.credentials!;
      const token = item.auth === "bad-token" ? "invalid-synthetic-token" : credentials.token;
      headers.Authorization =
        item.auth === "basic"
          ? `Basic ${Buffer.from(`${credentials.user}:${token}`).toString("base64")}`
          : `token ${credentials.user}:${token}`;
    }
    if (item.requestContentType) headers["Content-Type"] = item.requestContentType;
    try {
      const actual = await rawRequest(target.baseUrl, endpoint.path, {
        method: item.method ?? "GET",
        headers,
        ...(endpoint.expect.headers
          ? { responseHeaders: Object.keys(endpoint.expect.headers) }
          : {}),
        ...(item.requestBody === undefined ? {} : { body: item.requestBody }),
        ...(target.signal ? { signal: target.signal } : {}),
      });
      if (
        actual.status !== endpoint.expect.status ||
        actual.contentType !== endpoint.expect.contentType
      )
        throw new Error(
          `status/content-type ${actual.status} ${actual.contentType}; expected ${endpoint.expect.status} ${endpoint.expect.contentType}; body ${JSON.stringify(actual.body)}`,
        );
      for (const [name, expected] of Object.entries(endpoint.expect.headers ?? {})) {
        if (actual.headers?.[name.toLowerCase()] !== expected)
          throw new Error(
            `header ${name}: ${JSON.stringify(actual.headers?.[name.toLowerCase()])}; expected ${JSON.stringify(expected)}`,
          );
      }
      const caseBindings = new Map(bindings);
      await compareBody(actual.body, endpoint.expect.body, caseBindings);
      bindings.clear();
      for (const [name, binding] of caseBindings) bindings.set(name, binding);
      lines.push(`PASS ${item.id}${marker}`);
    } catch (error) {
      target.signal?.throwIfAborted();
      failures++;
      lines.push(
        `FAIL ${item.id}${marker}: ${redact(error instanceof Error ? error.message : "request failed", target.credentials).slice(0, 1200)}`,
      );
    }
  }
  if (target.profile === "probe")
    lines.push("NOTE synthetic harness probe; no upstream domain or production coverage");
  if (target.target === "fixture")
    lines.push("NOTE synthetic helper routes; production lists run separately");
  lines.push(`RESULT ${selectedCases.length - failures} passed, ${failures} failed`);
  return { passed: failures === 0, lines };
}
