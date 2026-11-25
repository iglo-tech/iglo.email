// Native (15-external-sources section 2, D170): the project's source settings (`source.*`) and the
// instance's `sources.private_hosts`. src/settings/validate.ts binds them with the shapes below and
// calls the normalizers here on each save; the adapter reads them through `sourceConfig`.
import { HttpError } from "@/server/response";
import type { Settings } from "@/settings/validate";
import { identifierPattern } from "@/sources/filter";
import { isSourceList, isSourceObject, member, sourceJson } from "@/sources/json";
import type { SourceJson } from "@/sources/json";
import type { PocketBaseConfig } from "@/sources/pocketbase";
import type { SourceScalar } from "@/sources/source";

/** The `source.*` keys and their defaults: no source (an empty URL). */
export const sourceDefaults = {
  "source.url": "",
  "source.auth_collection": "services",
  "source.identity": "",
  "source.password": "",
  "source.events": {
    collection: "events",
    user: "user",
    name: "name",
    data: "data",
    occurred_at: "occurredAt",
    key: "",
  },
  "source.recipients": { collection: "recipients", email: "email", name: "name", opt_out: "" },
  "source.users": { collection: "", leaving_filter: "" },
  "source.grant_lists": [] as Array<GrantRule>,
};

/** "An event named `event` whose data matches `where` grants the lists `lists`" (spec section 2). */
export interface GrantRule {
  event: string;
  /** `data.<path>` equalities, compared strictly. */
  where: Record<string, SourceScalar>;
  lists: Array<number>;
}

/** Binds a JSON scalar (text, finite number or boolean) in a settings shape. */
export const scalarShape = Symbol("scalar");
export const grantRuleShape = { event: "", where: { "*": scalarShape }, lists: [0] };

export const MAX_GRANT_RULES = 50;
const MAX_GRANT_LISTS = 100;
const MAX_WHERE = 8;
const MAX_PATH_SEGMENTS = 8;
const MAX_EVENT_BYTES = 200;
const MAX_VALUE_BYTES = 1000;
const MAX_PRIVATE_HOSTS = 20;
const MAX_FILTER = 2000;
const hostLabel = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;
const ipLiteral = /^[\d.]+$|:/;

const fail = (message: string): never => {
  throw new HttpError(400, message);
};
const text = (value: SourceJson | undefined) => (typeof value === "string" ? value.trim() : "");
const bytes = (value: string) => Buffer.byteLength(value, "utf-8");
const masked = (value: string) => /^•+$/.test(value);
const control = (character: string) => (character.codePointAt(0) ?? 0) < 0x20;
/** One settings value, read through the JSON boundary (a settings record is `any` per key). */
const read = (settings: Settings, key: string): SourceJson | undefined => sourceJson(settings[key]);
const textAt = (settings: Settings, key: string) => {
  const value = read(settings, key);
  return typeof value === "string" ? value : "";
};

/** A collection or field name, or "" where `optional`; a required empty one takes its default. */
function nameField(
  value: SourceJson | undefined,
  fallback: string,
  label: string,
  optional = false,
): string {
  const name = text(value) || (optional ? "" : fallback);
  if (name && !identifierPattern.test(name)) {
    fail(`Invalid ${label}: use a PocketBase name (letters, digits and _).`);
  }
  return name;
}

/** The URL's origin and path as stored: http(s), no credentials, query or fragment. */
function sourceUrl(value: SourceJson | undefined): string {
  const raw = text(value);
  if (!raw) {
    return "";
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("Invalid source.url: use the PocketBase address, such as http://pocketbase:8090.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    raw.length > 2000
  ) {
    fail("Invalid source.url: use an http or https address without credentials or a query.");
  }
  return url.href.replace(/\/+$/, "");
}

/** The same server for a stored password: scheme, host, port and path. */
const sameServer = (a: string, b: string) => a !== "" && a === b;

const scalar = (value: SourceJson): value is SourceScalar =>
  typeof value === "string" || typeof value === "boolean" || typeof value === "number";

function grantRule(rule: SourceJson, index: number): GrantRule {
  const label = `source.grant_lists ${index + 1}`;
  const event = text(member(rule, "event"));
  if (!event || bytes(event) > MAX_EVENT_BYTES || Array.from(event).some(control)) {
    fail(`Invalid ${label}: name the event (at most ${MAX_EVENT_BYTES} bytes).`);
  }
  const where: Record<string, SourceScalar> = {};
  const condition = member(rule, "where");
  const entries = isSourceObject(condition) ? Object.entries(condition) : [];
  if (entries.length > MAX_WHERE) {
    fail(`Invalid ${label}: at most ${MAX_WHERE} data fields.`);
  }
  for (const [key, value] of entries) {
    const segments = key.startsWith("data.") ? key.slice(5).split(".") : [];
    if (
      !segments.length ||
      segments.length > MAX_PATH_SEGMENTS ||
      !segments.every((part) => /^[A-Za-z0-9_]{1,64}$/.test(part))
    ) {
      fail(`Invalid ${label}: a field is data.<name> (letters, digits and _), got ${key}.`);
    }
    if (!scalar(value)) {
      return fail(`Invalid ${label}: a value is text, a number or true/false.`);
    }
    if (typeof value === "string" && bytes(value) > MAX_VALUE_BYTES) {
      fail(`Invalid ${label}: a value is at most ${MAX_VALUE_BYTES} bytes.`);
    }
    Object.defineProperty(where, key, { value, enumerable: true, writable: true });
  }
  const lists: Array<number> = [];
  const ids = member(rule, "lists");
  for (const id of isSourceList(ids) ? ids : []) {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      return fail(`Invalid ${label}: a list is a list ID.`);
    }
    if (!lists.includes(id)) {
      lists.push(id);
    }
  }
  if (!lists.length || lists.length > MAX_GRANT_LISTS) {
    fail(`Invalid ${label}: name 1 to ${MAX_GRANT_LISTS} lists.`);
  }
  return { event, where, lists };
}

/**
 * Checks and normalizes the `source.*` keys of a project save. A blank password, or the mask a
 * GET served, keeps the stored one only while the URL and the identity stay the same: a stored
 * password is never sent to a server it was not entered for. An empty URL turns the source off and
 * clears the password.
 */
export function normalizeSource(next: Settings, current: Settings): void {
  const url = sourceUrl(read(next, "source.url"));
  next["source.url"] = url;
  next["source.auth_collection"] = nameField(
    read(next, "source.auth_collection"),
    sourceDefaults["source.auth_collection"],
    "source.auth_collection",
  );
  const identity = text(read(next, "source.identity"));
  if (bytes(identity) > 255) {
    fail("Invalid source.identity: at most 255 bytes.");
  }
  next["source.identity"] = identity;
  let password = textAt(next, "source.password");
  if (!password || masked(password)) {
    password =
      sameServer(url, textAt(current, "source.url")) &&
      identity === textAt(current, "source.identity")
        ? textAt(current, "source.password")
        : "";
  }
  if (bytes(password) > 1000 || password.includes("\0")) {
    fail("Invalid source.password: at most 1000 bytes.");
  }
  if (!url) {
    password = "";
  } else if (!identity || !password) {
    fail(
      "source.identity and source.password are required with source.url; enter the password again when the URL or identity changes.",
    );
  }
  next["source.password"] = password;
  const events = read(next, "source.events");
  const defaults = sourceDefaults["source.events"];
  next["source.events"] = {
    collection: nameField(
      member(events, "collection"),
      defaults.collection,
      "source.events collection",
    ),
    user: nameField(member(events, "user"), defaults.user, "source.events user field"),
    name: nameField(member(events, "name"), defaults.name, "source.events name field"),
    data: nameField(member(events, "data"), defaults.data, "source.events data field"),
    occurred_at: nameField(
      member(events, "occurred_at"),
      defaults.occurred_at,
      "source.events occurred_at field",
    ),
    key: nameField(member(events, "key"), "", "source.events key field", true),
  };
  const recipients = read(next, "source.recipients");
  const view = sourceDefaults["source.recipients"];
  next["source.recipients"] = {
    collection: nameField(
      member(recipients, "collection"),
      view.collection,
      "source.recipients collection",
    ),
    email: nameField(member(recipients, "email"), view.email, "source.recipients email field"),
    name: nameField(member(recipients, "name"), "", "source.recipients name field", true),
    opt_out: nameField(member(recipients, "opt_out"), "", "source.recipients opt_out field", true),
  };
  const users = read(next, "source.users");
  const collection = nameField(member(users, "collection"), "", "source.users collection", true);
  const filter = text(member(users, "leaving_filter"));
  if (filter.length > MAX_FILTER || filter.includes("\0")) {
    fail(`Invalid source.users leaving_filter: at most ${MAX_FILTER} characters.`);
  }
  if (collection && !filter) {
    fail("source.users needs a leaving_filter with its collection, such as deletedAt != ''.");
  }
  next["source.users"] = { collection, leaving_filter: collection ? filter : "" };
  const stored = read(next, "source.grant_lists");
  const rules = isSourceList(stored) ? stored : [];
  if (rules.length > MAX_GRANT_RULES) {
    fail(`Invalid source.grant_lists: at most ${MAX_GRANT_RULES} rules.`);
  }
  next["source.grant_lists"] = rules.map(grantRule);
}

/** The list IDs the grant rules name, for the check that they are this project's lists. */
export function grantedListIds(settings: Settings): Array<number> {
  const rules = read(settings, "source.grant_lists");
  const ids = new Set<number>();
  for (const rule of isSourceList(rules) ? rules : []) {
    const lists = member(rule, "lists");
    for (const id of isSourceList(lists) ? lists : []) {
      if (typeof id === "number") {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

/** Checks and normalizes `sources.private_hosts` (instance key): exact host names, lower case. */
export function normalizePrivateHosts(settings: Settings): Array<string> {
  const value = read(settings, "sources.private_hosts");
  const hosts: Array<string> = [];
  for (const raw of isSourceList(value) ? value : []) {
    const host = text(raw).toLowerCase();
    if (!host) {
      continue;
    }
    if (
      ipLiteral.test(host) ||
      host.length > 253 ||
      !host.split(".").every((label) => hostLabel.test(label))
    ) {
      fail(
        `Invalid sources.private_hosts: ${host} is not a host name (exact names only, no addresses or wildcards).`,
      );
    }
    if (!hosts.includes(host)) {
      hosts.push(host);
    }
  }
  if (hosts.length > MAX_PRIVATE_HOSTS) {
    fail(`Invalid sources.private_hosts: at most ${MAX_PRIVATE_HOSTS} host names.`);
  }
  return hosts;
}

/** The instance's private source hosts, as the guard reads them. */
export function privateHosts(settings: Settings): Array<string> {
  const hosts = read(settings, "sources.private_hosts");
  return isSourceList(hosts) ? hosts.filter((host) => typeof host === "string") : [];
}

const at = (value: SourceJson | undefined, name: string) => text(member(value, name));

/** The adapter's settings, or `null` while the project has no source (an empty URL). */
export function sourceConfig(settings: Settings): PocketBaseConfig | null {
  const url = textAt(settings, "source.url");
  if (!url) {
    return null;
  }
  const events = read(settings, "source.events");
  const recipients = read(settings, "source.recipients");
  const users = read(settings, "source.users");
  return {
    url,
    authCollection: textAt(settings, "source.auth_collection"),
    identity: textAt(settings, "source.identity"),
    password: textAt(settings, "source.password"),
    events: {
      collection: at(events, "collection"),
      user: at(events, "user"),
      name: at(events, "name"),
      data: at(events, "data"),
      occurredAt: at(events, "occurred_at"),
      key: at(events, "key"),
    },
    recipients: {
      collection: at(recipients, "collection"),
      email: at(recipients, "email"),
      name: at(recipients, "name"),
      optOut: at(recipients, "opt_out"),
    },
    users: { collection: at(users, "collection"), leavingFilter: at(users, "leaving_filter") },
  };
}
