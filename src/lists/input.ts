// Adapted from listmonk cmd/lists.go, models/lists.go and Echo v5.4.0 binding at 6fcd95f.
import { SaxesParser } from "saxes";
import type { ListInput } from "@/lists/store";
import { normalizeTags } from "@/lists/store";
import type { RequestContext } from "@/server/context";
import { HttpError } from "@/server/response";
import { strHasLen } from "@/server/validation";
import { readBodyBytes } from "@/users/input";

const empty = (): ListInput => ({
  name: "",
  type: "",
  optin: "",
  status: "",
  description: null,
  tags: [],
});
type StringField = "name" | "type" | "optin" | "status" | "description";
const stringFields: Record<string, StringField> = {
  name: "name",
  type: "type",
  optin: "optin",
  status: "status",
  description: "description",
};

// JSON.parse validates the complete document. Split only its top-level members
// afterward so duplicate keys and case aliases are applied in source order.
function jsonMembers(body: string): [string, unknown][] {
  const parsed: unknown = JSON.parse(body);
  if (parsed === null) return [];
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
  const result: [string, unknown][] = [];
  const append = (member: string) => {
    const value = JSON.parse(`{${member}}`) as Record<string, unknown>;
    result.push(...Object.entries(value));
  };
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
  return result;
}
function jsonInput(body: string): ListInput {
  const out = empty();
  let tagStorage: string[] = [];
  for (const [key, value] of jsonMembers(body)) {
    const normalizedKey = key.toLowerCase().replaceAll("ſ", "s");
    const field = Object.hasOwn(stringFields, normalizedKey)
      ? stringFields[normalizedKey]
      : undefined;
    if (field) {
      if (value === null) continue;
      if (typeof value !== "string") throw new Error("invalid string");
      out[field] = value.toWellFormed();
    } else if (normalizedKey === "tags") {
      if (value === null || (Array.isArray(value) && value.length === 0)) {
        out.tags = [];
        tagStorage = [];
      } else {
        if (
          !Array.isArray(value) ||
          value.some((v: unknown) => v !== null && typeof v !== "string")
        )
          throw new Error("invalid tags");
        out.tags = value.map((v: string | null, i: number) => {
          const text = v?.toWellFormed() ?? tagStorage[i] ?? "";
          tagStorage[i] = text;
          return text;
        });
      }
    }
    // D36: response-only and unknown fields cannot assign metadata. Ignore
    // their values rather than validating discarded read-model internals.
  }
  return out;
}

// Go's XML decoder consumes one root. Feeding at ASCII > byte boundaries
// permits fatal UTF-8 decoding without touching bytes after the closing root.
function xmlInput(body: Buffer): ListInput {
  const out = empty();
  const fields: Record<string, StringField> = {
    Name: "name",
    Type: "type",
    Optin: "optin",
    Status: "status",
    Description: "description",
  };
  let depth = 0,
    complete = false,
    field: StringField | "tags" | undefined,
    text = "";
  const parser = new SaxesParser({ xmlns: false, defaultXMLVersion: "1.0", forceXMLVersion: true });
  parser.on("error", (error) => {
    throw error;
  });
  parser.on("xmldecl", (declaration) => {
    if (
      declaration.version !== "1.0" ||
      (declaration.encoding && declaration.encoding.toLowerCase() !== "utf-8")
    )
      throw new Error("unsupported XML declaration");
  });
  // Saxes neither registers DTD entities nor resolves external declarations.
  parser.on("doctype", () => {
    throw new Error("declaration");
  });
  parser.on("opentagstart", () => {
    if (depth >= 64) throw new Error("depth");
  });
  parser.on("opentag", (tag) => {
    depth++;
    if (depth === 2) {
      const local = tag.name.slice(tag.name.indexOf(":") + 1);
      field = local === "Tags" ? "tags" : Object.hasOwn(fields, local) ? fields[local] : undefined;
      text = "";
    }
  });
  const characters = (value: string) => {
    if (depth === 2 && field) text += value;
  };
  parser.on("text", characters);
  parser.on("cdata", characters);
  parser.on("closetag", () => {
    if (depth === 2 && field) {
      if (field === "tags") out.tags.push(text);
      else out[field] = text;
      field = undefined;
    }
    if (--depth === 0) complete = true;
  });
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== 62) continue;
    parser.write(decoder.decode(body.subarray(start, i + 1), { stream: true }));
    if (complete) return out;
    start = i + 1;
  }
  parser.write(decoder.decode(body.subarray(start)));
  parser.close();
  if (!complete) throw new Error("root required");
  return out;
}

export async function listInput(context: RequestContext): Promise<ListInput> {
  const body = await readBodyBytes(context.request);
  const type = context.request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  let value: ListInput;
  try {
    if (!body.length) value = empty();
    else if (type === "application/json") value = jsonInput(body.toString("utf8"));
    else if (type === "application/xml" || type === "text/xml") value = xmlInput(body);
    else throw new HttpError(415);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400);
  }
  if (!strHasLen(value.name, 1, 2000))
    throw new HttpError(400, context.app.i18n.T("globals.messages.invalidName"));
  for (const [name, field, allowed] of [
    ["type", value.type, ["public", "private"]],
    ["optin", value.optin, ["single", "double"]],
    ["status", value.status, ["active", "archived"]],
  ] as const)
    if (field && !(allowed as readonly string[]).includes(field))
      throw new HttpError(400, context.app.i18n.Ts("globals.messages.invalidFields", "name", name));
  if (normalizeTags(value.tags).some((tag) => Array.from(tag).length > 100))
    throw new HttpError(400, context.app.i18n.Ts("globals.messages.invalidFields", "name", "tags"));
  return value;
}
