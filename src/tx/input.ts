// Request binding adapted from listmonk cmd/tx.go (SendTxMessage) and
// models/messages.go (TxMessage) at 6fcd95f, with Go encoding/json field rules.
import { HttpError } from "@/server/response";

/** Matches the M2.2 prepared-payload attachment bound plus room for the data field. */
const BODY_LIMIT = 5 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export interface TxAttachment {
  name: string;
  contentType: string;
  content: Uint8Array;
}
export interface TxMessage {
  subscriberMode: string;
  subscriberEmails: string[];
  subscriberIds: bigint[];
  subscriberEmail: string;
  subscriberId: bigint;
  subscriberExternalId: string;
  templateId: bigint;
  /** Serialized JSON object, or null when absent. */
  data: string | null;
  fromEmail: string;
  headers: Array<Record<string, string>>;
  contentType: string;
  messenger: string;
  subject: string;
  altBody: string;
  kind: string;
  listId: bigint;
  idempotencyKey: string;
  async: boolean;
  attachments: TxAttachment[];
}
/** Invalid input with an upstream-style `Invalid fields` name. */
export class TxInputError extends Error {
  constructor(readonly field: string) {
    super(field);
  }
}

async function readBounded(request: Request): Promise<Buffer<ArrayBuffer>> {
  if (Number(request.headers.get("content-length")) > BODY_LIMIT) throw new HttpError(413);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader)
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > BODY_LIMIT) {
          await reader.cancel();
          throw new HttpError(413);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  return Buffer.concat(chunks, size);
}

function empty(): TxMessage {
  return {
    subscriberMode: "",
    subscriberEmails: [],
    subscriberIds: [],
    subscriberEmail: "",
    subscriberId: 0n,
    subscriberExternalId: "",
    templateId: 0n,
    data: null,
    fromEmail: "",
    headers: [],
    contentType: "",
    messenger: "",
    subject: "",
    altBody: "",
    kind: "",
    listId: 0n,
    idempotencyKey: "",
    async: false,
    attachments: [],
  };
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
type Sources = WeakMap<object, Map<string, string>>;
function int(value: unknown, holder: object, key: string, sources: Sources): bigint {
  if (value === null) return 0n;
  if (typeof value !== "number") throw new TxInputError(key);
  // Go decodes an int only from integer syntax, exactly and within int64.
  const source = sources.get(holder)?.get(key);
  if (source === undefined || !/^-?(?:0|[1-9]\d*)$/.test(source)) throw new TxInputError(key);
  const result = BigInt(source);
  if (result < INT64_MIN || result > INT64_MAX) throw new TxInputError(key);
  return result;
}
const str = (value: unknown, key: string): string => {
  if (value === null) return "";
  if (typeof value !== "string") throw new TxInputError(key);
  return value;
};
function list<T>(value: unknown, key: string, item: (value: unknown, index: number) => T): T[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new TxInputError(key);
  return value.map(item);
}

/** Bind one JSON document with Go's case-insensitive, type-strict field matching. */
function bindJSON(text: string, out: TxMessage) {
  const sources: Sources = new WeakMap();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, function (this: object, key, value, context?: { source?: string }) {
      if (typeof value === "number" && context?.source !== undefined) {
        let entries = sources.get(this);
        if (!entries) sources.set(this, (entries = new Map()));
        entries.set(key, context.source);
      }
      return value;
    });
  } catch {
    throw new TxInputError("body");
  }
  if (parsed === null) return;
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new TxInputError("body");
  for (const [rawKey, value] of Object.entries(parsed)) {
    const key = rawKey.toLowerCase().replaceAll("ſ", "s");
    switch (key) {
      case "subscriber_mode":
        out.subscriberMode = str(value, key);
        break;
      case "subscriber_emails":
        out.subscriberEmails = list(value, key, (v) => str(v, key));
        break;
      case "subscriber_ids":
        out.subscriberIds = list(value, key, (v, i) => int(v, value as object, String(i), sources));
        break;
      case "subscriber_email":
        out.subscriberEmail = str(value, key);
        break;
      case "subscriber_id":
        out.subscriberId = int(value, parsed, rawKey, sources);
        break;
      case "subscriber_external_id":
        out.subscriberExternalId = str(value, key);
        break;
      case "template_id":
        out.templateId = int(value, parsed, rawKey, sources);
        break;
      case "data":
        if (value === null) out.data = null;
        else if (typeof value !== "object" || Array.isArray(value)) throw new TxInputError(key);
        else out.data = JSON.stringify(value);
        break;
      case "from_email":
        out.fromEmail = str(value, key);
        break;
      case "headers":
        out.headers = list(value, key, (set) => {
          if (set === null) return {};
          if (typeof set !== "object" || Array.isArray(set)) throw new TxInputError(key);
          const result: Record<string, string> = Object.create(null);
          for (const [name, v] of Object.entries(set)) result[name] = str(v, key);
          return result;
        });
        break;
      case "content_type":
        out.contentType = str(value, key);
        break;
      case "messenger":
        out.messenger = str(value, key);
        break;
      case "subject":
        out.subject = str(value, key);
        break;
      case "altbody":
        out.altBody = str(value, key);
        break;
      case "kind":
        out.kind = str(value, key);
        break;
      case "list_id":
        out.listId = int(value, parsed, rawKey, sources);
        break;
      case "idempotency_key":
        out.idempotencyKey = str(value, key);
        break;
      case "async":
        if (value !== null && typeof value !== "boolean") throw new TxInputError(key);
        out.async = value === true;
        break;
    }
  }
}

/** Go's multipart FileName applies filepath.Base. */
function baseName(name: string): string {
  const trimmed = name.replace(/\/+$/, "");
  if (!trimmed) return name ? "/" : "";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export async function readTxMessage(request: Request): Promise<TxMessage> {
  const body = await readBounded(request);
  const header = request.headers.get("content-type") ?? "";
  const out = empty();
  if (header.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await new Response(body, { headers: { "content-type": header } }).formData();
    } catch {
      throw new TxInputError("form");
    }
    const data = form.getAll("data").filter((v) => typeof v === "string");
    if (data.length !== 1) throw new TxInputError("data");
    bindJSON(data[0]!, out);
    let total = 0;
    for (const file of form.getAll("file")) {
      // Go's form.File contains only parts with a file name.
      if (typeof file === "string" || !file.name) continue;
      if (out.attachments.length >= MAX_FILES) throw new TxInputError("file");
      total += file.size;
      if (total > MAX_ATTACHMENT_BYTES) throw new HttpError(413);
      out.attachments.push({
        name: baseName(file.name),
        contentType: file.type || "application/octet-stream",
        content: new Uint8Array(await file.arrayBuffer()),
      });
    }
    return out;
  }
  // Echo leaves fields at their defaults when there is no body to bind.
  if (!body.length) return out;
  const type = header.split(";", 1)[0]!.trim().toLowerCase();
  if (type === "application/json") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(body);
    } catch {
      throw new TxInputError("body");
    }
    bindJSON(text, out);
    return out;
  }
  // TxMessage has no form tags; Echo's form binder leaves its fields unset.
  if (type === "application/x-www-form-urlencoded") return out;
  if (type === "application/xml" || type === "text/xml") throw new TxInputError("body");
  throw new HttpError(415);
}
