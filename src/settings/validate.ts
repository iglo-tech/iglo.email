import { validTrustedURL } from "@/settings/url";
// Settings model and transformations adapted from listmonk models/settings.go and cmd/settings.go at 6fcd95f.
import { defaults } from "@/settings/defaults";
import { trimSpace } from "@/lists/store";
import { simpleLower } from "@/subscribers/unicode-lower";
import { validFromAddress } from "@/settings/mail";
import { goDuration, sessionDuration } from "@/settings/duration";
import { cronError } from "@/settings/cron";
import { cloneJson, int64, Members } from "@/settings/json";
import { HttpError } from "@/server/response";
import type { Roles } from "@/roles/roles";

export type Settings = Record<string, any>;
const fail = (message = "Invalid data."): never => {
  throw new HttpError(400, message);
};
const smtpShape = {
  name: "",
  uuid: "",
  enabled: false,
  host: "",
  hello_hostname: "",
  port: 0,
  auth_protocol: "",
  username: "",
  password: "",
  email_headers: [{ "*": "" }],
  max_conns: 0,
  max_msg_retries: 0,
  msg_retry_delay: "",
  idle_timeout: "",
  wait_timeout: "",
  tls_type: "",
  tls_skip_verify: false,
  from_addresses: [""],
  exclude_from_default: false,
};
const messengerShape = {
  uuid: "",
  enabled: false,
  name: "",
  root_url: "",
  username: "",
  password: "",
  max_conns: 0,
  timeout: "",
  max_msg_retries: 0,
};
const mailboxShape = {
  uuid: "",
  enabled: false,
  type: "",
  host: "",
  port: 0,
  auth_protocol: "",
  return_path: "",
  username: "",
  password: "",
  tls_enabled: false,
  tls_skip_verify: false,
  scan_interval: "",
};
const oidcRoleShape = { claim: "", match: "", user_role_id: null, list_role_id: null };
export const shapes: Record<string, unknown> = {
  ...defaults,
  smtp: [smtpShape],
  messengers: [messengerShape],
  "bounce.mailboxes": [mailboxShape],
  "security.oidc": { ...defaults["security.oidc"], roles: [oidcRoleShape] },
  "bounce.actions": { "*": { count: 0, action: "" } },
};
const arrays = new Set([
  "app.from_email",
  "app.notify_emails",
  "privacy.exportable",
  "privacy.domain_blocklist",
  "privacy.domain_allowlist",
  "security.trusted_urls",
  "upload.extensions",
  "smtp",
  "messengers",
  "bounce.mailboxes",
]);
const strings = new Set([
  "app.from_email",
  "app.notify_emails",
  "privacy.exportable",
  "privacy.domain_blocklist",
  "privacy.domain_allowlist",
  "security.trusted_urls",
  "upload.extensions",
]);
for (const key of strings) shapes[key] = [""];
function zero(shape: any): any {
  if (shape === null || Array.isArray(shape)) return null;
  if (typeof shape === "object")
    return Object.fromEntries(
      Object.entries(shape)
        .filter(([key]) => key !== "*")
        .map(([key, value]) => [key, zero(value)]),
    );
  if (typeof shape === "string") return "";
  if (typeof shape === "boolean") return false;
  return 0;
}
function entries(value: unknown): [string, unknown][] {
  if (value instanceof Members) return value.entries;
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.entries(value);
  return fail();
}
// All JSON field tags here are ASCII. Go's simple folding also admits long s
// and Kelvin sign, without multi-character expansions such as ß -> SS.
const foldField = (value: string) => value.replace(/ſ/g, "s").replace(/K/g, "k").toLowerCase();
function bind(value: unknown, shape: any, previous: any = zero(shape)): any {
  if (value === null)
    return shape === null ||
      Array.isArray(shape) ||
      (shape && typeof shape === "object" && Object.hasOwn(shape, "*"))
      ? null
      : previous;
  if (shape === null) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) return fail();
    return value;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return fail();
    return value.map((item, index) => bind(item, shape[0], previous?.[index] ?? zero(shape[0])));
  }
  if (typeof shape === "object") {
    const members = entries(value);
    const result: Record<string, unknown> = previous ? cloneJson(previous) : {};
    if (Object.hasOwn(shape, "*")) {
      for (const [key, entry] of members)
        Object.defineProperty(result, key, {
          value: bind(entry, shape["*"]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      return result;
    }
    for (const [key, fallback] of Object.entries(shape))
      if (!Object.hasOwn(result, key)) result[key] = zero(fallback);
    for (const [key, entry] of members) {
      const match = Object.keys(shape).find((name) => foldField(name) === foldField(key));
      if (match) result[match] = bind(entry, shape[match], result[match]);
    }
    return result;
  }
  if (typeof shape === "number") return int64(value) ?? fail();
  if (typeof value !== typeof shape) return fail();
  return typeof value === "string" ? value.toWellFormed() : value;
}
export function projectRaw(value: Settings, root: string): Settings {
  const out = bindFull(value, root);
  for (const key of arrays) out[key] ??= [];
  for (const key of ["smtp", "messengers", "bounce.mailboxes"])
    for (const item of out[key]) if (!item.password) delete item.password;
  return out;
}
export function bindFull(value: unknown, root: string): Settings {
  if (value !== null && (typeof value !== "object" || Array.isArray(value))) return fail();
  const out: Settings = {};
  for (const [key, shape] of Object.entries(shapes)) {
    if (Array.isArray(shape)) out[key] = null;
    else if (shape && typeof shape === "object") out[key] = bind({}, shape);
    else out[key] = typeof shape === "string" ? "" : typeof shape === "boolean" ? false : 0;
  }
  for (const [key, entry] of value === null ? [] : entries(value)) {
    const match = Object.keys(shapes).find((name) => foldField(name) === foldField(key));
    if (match) out[match] = bind(entry, shapes[match], out[match]);
  }
  out["app.root_url"] = root;
  out["app.check_updates"] = false;
  return out;
}
export function bindKey(current: Settings, key: string, value: unknown): Settings {
  if (
    !Object.hasOwn(shapes, key) ||
    (key === "app.check_updates" && value !== false) ||
    (value === null && !arrays.has(key))
  )
    return fail();
  const out = cloneJson(current);
  out[key] = bind(value, shapes[key]);
  return out;
}
function preserve(item: Settings, old: Settings[]) {
  const previous = old.findLast((v) => v.uuid === item.uuid);
  if (!item.uuid) item.uuid = crypto.randomUUID();
  if (!item.password && previous) item.password = previous.password;
  if (!item.password) delete item.password;
}
export function normalize(next: Settings, current: Settings, roles: Roles, now: number): Settings {
  for (const key of arrays) next[key] ??= [];
  const addresses: string[] = [];
  if (next["app.from_email"].length > 250) return fail("omax 250 `from` addresses are allowed");
  for (const raw of next["app.from_email"]) {
    const value = trimSpace(raw ?? "");
    if (!value) continue;
    if ([...value].length > 2000) return fail("`from` address cannot exceed 2000 characters");
    const opening = value.indexOf("{{");
    const tpl = opening >= 0 && value.includes("}}", opening + 2);
    if (tpl && !addresses.length)
      return fail("default (first) `from` address cannot contain template expressions");
    if (!tpl) {
      if (!validFromAddress(value)) return fail(`invalid from email address: ${value}`);
    }
    if (!addresses.includes(value)) addresses.push(value);
  }
  if (!addresses.length) return fail("at least one `from` address is required");
  next["app.from_email"] = addresses;
  const names = new Set(["email"]);
  let hasDefault = false;
  for (const server of next.smtp) {
    if (!server || typeof server !== "object") return fail();
    if (server.enabled && !server.exclude_from_default) hasDefault = true;
    let name = simpleLower(trimSpace(server.name)).replace(/[^a-z0-9-]/gu, "-");
    if (name) {
      if (!name.startsWith("email-")) name = `email-${name}`;
      if (names.has(name)) return fail(`Duplicate messenger name: ${name}`);
      names.add(name);
    }
    if (server.exclude_from_default && !name)
      return fail("A name is required for an SMTP server excluded from the default messenger.");
    server.name = name;
    server.host = trimSpace(server.host);
    preserve(server, current.smtp);
    if (server.enabled)
      server.from_addresses = (server.from_addresses ?? [])
        .map((a: string) => simpleLower(trimSpace(a ?? "")))
        .filter(Boolean);
  }
  if (!hasDefault)
    return fail(
      "At least one enabled SMTP server must be included in the default 'email' messenger.",
    );
  for (const box of next["bounce.mailboxes"]) {
    if (!box || typeof box !== "object") return fail();
    box.host = trimSpace(box.host);
    if (!(goDuration(box.scan_interval) >= 60000))
      return fail("Bounce scan interval should be minimum 1 minute.");
    preserve(box, current["bounce.mailboxes"]);
  }
  for (const item of next.messengers) {
    if (!item || typeof item !== "object") return fail();
    preserve(item, current.messengers);
    const name = simpleLower(item.name).replace(/[^a-z0-9-]/g, "");
    if (names.has(name)) return fail(`Duplicate messenger name: ${name}`);
    if (!name) return fail("Invalid messenger name.");
    item.name = name;
    names.add(name);
  }
  for (const key of ["upload.s3.aws_secret_access_key", "bounce.sendgrid_key"])
    if (!next[key]) next[key] = current[key];
  for (const [key, field] of [
    ["bounce.azure", "shared_secret"],
    ["bounce.postmark", "password"],
    ["bounce.forwardemail", "key"],
    ["bounce.lettermint", "key"],
    ["security.oidc", "client_secret"],
  ] as const)
    if (!next[key]?.[field!]) {
      if (!next[key]) return fail();
      next[key][field!] = current[key][field!];
    }
  if (!next["security.captcha"]?.hcaptcha?.secret) {
    if (!next["security.captcha"]?.hcaptcha) return fail();
    next["security.captcha"].hcaptcha.secret = current["security.captcha"].hcaptcha.secret;
  }
  for (const key of ["privacy.domain_blocklist", "privacy.domain_allowlist"])
    next[key] = next[key].map((d: string) => simpleLower(trimSpace(d ?? ""))).filter(Boolean);
  next["upload.extensions"] = next["upload.extensions"].map((v: string) =>
    simpleLower(trimSpace(v ?? "").replace(/^\./, "")),
  );
  next["security.trusted_urls"] = next["security.trusted_urls"]
    .map((v: string) => trimSpace(v ?? ""))
    .filter(Boolean);
  for (const url of next["security.trusted_urls"])
    if (url !== "*" && !validTrustedURL(url))
      return fail(`Invalid data: invalid trusted URL: ${url}`);
  const oidc = next["security.oidc"];
  if (!oidc) return fail();
  if (oidc.roles === null) oidc.roles = current["security.oidc"].roles;
  const exists = (id: number | null, type: "user" | "list") =>
    id !== null && Number.isSafeInteger(id) && id > 0 && roles.hasRole(BigInt(id), type);
  if (
    (oidc.auto_create_users || oidc.default_user_role_id !== null) &&
    !exists(oidc.default_user_role_id, "user")
  )
    return fail(`OIDC default user role ID ${oidc.default_user_role_id ?? 0} does not exist`);
  if (oidc.default_list_role_id !== null && !exists(oidc.default_list_role_id, "list"))
    return fail(`OIDC default list role ID ${oidc.default_list_role_id} does not exist`);
  for (let i = 0; i < oidc.roles.length; i++) {
    const mapping = oidc.roles[i];
    if (!mapping.claim) return fail(`OIDC role mapping ${i + 1}: claim is required`);
    if (!mapping.match) return fail(`OIDC role mapping ${i + 1}: match is required`);
    if (mapping.user_role_id !== null && !exists(mapping.user_role_id, "user"))
      return fail(
        `OIDC role mapping ${i + 1}: user role ID ${mapping.user_role_id} does not exist`,
      );
    if (mapping.list_role_id !== null && !exists(mapping.list_role_id, "list"))
      return fail(
        `OIDC role mapping ${i + 1}: list role ID ${mapping.list_role_id} does not exist`,
      );
  }
  if (next["app.cache_slow_queries"]) {
    const error = cronError(next["app.cache_slow_queries_interval"]);
    if (error) return fail(`Invalid data: slow query cron: ${error}`);
  }
  sessionDuration(next["security.session_duration"], now);
  next["app.root_url"] = current["app.root_url"];
  next["app.check_updates"] = false;
  return next;
}
export function masked(settings: Settings): Settings {
  const out = cloneJson(settings);
  const mask = (value: string | undefined) => "•".repeat([...(value ?? "")].length);
  for (const key of ["smtp", "messengers", "bounce.mailboxes"])
    for (const item of out[key]) {
      if (item.password) item.password = mask(item.password);
    }
  for (const key of ["upload.s3.aws_secret_access_key", "bounce.sendgrid_key"])
    if (out[key]) out[key] = mask(out[key]);
  for (const [key, field] of [
    ["bounce.azure", "shared_secret"],
    ["bounce.postmark", "password"],
    ["bounce.forwardemail", "key"],
    ["bounce.lettermint", "key"],
    ["security.oidc", "client_secret"],
  ] as const)
    out[key][field!] = mask(out[key][field!]);
  out["security.captcha"].hcaptcha.secret = mask(out["security.captcha"].hcaptcha.secret);
  for (const mapping of out["security.oidc"].roles ?? []) {
    if (mapping.user_role_id === null) delete mapping.user_role_id;
    if (mapping.list_role_id === null) delete mapping.list_role_id;
  }
  if (!out["upload.s3.aws_secret_access_key"]) delete out["upload.s3.aws_secret_access_key"];
  return out;
}
