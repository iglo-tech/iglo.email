// Adapted from listmonk cmd/subscribers.go and internal/subimporter/importer.go at 6fcd95f.
import { SaxesParser } from "saxes";
import type { RequestContext } from "@/server/context";
import { HttpError } from "@/server/response";
import { readBodyBytes } from "@/users/input";
import { trimSpace } from "@/lists/store";

export interface SubscriberInput {
  email?: string;
  name?: string;
  status?: string;
  attribs?: Record<string, unknown> | null;
  // Transient binding state, never populated from a request field.
  attribsReset?: boolean;
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
/** SQLite's JSON_MAX_DEPTH. */
const MAX_ATTRIBS_DEPTH = 1000;
const max = 9223372036854775807n,
  min = -9223372036854775808n;
function id(value: unknown): bigint {
  if (value === null) return 0n;
  if (typeof value !== "bigint" || value < min || value > max) throw new Error("invalid id");
  return value;
}
type Operation = "crud" | "blocklist" | "membership" | "single-membership";
const operationFields: Record<Operation, ReadonlySet<string>> = {
  crud: new Set([
    "email",
    "name",
    "status",
    "attribs",
    "external_id",
    "lists",
    "preconfirm_subscriptions",
  ]),
  blocklist: new Set(["ids"]),
  membership: new Set(["ids", "target_list_ids", "action", "status"]),
  "single-membership": new Set(["target_list_ids", "action", "status"]),
};
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
// Check final operation-owned attributes after duplicate/null binding has settled.
export function validAttributes(value: SubscriberInput["attribs"]): boolean {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") {
      if (item.includes("\0")) return false;
    } else if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (key.includes("\0")) return false;
        pending.push(child);
      }
    }
  }
  return true;
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
// Validate every numeric token, including values later overwritten by duplicate keys.
function finiteNumbers(raw: string) {
  let quoted = false,
    escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "-" || (c >= "0" && c <= "9")) {
      const token = raw.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
      if (!token || !Number.isFinite(Number(token))) throw new Error("invalid number");
      i += token.length - 1;
    }
  }
}
// Normalize JSON strings before parsing so keys that collapse to U+FFFD retain
// their original duplicate-member order, as encoding/json does.
function normalizeStrings(raw: string): string {
  let result = "",
    start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '"') continue;
    const begin = i;
    let escaped = false;
    while (++i < raw.length) {
      const c = raw[i]!;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') break;
    }
    result +=
      raw.slice(start, begin) +
      JSON.stringify((JSON.parse(raw.slice(begin, i + 1)) as string).toWellFormed());
    start = i + 1;
  }
  return result + raw.slice(start);
}
/**
 * The attribute object in `raw`, under the rules `attribs` binds with, or null for JSON `null`.
 * Throws when it holds anything else, or nests deeper than SQLite's json_valid accepts.
 */
export function parseAttributes(raw: string): Record<string, unknown> | null {
  finiteNumbers(raw);
  const value: unknown = JSON.parse(normalizeStrings(raw));
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
  const attribs = value as Record<string, unknown>;
  if (!validAttributes(attribs)) throw new Error("NUL character");
  const pending: [unknown, number][] = [[attribs, 1]];
  while (pending.length) {
    const [item, depth] = pending.pop()!;
    if (depth > MAX_ATTRIBS_DEPTH) throw new Error("nested too deeply");
    if (item && typeof item === "object")
      for (const child of Object.values(item)) pending.push([child, depth + 1]);
  }
  return attribs;
}
function jsonInput(
  body: string,
  allowed: ReadonlySet<string>,
  operation: Operation,
): SubscriberInput {
  const document: unknown = JSON.parse(body);
  if (document === null) return {};
  if (typeof document !== "object" || Array.isArray(document)) throw new Error("object required");
  const out: SubscriberInput = {};
  const backing = new Map<string, bigint[]>();
  const actionStatuses: string[] = [];
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
    if (!allowed.has(key)) return;
    if (key === "status" && (operation === "membership" || operation === "single-membership")) {
      actionStatuses.push(raw);
      return;
    }
    if (key === "attribs") finiteNumbers(raw);
    let value: unknown = arrays.has(key)
      ? JSON.parse(raw, (_key: string, val: unknown, context?: { source?: string }) => {
          if (typeof val !== "number") return val;
          const source = context?.source ?? "";
          if (!/^-?(?:0|[1-9]\d*)$/.test(source)) throw new Error("invalid integer");
          return BigInt(source);
        })
      : JSON.parse(key === "attribs" ? normalizeStrings(raw) : raw);
    if (arrays.has(key)) {
      if (value === null) backing.delete(key);
      else if (Array.isArray(value)) {
        if (!value.length) backing.delete(key);
        const cells = backing.get(key) ?? [];
        const mapped = value.map((item, index) => {
          const n = item === null ? (cells[index] ?? 0n) : id(item);
          cells[index] = n;
          return n;
        });
        value = mapped;
        if (mapped.length) backing.set(key, cells);
      }
    }
    if (key === "attribs") {
      if (value === null) out.attribsReset = true;
    }
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
  if (out.action === "add") for (const raw of actionStatuses) set(out, "status", JSON.parse(raw));
  return out;
}
function xmlInput(body: Buffer, allowed: ReadonlySet<string>): SubscriberInput {
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
      if (local === "Attribs" && allowed.has("attribs")) throw new Error("unsupported XML map");
      field = names[local];
      if (field && !allowed.has(field)) field = undefined;
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
        const scalar = text.length ? trimSpace(text) : "0";
        if (!/^[+-]?\d+$/.test(scalar)) throw new Error("invalid integer");
        const n = id(BigInt(scalar));
        const rec = out as Record<string, unknown>;
        rec[field] = [...((rec[field] as bigint[] | undefined) ?? []), n];
      } else if (field === "preconfirm_subscriptions") {
        const scalar = text.length ? trimSpace(text) : "false";
        if (
          ![
            "1",
            "t",
            "T",
            "TRUE",
            "true",
            "True",
            "0",
            "f",
            "F",
            "FALSE",
            "false",
            "False",
          ].includes(scalar)
        )
          throw new Error("invalid boolean");
        set(out, field, ["1", "t", "T", "TRUE", "true", "True"].includes(scalar));
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
export async function subscriberInput(
  context: RequestContext,
  operation: Operation,
): Promise<SubscriberInput> {
  const allowed = operationFields[operation];
  const body = await readBodyBytes(context.request);
  const type = context.request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  try {
    if (!body.length) return {};
    if (type === "application/json") return jsonInput(body.toString("utf8"), allowed, operation);
    if (type === "application/xml" || type === "text/xml") return xmlInput(body, allowed);
    if (type === "application/x-www-form-urlencoded" || type === "multipart/form-data") {
      const out: SubscriberInput = {};
      const values: [string, string][] = [];
      if (type === "application/x-www-form-urlencoded") {
        const encoded = body.toString("utf8"),
          query = context.url.search.slice(1);
        for (const part of [encoded, query])
          if (/%(?![a-fA-F0-9]{2})/.test(part) || part.includes(";"))
            throw new Error("invalid form");
        values.push(...new URLSearchParams(encoded));
        values.push(...new URLSearchParams(query));
      } else {
        const form = await new Response(Uint8Array.from(body), {
          headers: { "Content-Type": context.request.headers.get("content-type")! },
        }).formData();
        for (const [key, value] of form) if (typeof value === "string") values.push([key, value]);
      }
      if (operation !== "crud") return out;
      for (const field of ["email", "name"]) {
        const entry =
          values.find(([key]) => key === field) ??
          values.find(([key]) => key.toLowerCase() === field);
        if (entry) set(out, field, entry[1]);
      }
      return out;
    }
    throw new HttpError(415);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400);
  }
}
