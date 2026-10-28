// Adapted from listmonk cmd/subscribers.go and internal/subimporter/importer.go at 6fcd95f.
import { SaxesParser } from "saxes";
import type { RequestContext } from "@/server/context";
import { HttpError } from "@/server/response";
import { readBodyBytes } from "@/users/input";

export interface SubscriberInput {
  email?: string;
  name?: string;
  status?: string;
  attribs?: Record<string, unknown> | null;
  external_id?: string | null;
  lists?: bigint[] | null;
  preconfirm_subscriptions?: boolean;
  ids?: bigint[] | null;
  target_list_ids?: bigint[] | null;
  action?: string;
}
const arrays = new Set(["lists", "ids", "target_list_ids"]);
const strings = new Set(["email", "name", "status", "action"]);
const fields = new Set([
  ...arrays,
  ...strings,
  "attribs",
  "external_id",
  "preconfirm_subscriptions",
]);
const max = 9223372036854775807n,
  min = -9223372036854775808n;
function id(value: unknown): bigint {
  if (value === null) return 0n;
  if (typeof value !== "bigint" || value < min || value > max) throw new Error("invalid id");
  return value;
}
function set(out: SubscriberInput, key: string, value: unknown) {
  if (!fields.has(key)) return;
  const record = out as Record<string, unknown>;
  if (arrays.has(key)) {
    if (value === null) record[key] = null;
    else if (Array.isArray(value)) record[key] = value.map(id);
    else throw new Error("invalid list");
  } else if (strings.has(key)) {
    if (value !== null) {
      if (typeof value !== "string") throw new Error("invalid string");
      record[key] = value.toWellFormed();
    }
  } else if (key === "external_id") {
    if (value !== null && (typeof value !== "string" || !validExternal(value)))
      throw new Error("invalid external ID");
    record[key] = value;
  } else if (key === "attribs") {
    if (value !== null && (typeof value !== "object" || Array.isArray(value)))
      throw new Error("invalid attributes");
    record[key] = value;
  } else if (value !== null) {
    if (typeof value !== "boolean") throw new Error("invalid boolean");
    record[key] = value;
  }
}
export function validExternal(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.toWellFormed() &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= 2000
  );
}
// Parse each top-level member independently, preserving aliases and duplicates.
function jsonInput(body: string): SubscriberInput {
  const document: unknown = JSON.parse(body);
  if (document === null) return {};
  if (typeof document !== "object" || Array.isArray(document)) throw new Error("object required");
  const out: SubscriberInput = {};
  function append(member: string) {
    const colon = (() => {
      let quoted = false,
        escaped = false;
      for (let i = 0; i < member.length; i++) {
        const c = member[i]!;
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === ":") return i;
      }
      return -1;
    })();
    const key = (JSON.parse(member.slice(0, colon)) as string).toLowerCase().replaceAll("ſ", "s");
    const raw = member.slice(colon + 1);
    const value: unknown = arrays.has(key)
      ? JSON.parse(raw, (_key: string, val: unknown, context?: { source?: string }) => {
          if (typeof val !== "number") return val;
          const source = context?.source ?? "";
          if (!/^-?(?:0|[1-9]\d*)$/.test(source)) throw new Error("invalid integer");
          return BigInt(source);
        })
      : JSON.parse(raw);
    if (
      key === "attribs" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      out.attribs
    )
      set(out, key, { ...out.attribs, ...value });
    else set(out, key, value);
  }
  let start = body.indexOf("{") + 1,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (depth) depth--;
      else if (c === "}") {
        const member = body.slice(start, i).trim();
        if (member) append(member);
        break;
      }
    } else if (c === "," && depth === 0) {
      append(body.slice(start, i));
      start = i + 1;
    }
  }
  return out;
}
function xmlInput(body: Buffer): SubscriberInput {
  const out: SubscriberInput = {};
  const names: Record<string, string> = {
    Email: "email",
    Name: "name",
    Status: "status",
    ExternalID: "external_id",
    Lists: "lists",
    PreconfirmSubs: "preconfirm_subscriptions",
    SubscriberIDs: "ids",
    TargetListIDs: "target_list_ids",
    Action: "action",
  };
  let depth = 0,
    complete = false,
    field: string | undefined,
    text = "";
  const parser = new SaxesParser({ xmlns: false, defaultXMLVersion: "1.0", forceXMLVersion: true });
  parser.on("error", (error) => {
    throw error;
  });
  parser.on("xmldecl", (d) => {
    if (d.version !== "1.0" || (d.encoding && d.encoding.toLowerCase() !== "utf-8"))
      throw new Error("declaration");
  });
  parser.on("doctype", () => {
    throw new Error("doctype");
  });
  parser.on("opentagstart", () => {
    if (depth >= 64) throw new Error("depth");
  });
  parser.on("opentag", (tag) => {
    depth++;
    if (depth === 2) {
      const local = tag.name.slice(tag.name.indexOf(":") + 1);
      if (local === "Attribs") throw new Error("unsupported XML map");
      field = names[local];
      text = "";
    }
  });
  const characters = (v: string) => {
    if (depth === 2 && field) text += v;
  };
  parser.on("text", characters);
  parser.on("cdata", characters);
  parser.on("closetag", () => {
    if (depth === 2 && field) {
      if (arrays.has(field)) {
        if (!/^[+-]?\d+$/.test(text.trim())) throw new Error("invalid integer");
        const n = id(BigInt(text.trim()));
        const rec = out as Record<string, unknown>;
        rec[field] = [...((rec[field] as bigint[] | undefined) ?? []), n];
      } else if (field === "preconfirm_subscriptions") {
        if (!["true", "false", "1", "0"].includes(text)) throw new Error("invalid boolean");
        set(out, field, text === "true" || text === "1");
      } else set(out, field, text);
      field = undefined;
    }
    if (--depth === 0) complete = true;
  });
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let start = 0;
  for (let i = 0; i < body.length; i++)
    if (body[i] === 62) {
      parser.write(decoder.decode(body.subarray(start, i + 1), { stream: true }));
      if (complete) return out;
      start = i + 1;
    }
  parser.write(decoder.decode(body.subarray(start)));
  parser.close();
  if (!complete) throw new Error("root required");
  return out;
}
export async function subscriberInput(context: RequestContext): Promise<SubscriberInput> {
  const body = await readBodyBytes(context.request);
  const type = context.request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  try {
    if (!body.length) return {};
    if (type === "application/json") return jsonInput(body.toString("utf8"));
    if (type === "application/xml" || type === "text/xml") return xmlInput(body);
    if (type === "application/x-www-form-urlencoded") {
      const out: SubscriberInput = {};
      for (const [k, v] of new URLSearchParams(body.toString("utf8")))
        if (k === "email" || k === "name") set(out, k, v);
      return out;
    }
    throw new HttpError(415);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400);
  }
}
