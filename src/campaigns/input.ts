// Campaign request binding and validation adapted from listmonk cmd/campaigns.go (campReq,
// campContentReq, validateCampaignFields) at 6fcd95f. JSON is bound as Echo binds it into
// the Go struct: absent fields, and null for non-nullable strings, keep the prior value.
import type { Translation } from "@/i18n/i18n";
import { HttpError } from "@/server/response";
import { strHasLen } from "@/server/validation";
import { parseAddress } from "@/settings/mail";
import { sanitizeEmail } from "@/subscribers/email";
import {
  contentTypes,
  normalizeTags,
  type ContentType,
  type WritableCampaign,
} from "@/campaigns/store";

const LIMIT = 2 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;
/** Custom header values across all header sets. */
const MAX_HEADERS = 32;
export interface CampaignRequest {
  type?: string;
  name?: string;
  subject?: string;
  from_email?: string;
  body?: string;
  body_source?: string | null;
  altbody?: string | null;
  content_type?: string;
  send_at?: string | null;
  headers?: Record<string, string>[];
  attribs?: Record<string, unknown> | null;
  tags?: string[];
  messenger?: string;
  template_id?: bigint | null;
  archive?: boolean;
  archive_slug?: string | null;
  archive_template_id?: bigint | null;
  archive_meta?: Record<string, unknown> | null;
  lists?: bigint[];
  media?: bigint[];
  subscribers?: string[];
  from?: string;
  to?: string;
  status?: string;
}

export async function readCampaignBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > LIMIT) throw new HttpError(413);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader)
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > LIMIT) {
          await reader.cancel();
          throw new HttpError(413);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  if (size === 0) return {};
  const media = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (media !== "application/json") throw new HttpError(415);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new HttpError(400);
  }
  if (parsed === null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400);
  return parsed as Record<string, unknown>;
}

const bad = (): never => {
  throw new HttpError(400);
};
const text = (value: unknown) =>
  typeof value === "string" && value.length <= TEXT_LIMIT ? value.toWellFormed() : bad();
const integer = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : bad();
const array = (value: unknown, max: number) =>
  Array.isArray(value) && value.length <= max ? value : bad();
const object = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : bad();
const strings = ["type", "name", "subject", "from_email", "body", "content_type", "messenger"];
const nullableStrings = ["altbody", "body_source", "archive_slug"];

/** Bind the known writable fields; type mismatches are Echo's 400 Bad Request. */
export function bindCampaign(input: Record<string, unknown>): CampaignRequest {
  const out: CampaignRequest = {};
  const o = out as Record<string, unknown>;
  for (const key of [...strings, "from", "to", "status"])
    if (input[key] !== undefined && input[key] !== null) o[key] = text(input[key]);
  for (const key of nullableStrings)
    if (input[key] !== undefined) o[key] = input[key] === null ? null : text(input[key]);
  if (input.send_at !== undefined) {
    const value = input.send_at;
    if (value === null) out.send_at = null;
    else {
      const raw = text(value);
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) ||
        !Number.isFinite(Date.parse(raw))
      )
        bad();
      out.send_at = new Date(Date.parse(raw)).toISOString();
    }
  }
  if (input.headers !== undefined && input.headers !== null)
    out.headers = array(input.headers, 1024).map((set) => {
      if (set === null) return {};
      const entries = Object.entries(object(set));
      if (entries.length > 1024) bad();
      return Object.fromEntries(entries.map(([k, v]) => [k, text(v)]));
    });
  if (input.attribs !== undefined)
    out.attribs = input.attribs === null ? null : object(input.attribs);
  if (input.archive_meta !== undefined)
    out.archive_meta = input.archive_meta === null ? null : object(input.archive_meta);
  if (input.tags !== undefined && input.tags !== null) out.tags = array(input.tags, 1024).map(text);
  for (const key of ["template_id", "archive_template_id"] as const)
    if (input[key] !== undefined) out[key] = input[key] === null ? null : integer(input[key]);
  if (input.archive !== undefined && input.archive !== null)
    out.archive = typeof input.archive === "boolean" ? input.archive : bad();
  for (const key of ["lists", "media"] as const)
    if (input[key] !== undefined)
      out[key] = input[key] === null ? [] : array(input[key], 10_000).map(integer);
  if (input.subscribers !== undefined)
    out.subscribers = input.subscribers === null ? [] : array(input.subscribers, 1000).map(text);
  return out;
}

const fromAddress = /((.+?)\s)?<(.+?)@(.+?)>/;
const slugChars = /[^\p{L}\p{M}\p{N}]/gu;
/** listmonk HasTplExpr, extended to Liquid tags. */
export const hasTemplate = (s: string) => /\{\{[\s\S]*\}\}/.test(s) || /\{%[\s\S]*%\}/.test(s);
/** UpdateCampaignArchive/validateCampaignFields slug format: lowercase alphanumeric-dash. */
export function slug(value: string): string {
  return value.toLowerCase().replace(slugChars, " ").trim().replace(/\s+/g, "-");
}

export interface FieldPolicy {
  t: Translation;
  defaultFrom: string;
  now: Date;
  messengers: string[];
  /** Compiles subject, from, body, alt body and header templates; throws a field message. */
  compile(value: WritableCampaign): string | null;
}
const invalid = (t: Translation, name: string): never => {
  throw new HttpError(400, t.Ts("globals.messages.invalidFields", "name", name));
};
/** validateCampaignFields on the merged request; returns the stored form. */
export function validateCampaign(c: WritableCampaign, listIds: bigint[], p: FieldPolicy) {
  const t = p.t;
  const value: WritableCampaign = { ...c };
  if (value.from_email === "") value.from_email = p.defaultFrom;
  else if (/[\r\n\0]/.test(value.from_email))
    throw new HttpError(400, t.T("campaigns.fieldInvalidFromEmail"));
  else if (
    !hasTemplate(value.from_email) &&
    !fromAddress.test(value.from_email) &&
    sanitizeEmail(value.from_email) === undefined &&
    parseAddress(value.from_email) === undefined
  )
    throw new HttpError(400, t.T("campaigns.fieldInvalidFromEmail"));
  if (!strHasLen(value.name, 1, 2000) || value.name.includes("\0"))
    throw new HttpError(400, t.T("campaigns.fieldInvalidName"));
  if (!strHasLen(value.subject, 1, 5000) || value.subject.includes("\0"))
    throw new HttpError(400, t.T("campaigns.fieldInvalidSubject"));
  if (!contentTypes.includes(value.content_type)) value.content_type = "richtext" as ContentType;
  if (value.content_type !== "visual") value.body_source = null;
  if (value.send_at !== null && Date.parse(value.send_at) < p.now.getTime())
    throw new HttpError(400, t.T("campaigns.fieldInvalidSendAt"));
  if (listIds.length === 0) throw new HttpError(400, t.T("campaigns.fieldInvalidListIDs"));
  if (!p.messengers.includes(value.messenger)) {
    // A removed or disabled named SMTP server falls back to the default messenger.
    if (value.messenger.startsWith("email-")) value.messenger = "email";
    else throw new HttpError(400, t.Ts("campaigns.fieldInvalidMessenger", "name", value.messenger));
  }
  for (const field of [value.body, value.altbody ?? "", value.body_source ?? ""])
    if (field.includes("\0")) invalid(t, "body");
  // Every header value is a template rendered per recipient; bound how many there are.
  if (value.headers.reduce((n, set) => n + Object.keys(set).length, 0) > MAX_HEADERS)
    invalid(t, "headers");
  for (const set of value.headers)
    for (const [name, header] of Object.entries(set))
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/.test(name) || /[\r\n\0]/.test(header))
        invalid(t, "headers");
  const error = p.compile(value);
  if (error !== null) throw new HttpError(400, t.Ts("campaigns.fieldInvalidBody", "error", error));
  if (JSON.stringify(value.attribs).length > 64 * 1024) invalid(t, "attribs");
  if (JSON.stringify(value.archive_meta).length > 64 * 1024) invalid(t, "archive_meta");
  if (value.tags.some((tag) => tag.includes("\0") || [...tag].length > 100)) invalid(t, "tags");
  if (value.archive_slug !== null && value.archive_slug !== "") {
    value.archive_slug = slug(value.archive_slug);
    if (!value.archive_slug) value.archive_slug = null;
  } else value.archive_slug = null;
  return value;
}

/** Combine the request with stored (update) or zero (create) values, as Echo's Bind does. */
export function mergeCampaign(base: WritableCampaign, r: CampaignRequest): WritableCampaign {
  return {
    type: (r.type ?? base.type) as WritableCampaign["type"],
    name: r.name ?? base.name,
    subject: r.subject ?? base.subject,
    from_email: r.from_email ?? base.from_email,
    body: r.body ?? base.body,
    body_source: r.body_source === undefined ? base.body_source : r.body_source,
    altbody: r.altbody === undefined ? base.altbody : r.altbody,
    content_type: (r.content_type ?? base.content_type) as ContentType,
    send_at: r.send_at === undefined ? base.send_at : r.send_at,
    headers: r.headers ?? base.headers,
    // UpdateCampaign clears attribs before binding: omission resets them.
    attribs: r.attribs ?? {},
    tags: normalizeTags(r.tags ?? base.tags),
    messenger: r.messenger ?? base.messenger,
    template_id: r.template_id === undefined ? base.template_id : r.template_id,
    archive: r.archive ?? base.archive,
    archive_slug: r.archive_slug === undefined ? base.archive_slug : r.archive_slug,
    archive_template_id:
      r.archive_template_id === undefined ? base.archive_template_id : r.archive_template_id,
    // D-campaign-json: null or omitted metadata keeps the stored object.
    archive_meta: r.archive_meta ?? base.archive_meta,
  };
}
export const emptyCampaign: WritableCampaign = {
  type: "regular",
  name: "",
  subject: "",
  from_email: "",
  body: "",
  body_source: null,
  altbody: null,
  content_type: "" as ContentType,
  send_at: null,
  headers: [],
  attribs: {},
  tags: [],
  messenger: "",
  template_id: null,
  archive: false,
  archive_slug: null,
  archive_template_id: null,
  archive_meta: {},
};
