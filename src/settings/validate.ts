import { validateAbsoluteUrl } from "@/config/bootstrap";
import { validateDKIM } from "@/settings/dkim";
import { validTrustedURL } from "@/settings/url";
// Settings model and transformations adapted from listmonk models/settings.go and cmd/settings.go at 6fcd95f.
import { defaults } from "@/settings/defaults";
import { trimSpace } from "@/lists/store";
import { simpleLower } from "@/subscribers/unicode-lower";
import { validFromAddress } from "@/settings/mail";
import { goDuration, intervalStart, sessionDuration } from "@/settings/duration";
import { cronError } from "@/settings/cron";
import { cloneJson, int64, Members } from "@/settings/json";
import { validTopicArn } from "@/bounces/ses";
import { parseProxy } from "@/server/client-address";
import { HttpError } from "@/server/response";
import { settingSides } from "@/settings/keys";
import type { SettingKey } from "@/settings/keys";

export type Settings = Record<string, any>;

// The brand settings (B129, D127): the fixed font choices, the header modes, and the shape of a
// Google Fonts family name (letters and digits, single spaces, at most 60 characters).
const systemFontNames = new Set(["system-sans", "system-serif", "system-mono"]);
const brandHeaders = new Set(["auto", "logo", "name", "logo_and_name"]);
const googleFamily = /^[A-Za-z][A-Za-z0-9]*(?: [A-Za-z0-9]+)*$/;
// The SES API keys (B139, D154): an AWS region name, a long-term IAM access key ID, and a secret of
// printable characters without spaces (AWS issues 40 of them).
const sesRegion = /^[a-z]{2}(?:-[a-z]+)+-[0-9]{1,2}$/;
const sesKeyId = /^AKIA[A-Z0-9]{16}$/;
const sesSecretFormat = /^[!-~]{16,128}$/;
// D154: a role ID names a role of one project, and OIDC is not built (D89), so the instance checks
// an OIDC role ID's shape only: a positive whole number. Upstream also checks that the role exists.
const roleId = (id: number | null, _type: "user" | "list") =>
  id !== null && Number.isSafeInteger(id) && id > 0;
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
  dkim: { domain_name: "", key_selector: "", private_key: "" },
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
const oidcRoleShape = {
  claim: "",
  match: "",
  user_role_id: null,
  list_role_id: null,
};
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
  "security.trusted_proxies",
  "bounce.ses_topic_arns",
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
  "security.trusted_proxies",
  "bounce.ses_topic_arns",
  "upload.extensions",
]);
for (const key of strings) {
  shapes[key] = [""];
}
function zero(shape: any): any {
  if (shape === null || Array.isArray(shape)) {
    return null;
  }
  if (typeof shape === "object") {
    return Object.fromEntries(
      Object.entries(shape)
        .filter(([key]) => key !== "*" && !(shape === smtpShape && key === "dkim"))
        .map(([key, value]) => [key, zero(value)]),
    );
  }
  if (typeof shape === "string") {
    return "";
  }
  if (typeof shape === "boolean") {
    return false;
  }
  return 0;
}
function entries(value: unknown): Array<[string, unknown]> {
  if (value instanceof Members) {
    return value.entries;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value);
  }
  return fail();
}
// All JSON field tags here are ASCII. Go's simple folding also admits long s
// and Kelvin sign, without multi-character expansions such as ß -> SS.
const foldField = (value: string) => value.replaceAll("ſ", "s").replaceAll("K", "k").toLowerCase();
// Folded name -> declared name for one static shape; the first declared match wins, as with find.
const foldedNames = new WeakMap<object, Map<string, string>>();
function lookup(shape: Record<string, unknown>, key: string): string | undefined {
  let names = foldedNames.get(shape);
  if (!names) {
    names = new Map();
    for (const name of Object.keys(shape)) {
      const folded = foldField(name);
      if (!names.has(folded)) {
        names.set(folded, name);
      }
    }
    foldedNames.set(shape, names);
  }
  return names.get(foldField(key));
}
/** Whether a decoded settings object names a top-level key, with Go field folding. */
export function hasField(value: unknown, key: string): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return entries(value).some(([name]) => foldField(name) === foldField(key));
}
/**
 * Each top-level name of a decoded settings object and the declared key it binds to, with Go field
 * folding; undefined for a name that binds to none.
 */
export function bodyFields(value: unknown): Array<[string, string | undefined]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return entries(value).map(([name]) => [name, lookup(shapes, name)]);
}
function bind(value: unknown, shape: any, previous: any = zero(shape)): any {
  if (value === null) {
    return shape === null ||
      Array.isArray(shape) ||
      (shape && typeof shape === "object" && Object.hasOwn(shape, "*"))
      ? null
      : previous;
  }
  if (shape === null) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      return fail();
    }
    return value;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) {
      return fail();
    }
    // D48 discards truncated elements rather than retaining Go slice backing capacity.
    return value.map((item, index) => bind(item, shape[0], previous?.[index] ?? zero(shape[0])));
  }
  if (typeof shape === "object") {
    const members = entries(value);
    const result: Record<string, unknown> = previous ? cloneJson(previous) : {};
    if (Object.hasOwn(shape, "*")) {
      for (const [key, entry] of members) {
        Object.defineProperty(result, key, {
          value: bind(entry, shape["*"]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
    for (const [key, fallback] of Object.entries(shape)) {
      if (key !== "dkim" && !Object.hasOwn(result, key)) {
        result[key] = zero(fallback);
      }
    }
    for (const [key, entry] of members) {
      const match = lookup(shape, key);
      if (match === "dkim" && shape === smtpShape) {
        try {
          if (entry === null) {
            result[match] = null;
          } else {
            const fields = entries(entry);
            for (const required of ["domain_name", "key_selector", "private_key"]) {
              const values = fields.filter(([name]) => foldField(name) === required);
              if (!values.length || values.some(([, value]) => typeof value !== "string")) {
                return fail("Invalid DKIM configuration.");
              }
            }
            result[match] = bind(entry, shape[match], zero(shape[match]));
          }
        } catch {
          return fail("Invalid DKIM configuration.");
        }
      } else if (match) {
        result[match] = bind(entry, shape[match], result[match]);
      }
    }
    return result;
  }
  if (typeof shape === "number") {
    return int64(value) ?? fail();
  }
  if (typeof value !== typeof shape) {
    return fail();
  }
  return typeof value === "string" ? value.toWellFormed() : value;
}
export function projectRaw(value: Settings, root: string): Settings {
  const out = bindFull(value, root);
  for (const key of arrays) {
    out[key] ??= [];
  }
  for (const key of ["smtp", "messengers", "bounce.mailboxes"]) {
    for (const item of out[key]) {
      if (!item.password) {
        delete item.password;
      }
      if (key === "smtp" && !item.dkim) {
        delete item.dkim;
      }
    }
  }
  return out;
}
export function bindFull(value: unknown, root: string): Settings {
  if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
    return fail();
  }
  const out: Settings = {};
  for (const [key, shape] of Object.entries(shapes)) {
    if (Array.isArray(shape)) {
      out[key] = null;
    } else if (shape && typeof shape === "object") {
      out[key] = bind({}, shape);
    } else {
      out[key] = typeof shape === "string" ? "" : typeof shape === "boolean" ? false : 0;
    }
  }
  for (const [key, entry] of value === null ? [] : entries(value)) {
    const match = lookup(shapes, key);
    if (match) {
      out[match] = bind(entry, shapes[match], out[match]);
    }
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
  ) {
    return fail();
  }
  const out = cloneJson(current);
  out[key] = bind(value, shapes[key]);
  return out;
}
// B51: an item without a uuid is new and matches no stored item, so it never takes another's secret.
// B56: an item with auth none stores no password, typed or stored (deliberate difference, 07-api-and-ui.md):
// a server with no authentication has no use for one, and switching back to login needs a new one.
// B57: for an SMTP server, an empty auth protocol is no authentication too (email.ts makeTransport), so
// it is treated as none. A bounce mailbox with "" still logs in (upstream pop.go), so it keeps its password.
function preserve(item: Settings, old: Array<Settings>, smtp: boolean) {
  const previous = item.uuid ? old.findLast((v) => v.uuid === item.uuid) : undefined;
  if (!item.uuid) {
    item.uuid = crypto.randomUUID();
  }
  if (item.auth_protocol === "none" || (smtp && item.auth_protocol === "")) {
    delete item.password;
  } else if (!item.password && previous) {
    item.password = previous.password;
  }
  if (!item.password) {
    delete item.password;
  }
}
// B56: two items of one list with the same uuid would share a secret, so the whole save is refused.
// Items without a uuid are new and are not compared.
function refuseDuplicateUUIDs(items: Array<Settings>, label: string) {
  const seen = new Set<string>();
  for (const item of items) {
    const uuid = item?.uuid;
    if (!uuid) {
      continue;
    }
    if (seen.has(uuid)) {
      fail(`Duplicate uuid in ${label}: each item needs its own.`);
    }
    seen.add(uuid);
  }
}
/** Checks and normalizes a project-key save (B139): `next` and `current` hold project keys. */
export function normalizeProject(next: Settings, current: Settings, now: number): Settings {
  for (const key of arrays) {
    if (settingSides[key as SettingKey] === "project") {
      next[key] ??= [];
    }
  }
  const addresses: Array<string> = [];
  if (next["app.from_email"].length > 250) {
    return fail("omax 250 `from` addresses are allowed");
  }
  // B117a (D136): an address already stored is not checked again, so an entry an older build saved does
  // not block a save of anything else. A new or changed entry is checked as before. B117f (D136 item 2): the
  // default (first) address is the sender, so a stored one that a save moves into first place is checked too.
  const storedFrom = new Set<string>(current["app.from_email"] ?? []);
  const storedDefault = current["app.from_email"]?.[0];
  for (const raw of next["app.from_email"]) {
    const value = trimSpace(raw ?? "");
    if (!value) {
      continue;
    }
    const isDefault = addresses.length === 0;
    const stored = storedFrom.has(value) && (!isDefault || value === storedDefault);
    if (!stored && Array.from(value).length > 2000) {
      return fail("`from` address cannot exceed 2000 characters");
    }
    const opening = value.indexOf("{{");
    const tpl = opening >= 0 && value.includes("}}", opening + 2);
    if (tpl && !addresses.length) {
      return fail("default (first) `from` address cannot contain template expressions");
    }
    if (!tpl && !stored) {
      if (!validFromAddress(value)) {
        return fail(`invalid from email address: ${value}`);
      }
    }
    if (!addresses.includes(value)) {
      addresses.push(value);
    }
  }
  if (!addresses.length) {
    return fail("at least one `from` address is required");
  }
  next["app.from_email"] = addresses;
  // B117a (D136): every administrator address is checked as a from address is. An address already stored
  // is kept as it is, so an entry an older build saved does not block saving anything else; blank entries
  // stay blank, as a send skips them.
  // The stored entries are compared trimmed, as the new ones are.
  const storedNotify = new Set<string>(
    (current["app.notify_emails"] ?? []).map((raw: string) => trimSpace(raw ?? "")),
  );
  next["app.notify_emails"] = next["app.notify_emails"].map((raw: string) => {
    const value = trimSpace(raw ?? "");
    if (!value || storedNotify.has(value)) {
      return value;
    }
    if (Array.from(value).length > 2000) {
      return fail("notification email address cannot exceed 2000 characters");
    }
    if (!validFromAddress(value)) {
      return fail(`invalid notification email address: ${value}`);
    }
    return value;
  });
  // B126 (D123): the operator's own site, an absolute http(s) URL under the root URL rules (D107). It is
  // checked when it changes (D136), so a stored value an older build saved does not block a save.
  next["app.site_url"] = trimSpace(next["app.site_url"] ?? "");
  if (next["app.site_url"] && next["app.site_url"] !== current["app.site_url"]) {
    try {
      validateAbsoluteUrl(next["app.site_url"], "site-url");
    } catch (error) {
      return fail(`Invalid data: ${(error as Error).message}`);
    }
  }
  // B129 (D127): the brand. A colour is hex only, so nothing can inject CSS; a font is a fixed system
  // stack or a Google Fonts family name, which holds letters, digits and single spaces only.
  next["appearance.brand.accent"] = trimSpace(next["appearance.brand.accent"] ?? "");
  if (
    next["appearance.brand.accent"] &&
    !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(next["appearance.brand.accent"])
  ) {
    return fail("brand accent colour must be a hex colour, #rgb or #rrggbb");
  }
  next["appearance.brand.font"] = trimSpace(next["appearance.brand.font"] ?? "") || "system-sans";
  const font = next["appearance.brand.font"];
  if (!systemFontNames.has(font) && !(googleFamily.test(font) && Array.from(font).length <= 60)) {
    return fail(
      "brand font must be system-sans, system-serif, system-mono or a Google Fonts family name",
    );
  }
  next["appearance.brand.header"] = trimSpace(next["appearance.brand.header"] ?? "") || "auto";
  if (!brandHeaders.has(next["appearance.brand.header"])) {
    return fail("brand header must be auto, logo, name or logo_and_name");
  }
  // The admin form offers these (listmonk's own UI); the API takes nothing outside them.
  // A stored rule an older build accepted must not block saving anything else: only new or changed rules are checked.
  const storedRules = (current["bounce.actions"] ?? {}) as Settings;
  for (const [name, rule] of Object.entries<Settings>(next["bounce.actions"] ?? {})) {
    if (
      Object.hasOwn(storedRules, name) &&
      JSON.stringify(storedRules[name]) === JSON.stringify(rule)
    ) {
      continue;
    }
    if (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > 1000) {
      return fail("Bounce action count must be between 1 and 1000.");
    }
    if (!["none", "unsubscribe", "blocklist", "delete"].includes(rule.action)) {
      return fail("Bounce action must be none, unsubscribe, blocklist or delete.");
    }
  }
  if (!next["security.captcha"]?.hcaptcha?.secret) {
    if (!next["security.captcha"]?.hcaptcha) {
      return fail();
    }
    next["security.captcha"].hcaptcha.secret = current["security.captcha"].hcaptcha.secret;
  }
  next["marketing.min_interval"] = trimSpace(next["marketing.min_interval"] ?? "");
  if (intervalStart(next["marketing.min_interval"], new Date(now)) === undefined) {
    return fail("Invalid marketing.min_interval: use an ISO 8601 duration such as P7D.");
  }
  for (const key of ["privacy.domain_blocklist", "privacy.domain_allowlist"]) {
    next[key] = next[key].map((d: string) => simpleLower(trimSpace(d ?? ""))).filter(Boolean);
  }
  next["upload.extensions"] = next["upload.extensions"].map((v: string) =>
    simpleLower(trimSpace(v ?? "").replace(/^\./, "")),
  );
  next["security.trusted_urls"] = next["security.trusted_urls"]
    .map((v: string) => trimSpace(v ?? ""))
    .filter(Boolean);
  // B117a (D136): an entry already stored is not checked again, as an address is not (see app.from_email).
  const storedTrusted = new Set<string>(current["security.trusted_urls"] ?? []);
  for (const url of next["security.trusted_urls"]) {
    if (url !== "*" && !storedTrusted.has(url) && !validTrustedURL(url)) {
      return fail(`Invalid data: invalid trusted URL: ${url}`);
    }
  }
  for (const budget of Object.values(next["security.public_rate_limit"] ?? {})) {
    if (
      typeof budget !== "number" ||
      !Number.isSafeInteger(budget) ||
      budget < 1 ||
      budget > 1_000_000
    ) {
      return fail("Invalid security.public_rate_limit: use whole requests per minute.");
    }
  }
  next["app.root_url"] = current["app.root_url"];
  return next;
}
/** Checks and normalizes an instance-key save (B139): `next` and `current` hold instance keys. */
export function normalizeInstance(next: Settings, current: Settings, now: number): Settings {
  for (const key of arrays) {
    if (settingSides[key as SettingKey] === "instance") {
      next[key] ??= [];
    }
  }
  refuseDuplicateUUIDs(next.smtp, "SMTP servers");
  refuseDuplicateUUIDs(next["bounce.mailboxes"], "bounce mailboxes");
  refuseDuplicateUUIDs(next.messengers, "messengers");
  const names = new Set(["email"]);
  let hasDefault = false;
  for (const server of next.smtp) {
    if (!server || typeof server !== "object") {
      return fail();
    }
    if (server.enabled && !server.exclude_from_default) {
      hasDefault = true;
    }
    let name = simpleLower(trimSpace(server.name)).replaceAll(/[^a-z0-9-]/gu, "-");
    if (name) {
      if (!name.startsWith("email-")) {
        name = `email-${name}`;
      }
      if (names.has(name)) {
        return fail(`Duplicate messenger name: ${name}`);
      }
      names.add(name);
    }
    if (server.exclude_from_default && !name) {
      return fail("A name is required for an SMTP server excluded from the default messenger.");
    }
    server.name = name;
    server.host = trimSpace(server.host);
    // B51: a DKIM key is inherited only from the stored item with this uuid, never from one without.
    const prior = server.uuid
      ? current.smtp.findLast((item: Settings) => item.uuid === server.uuid)
      : undefined;
    preserve(server, current.smtp, true);
    // B117a (D136): the sender reads an idle timeout from 1 s to 5 min and replaces any other with its
    // default, and no sender reads the retry delay yet, so a value that is not a duration is refused.
    // An empty value is the default, as at send time. A stored value that is kept is not checked again.
    if (server.idle_timeout && prior?.idle_timeout !== server.idle_timeout) {
      const idle = goDuration(server.idle_timeout);
      if (!(idle >= 1000 && idle <= 300_000)) {
        return fail(
          "Invalid SMTP idle timeout: use a Go duration from 1s to 5m, such as 15s, or leave it empty.",
        );
      }
    }
    if (server.msg_retry_delay && prior?.msg_retry_delay !== server.msg_retry_delay) {
      if (!(goDuration(server.msg_retry_delay) >= 0)) {
        return fail(
          "Invalid SMTP retry delay: use a Go duration, such as 10ms, or leave it empty.",
        );
      }
    }
    if (!Object.hasOwn(server, "dkim") && prior?.dkim) {
      server.dkim = cloneJson(prior.dkim);
    }
    if (server.dkim) {
      if (!server.dkim.private_key && prior?.dkim) {
        server.dkim.private_key = prior.dkim.private_key;
      }
      validateDKIM(server.dkim);
    } else {
      delete server.dkim;
    }
    if (server.enabled) {
      server.from_addresses = (server.from_addresses ?? [])
        .map((a: string) => simpleLower(trimSpace(a ?? "")))
        .filter(Boolean);
    }
  }
  if (!hasDefault) {
    return fail(
      "At least one enabled SMTP server must be included in the default 'email' messenger.",
    );
  }
  for (const box of next["bounce.mailboxes"]) {
    if (!box || typeof box !== "object") {
      return fail();
    }
    box.host = trimSpace(box.host);
    if (!(goDuration(box.scan_interval) >= 60_000)) {
      return fail("Bounce scan interval should be minimum 1 minute.");
    }
    preserve(box, current["bounce.mailboxes"], false);
  }
  for (const item of next.messengers) {
    if (!item || typeof item !== "object") {
      return fail();
    }
    preserve(item, current.messengers, false);
    const name = simpleLower(item.name).replaceAll(/[^a-z0-9-]/g, "");
    if (names.has(name)) {
      return fail(`Duplicate messenger name: ${name}`);
    }
    if (!name) {
      return fail("Invalid messenger name.");
    }
    item.name = name;
    names.add(name);
  }
  for (const key of ["upload.s3.aws_secret_access_key", "bounce.sendgrid_key"]) {
    if (!next[key]) {
      next[key] = current[key];
    }
  }
  for (const [key, field] of [
    ["bounce.azure", "shared_secret"],
    ["bounce.postmark", "password"],
    ["bounce.forwardemail", "key"],
    ["bounce.lettermint", "key"],
    ["security.oidc", "client_secret"],
  ] as const) {
    if (!next[key]?.[field]) {
      if (!next[key]) {
        return fail();
      }
      next[key][field] = current[key][field];
    }
  }
  const sendRate = next["messaging.max_send_rate"];
  if (
    typeof sendRate !== "number" ||
    !Number.isInteger(sendRate) ||
    sendRate < 0 ||
    sendRate > 10_000
  ) {
    return fail("Invalid messaging.max_send_rate: use an integer between 0 and 10000.");
  }
  // B139 (D154): the SES account's API keys, stored and masked, not read by any sender yet. All three
  // are set or none is; an empty secret keeps the stored one, and so does the mask a GET served (a
  // client's GET then PUT unchanged); an empty key ID clears the secret.
  next["ses.api_region"] = trimSpace(next["ses.api_region"] ?? "");
  next["ses.api_access_key_id"] = trimSpace(next["ses.api_access_key_id"] ?? "");
  if (!next["ses.api_access_key_id"]) {
    next["ses.api_secret_access_key"] = "";
  } else if (
    !next["ses.api_secret_access_key"] ||
    (typeof next["ses.api_secret_access_key"] === "string" &&
      /^•+$/.test(next["ses.api_secret_access_key"]))
  ) {
    next["ses.api_secret_access_key"] = current["ses.api_secret_access_key"] ?? "";
  }
  if (next["ses.api_region"] && !sesRegion.test(next["ses.api_region"])) {
    return fail("Invalid ses.api_region: use an AWS region such as eu-west-1.");
  }
  if (next["ses.api_access_key_id"] && !sesKeyId.test(next["ses.api_access_key_id"])) {
    return fail(
      "Invalid ses.api_access_key_id: use an IAM access key ID, AKIA and 16 letters or digits.",
    );
  }
  const sesSecret = next["ses.api_secret_access_key"];
  if (typeof sesSecret !== "string" || (sesSecret && !sesSecretFormat.test(sesSecret))) {
    return fail("Invalid ses.api_secret_access_key: use the secret access key AWS gave.");
  }
  const sesSet = [next["ses.api_region"], next["ses.api_access_key_id"], sesSecret].filter(Boolean);
  if (sesSet.length !== 0 && sesSet.length !== 3) {
    return fail(
      "Invalid SES API settings: set the region, the access key ID and the secret access key together.",
    );
  }
  next["security.trusted_proxies"] = next["security.trusted_proxies"]
    .map((v: string) => trimSpace(v ?? ""))
    .filter(Boolean);
  for (const proxy of next["security.trusted_proxies"]) {
    if (!parseProxy(proxy)) {
      return fail(`Invalid data: invalid trusted proxy: ${proxy}`);
    }
  }
  next["bounce.ses_topic_arns"] = next["bounce.ses_topic_arns"]
    .map((v: string) => trimSpace(v ?? ""))
    .filter(Boolean);
  if (next["bounce.ses_topic_arns"].length > 100) {
    return fail("Invalid data: at most 100 SNS topic ARNs.");
  }
  for (const arn of next["bounce.ses_topic_arns"]) {
    if (!validTopicArn(arn)) {
      return fail(`Invalid data: invalid SNS topic ARN: ${arn}`);
    }
  }
  const oidc = next["security.oidc"];
  if (!oidc) {
    return fail();
  }
  if (oidc.roles === null) {
    oidc.roles = current["security.oidc"].roles;
  }
  if (
    (oidc.auto_create_users || oidc.default_user_role_id !== null) &&
    !roleId(oidc.default_user_role_id, "user")
  ) {
    return fail(`OIDC default user role ID ${oidc.default_user_role_id ?? 0} does not exist`);
  }
  if (oidc.default_list_role_id !== null && !roleId(oidc.default_list_role_id, "list")) {
    return fail(`OIDC default list role ID ${oidc.default_list_role_id} does not exist`);
  }
  for (let i = 0; i < oidc.roles.length; i++) {
    const mapping = oidc.roles[i];
    if (!mapping.claim) {
      return fail(`OIDC role mapping ${i + 1}: claim is required`);
    }
    if (!mapping.match) {
      return fail(`OIDC role mapping ${i + 1}: match is required`);
    }
    if (mapping.user_role_id !== null && !roleId(mapping.user_role_id, "user")) {
      return fail(
        `OIDC role mapping ${i + 1}: user role ID ${mapping.user_role_id} does not exist`,
      );
    }
    if (mapping.list_role_id !== null && !roleId(mapping.list_role_id, "list")) {
      return fail(
        `OIDC role mapping ${i + 1}: list role ID ${mapping.list_role_id} does not exist`,
      );
    }
  }
  if (next["app.cache_slow_queries"]) {
    const error = cronError(next["app.cache_slow_queries_interval"]);
    if (error) {
      return fail(`Invalid data: slow query cron: ${error}`);
    }
  }
  sessionDuration(next["security.session_duration"], now);
  // B117a (D136): a value the server reads when its feature is on is checked when it is saved, as the
  // slow-query cron is. A value that is off or not changed is not checked, so an older stored value does
  // not block saving anything else.
  const changed = (...keys: Array<string>) =>
    keys.some((key) => JSON.stringify(next[key]) !== JSON.stringify(current[key]));
  if (
    next["app.message_sliding_window"] &&
    changed("app.message_sliding_window", "app.message_sliding_window_duration")
  ) {
    // The campaign runner slides its window only when it is longer than one second (runner.ts).
    if (!(goDuration(next["app.message_sliding_window_duration"]) > 1000)) {
      return fail(
        "Invalid app.message_sliding_window_duration: use a Go duration longer than one second, such as 1h.",
      );
    }
  }
  if (next["maintenance.db"]?.vacuum && changed("maintenance.db")) {
    const error = cronError(next["maintenance.db"].vacuum_cron_interval);
    if (error) {
      return fail(`Invalid data: vacuum cron: ${error}`);
    }
  }
  const expiry = next["upload.s3.expiry"];
  if (expiry && changed("upload.s3.expiry") && !(goDuration(expiry) > 0)) {
    return fail("Invalid upload.s3.expiry: use a Go duration, such as 167h, or leave it empty.");
  }
  next["app.check_updates"] = false;
  return next;
}
const mask = (value: string | undefined) => "•".repeat(Array.from(value ?? "").length);
/** One side's settings with every secret masked; a key the object does not hold is skipped. */
export function masked(settings: Settings): Settings {
  const out = cloneJson(settings);
  const has = (key: string) => Object.hasOwn(out, key);
  for (const key of ["smtp", "messengers", "bounce.mailboxes"].filter(has)) {
    for (const item of out[key]) {
      if (item.password) {
        item.password = mask(item.password);
      }
      if (key === "smtp" && item.dkim) {
        item.dkim.private_key = mask(item.dkim.private_key);
      }
    }
  }
  for (const key of [
    "upload.s3.aws_secret_access_key",
    "bounce.sendgrid_key",
    "ses.api_secret_access_key",
  ]) {
    if (out[key]) {
      out[key] = mask(out[key]);
    }
  }
  for (const [key, field] of [
    ["bounce.azure", "shared_secret"],
    ["bounce.postmark", "password"],
    ["bounce.forwardemail", "key"],
    ["bounce.lettermint", "key"],
    ["security.oidc", "client_secret"],
  ] as const) {
    if (has(key)) {
      out[key][field] = mask(out[key][field]);
    }
  }
  if (has("security.captcha")) {
    out["security.captcha"].hcaptcha.secret = mask(out["security.captcha"].hcaptcha.secret);
  }
  for (const mapping of (has("security.oidc") && out["security.oidc"].roles) || []) {
    if (mapping.user_role_id === null) {
      delete mapping.user_role_id;
    }
    if (mapping.list_role_id === null) {
      delete mapping.list_role_id;
    }
  }
  if (has("upload.s3.aws_secret_access_key") && !out["upload.s3.aws_secret_access_key"]) {
    delete out["upload.s3.aws_secret_access_key"];
  }
  return out;
}
