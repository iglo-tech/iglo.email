// B139 (D154): the contract corpora's way to settings across the split. Upstream has one settings
// API, and the shared cases keep calling it there. On iglo.email a project host serves the project keys
// on /api/settings, and the instance keys are on /api/instance/settings with the instance admin's
// session (14-projects section 4). `settingsRouter` gives a corpus one fetch for both: against
// upstream it is plain fetch; on iglo.email it sends each settings call to the side its keys belong
// to, so a corpus that changes SMTP, bounce processing or the private-target block keeps its cases.
//
// - `GET /api/settings`: both sides, merged in the order one table served them before the split.
// - `PUT /api/settings` (JSON): the project keys to the project, then, if that was accepted, the
//   instance keys to the instance. When the instance refuses its half, the harness puts the project
//   half back as it read it, so a refused body changes nothing, as one request did.
// - `PUT /api/settings/<key>`: to the key's side; an instance key goes on to the instance only after
//   the project refused it as one, so a caller without the permission keeps its 401 or 403.
// - Every other call is sent unchanged.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaults } from "@/settings/defaults";
import { instanceKeys } from "@/settings/keys";
import { xmlNames } from "@/settings/xml-names";
import type { Mode } from "@/test/contract/types";
import { asBody } from "@/test/read-body";
import { instanceClient } from "@/test/settings/instance-client";
import type { InstanceClient } from "@/test/settings/instance-client";

const repository = resolve(import.meta.dir, "../..");

/** The admin of an owned contract run (test/users/fixtures.md), as cli.ts starts it. */
export async function contractAdmin(): Promise<{ user: string; password: string }> {
  const text = await readFile(resolve(repository, "test/users/fixtures.md"), "utf-8");
  const user = /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(text)?.[1];
  const password = /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(text)?.[1];
  if (!user || !password) {
    throw new Error("Synthetic production bootstrap credentials are missing");
  }
  return { user, password };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const raw = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

/** The members in the order one settings table served them (defaults order, the root URL last). */
function merged(
  project: Array<{ name: string; text: string }>,
  instance: Array<{ name: string; text: string }>,
): Array<string> {
  const all = [...project, ...instance];
  const order = Object.keys(defaults);
  const rank = (name: string) => (order.includes(name) ? order.indexOf(name) : order.length);
  return all
    .map((member, index) => ({ member, index }))
    .toSorted((a, b) => rank(a.member.name) - rank(b.member.name) || a.index - b.index)
    .map(({ member }) => member.text);
}

/**
 * An XML full write split by its top-level elements: the ones whose name binds an instance key, and
 * the rest, which keeps whatever follows the root element (upstream ignores it). The text is the
 * body's bytes as Latin-1, so a byte that is no UTF-8 goes through unchanged. Undefined when the
 * body is not one `<Settings>` element the split can read.
 */
function splitXml(text: string): { own: string; other: string } | undefined {
  // The prolog (declaration, doctype, comments, space) goes before each half's root.
  const open = /^((?:\s|<\?[^>]*\?>|<![^>]*>)*)<Settings>/.exec(text);
  const close = text.indexOf("</Settings>");
  if (!open || close < open[0].length) {
    return undefined;
  }
  const suffix = text.slice(close + "</Settings>".length);
  const inner = text.slice(open[0].length, close);
  const own: Array<string> = [];
  const other: Array<string> = [];
  let index = 0;
  while (index < inner.length) {
    const start = inner.indexOf("<", index);
    if (start === -1) {
      break;
    }
    const name = /^<([A-Za-z_][\w.-]*)/.exec(inner.slice(start))?.[1];
    if (!name) {
      return undefined;
    }
    // The element ends where its depth returns to zero; a self-closing tag ends at once.
    let depth = 0;
    let cursor = start;
    let end = -1;
    const tag = /<(\/?)([A-Za-z_][\w.-]*)[^>]*?(\/?)>/g;
    tag.lastIndex = cursor;
    for (let match = tag.exec(inner); match; match = tag.exec(inner)) {
      depth += match[1] ? -1 : match[3] ? 0 : 1;
      cursor = tag.lastIndex;
      if (depth === 0) {
        end = cursor;
        break;
      }
    }
    if (end === -1) {
      return undefined;
    }
    const key = xmlNames.get(name);
    (key && instanceKeys.has(key) ? other : own).push(inner.slice(start, end));
    index = end;
  }
  const prefix = open[1] ?? "";
  return {
    own: `${prefix}<Settings>${own.join("")}</Settings>${suffix}`,
    other: `${prefix}<Settings>${other.join("")}</Settings>`,
  };
}

/**
 * A JSON object's top-level members as written, each with its decoded name: duplicates and their
 * order are kept, since the binding reads them in order, and a number keeps its digits. Undefined
 * for text that is not one JSON object.
 */
function jsonMembers(text: string): Array<{ name: string; text: string }> | undefined {
  const body = text.trim();
  if (!body.startsWith("{") || !body.endsWith("}")) {
    return undefined;
  }
  try {
    JSON.parse(body);
  } catch {
    return undefined;
  }
  const members: Array<string> = [];
  let depth = 0;
  let quoted = false;
  let start = 1;
  for (let index = 1; index < body.length - 1; index++) {
    const c = body[index];
    if (quoted) {
      if (c === "\\") {
        index++;
      } else if (c === '"') {
        quoted = false;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === "{" || c === "[") {
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
    } else if (c === "," && depth === 0) {
      members.push(body.slice(start, index));
      start = index + 1;
    }
  }
  const last = body.slice(start, -1);
  if (last.trim()) {
    members.push(last);
  }
  const out: Array<{ name: string; text: string }> = [];
  for (const member of members) {
    const name = /^\s*("(?:[^"\\]|\\.)*")\s*:/.exec(member)?.[1];
    if (name === undefined) {
      return undefined;
    }
    out.push({ name: asBody<string>(JSON.parse(name)), text: member });
  }
  return out;
}

/** A JSON object's text split into the members that name instance keys and the rest. */
function splitJson(text: string): { own: string; other: string } | undefined {
  const members = jsonMembers(text);
  if (!members) {
    return undefined;
  }
  const own = members.filter((member) => !instanceKeys.has(member.name));
  const other = members.filter((member) => instanceKeys.has(member.name));
  return {
    own: `{${own.map((member) => member.text).join(",")}}`,
    other: `{${other.map((member) => member.text).join(",")}}`,
  };
}

/** The `data` object's text of a `{"data":{…}}` answer. */
function dataText(text: string): string | undefined {
  return /^\{"data":(\{[\s\S]*\})\}$/.exec(text.trim())?.[1];
}

/** A read value as a save sends it back: a masked secret empty, which the API reads as "keep". */
function unmasked(value: unknown): unknown {
  if (typeof value === "string") {
    return /^•+$/.test(value) ? "" : value;
  }
  if (Array.isArray(value)) {
    return value.map(unmasked);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unmasked(item)]));
  }
  return value;
}

/**
 * A fetch for `target` that sends settings calls to their side on iglo.email. `send` is the fetch
 * the corpus used (settingsFetch keeps its reload handling); it defaults to the global fetch.
 */
export function settingsRouter(
  target: { mode: Mode; baseUrl: string },
  send: Fetch = (url, init) => fetch(url, init),
  admin?: { user: string; password: string },
): Fetch {
  if (target.mode === "reference") {
    return send;
  }
  let client: Promise<InstanceClient> | undefined;
  const session = async () => {
    client ??= (async () => instanceClient(target.baseUrl, admin ?? (await contractAdmin())))();
    return client;
  };
  /** An instance call; a session that ended (an admin password change) logs in again once. */
  const instance = async (path: string, method: string, body?: unknown) => {
    let response = await (await session()).call(path, method, body);
    if (response.status === 401) {
      client = undefined;
      response = await (await session()).call(path, method, body);
    }
    return response;
  };
  /** A raw-body instance PUT with the session, in `media`; a session that ended logs in again. */
  const instanceRaw = async (
    path: string,
    media: string,
    body: string | Uint8Array<ArrayBuffer>,
  ) => {
    const put = async () => {
      const { cookie, csrf } = (await session()).credentials();
      return send(`${target.baseUrl}${path}`, {
        method: "PUT",
        headers: { cookie, "x-csrf-token": csrf, "content-type": media },
        body,
      });
    };
    let response = await put();
    if (response.status === 401) {
      client = undefined;
      response = await put();
    }
    return response;
  };
  return async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const media = new Headers(init.headers).get("content-type")?.split(";", 1)[0]?.trim();
    if (pathname === "/api/settings" && method === "GET") {
      const project = await send(url, init);
      if (project.status !== 200) {
        return project;
      }
      const shared = await instance("/api/instance/settings", "GET");
      const own = jsonMembers(dataText(await project.text()) ?? "") ?? [];
      const other = jsonMembers(dataText(await shared.text()) ?? "") ?? [];
      return raw(200, `{"data":{${merged(own, other).join(",")}}}`);
    }
    if (
      pathname === "/api/settings" &&
      method === "PUT" &&
      (media === "application/json" || media === "application/xml" || media === "text/xml")
    ) {
      // Split as Latin-1 text of the body's bytes, so a byte that is no UTF-8 goes through as sent.
      const raw = init.body;
      const bytes =
        typeof raw === "string"
          ? Buffer.from(raw)
          : ArrayBuffer.isView(raw)
            ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
            : undefined;
      const text = bytes?.toString("latin1");
      const parts =
        text === undefined
          ? undefined
          : media === "application/json"
            ? splitJson(text)
            : splitXml(text);
      if (!parts) {
        return send(url, init);
      }
      const own = new Uint8Array(Buffer.from(parts.own, "latin1"));
      const other = new Uint8Array(Buffer.from(parts.other, "latin1"));
      // The project half as it is, to put back if the instance refuses its half.
      const read = await send(url, { method: "GET", headers: init.headers ?? {} });
      const previous =
        read.status === 200
          ? asBody<{ data: Record<string, unknown> }>(await read.json()).data
          : undefined;
      const project = await send(url, { ...init, body: own });
      if (project.status !== 200) {
        return project;
      }
      const shared = await instanceRaw("/api/instance/settings", media, other);
      if (shared.status !== 200 && previous) {
        const headers = new Headers(init.headers);
        headers.set("content-type", "application/json");
        await send(url, { ...init, headers, body: JSON.stringify(unmasked(previous)) });
      }
      return shared;
    }
    const key = pathname.startsWith("/api/settings/")
      ? decodeURIComponent(pathname.slice("/api/settings/".length))
      : "";
    if (method === "PUT" && instanceKeys.has(key)) {
      // The project answers first, so a caller without the permission still gets its 401 or 403;
      // only its refusal of the instance key sends the call on to the instance.
      const first = await send(url, init);
      if (first.status !== 400) {
        return first;
      }
      const put = async () => {
        const headers = new Headers(init.headers);
        headers.delete("authorization");
        const { cookie, csrf } = (await session()).credentials();
        headers.set("cookie", cookie);
        headers.set("x-csrf-token", csrf);
        return send(`${target.baseUrl}/api/instance/settings/${key}`, { ...init, headers });
      };
      let response = await put();
      if (response.status === 401) {
        client = undefined;
        response = await put();
      }
      return response;
    }
    return send(url, init);
  };
}

const routers = new WeakMap<object, Fetch>();
/**
 * The one router of a corpus run's `target` (one instance login per run): a target without a mode
 * is an owned run.
 */
export function routedFetch(target: { mode?: Mode; baseUrl: string }): Fetch {
  let router = routers.get(target);
  if (!router) {
    router = settingsRouter({ mode: target.mode ?? "normal", baseUrl: target.baseUrl });
    routers.set(target, router);
  }
  return router;
}
