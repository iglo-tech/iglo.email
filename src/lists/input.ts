// Adapted from listmonk cmd/lists.go, models/lists.go and Echo v5.4.0 binding at 6fcd95f.
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { ListInput } from "@/lists/store";
import { normalizeTags } from "@/lists/store";
import type { RequestContext } from "@/server/context";
import { HttpError } from "@/server/response";
import { strHasLen } from "@/server/validation";
import { readBody } from "@/users/input";

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

type XmlNode = Record<string, unknown>;
const xmlCharacter = (n: number) =>
  n === 9 ||
  n === 10 ||
  n === 13 ||
  (n >= 32 && n <= 0xd7ff) ||
  (n >= 0xe000 && n <= 0xfffd) ||
  (n >= 0x10000 && n <= 0x10ffff);
function xmlInput(body: string): ListInput {
  // Reject declarations before the parser can register or expand them. Skip
  // comments, CDATA and processing instructions, where this text is literal.
  const markup = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!/g;
  const safe = body.replace(markup, (part) => {
    if (part === "<!") throw new Error("declaration");
    return "";
  });
  // FXP validates syntax but leaves unknown references intact; Go rejects them.
  for (const match of safe.matchAll(/&([^;\s<&]*);/g)) {
    const ref = match[1]!;
    if (/^(amp|lt|gt|apos|quot)$/.test(ref)) continue;
    if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(ref)) throw new Error("entity");
    const n =
      ref[1] === "x" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
    if (!xmlCharacter(n)) throw new Error("character reference");
  }
  const parser = new XMLParser({
    preserveOrder: true,
    captureMetaData: true,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: false,
    ignorePiTags: true,
    htmlEntities: true,
    maxNestedTags: 64,
    jPath: false,
    updateTag: (_name, path) => {
      if (typeof path === "string" || path.getDepth() > 64) throw new Error("depth");
      return true;
    },
  });
  // The dependency bounds its reference scan. Canonicalize validated numeric
  // references so legal leading zeroes cannot turn decoded text into literals.
  // Comments, CDATA and instructions remain literal and are never rewritten.
  const xml = body
    .replace(
      /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|&#(?:[0-9]+|x[0-9a-fA-F]+);/g,
      (part) =>
        part.startsWith("&#")
          ? `&#${part[2] === "x" ? Number.parseInt(part.slice(3, -1), 16) : Number.parseInt(part.slice(2, -1), 10)};`
          : part,
    )
    .replace(/\r\n?/g, "\n");
  let nodes: XmlNode[];
  if (XMLValidator.validate(xml) === true) nodes = parser.parse(xml) as XmlNode[];
  else {
    // encoding/xml.Decode consumes only the first document. Use FXP's node
    // offsets, then validate that complete first element before mapping it.
    const parsed = parser.parse(xml) as XmlNode[];
    const first = parsed[0];
    const metadata = (first as Record<PropertyKey, unknown> | undefined)?.[
      XMLParser.getMetaDataSymbol() as symbol
    ] as { endIndex?: number } | undefined;
    if (!metadata?.endIndex || XMLValidator.validate(xml.slice(0, metadata.endIndex)) !== true)
      throw new Error("invalid xml");
    nodes = [first!];
  }
  const root = nodes.find((node) => Object.keys(node).some((key) => !key.startsWith("?")));
  if (!root) throw new Error("root");
  const metadata = (root as Record<PropertyKey, unknown>)[
    XMLParser.getMetaDataSymbol() as symbol
  ] as { endIndex?: number } | undefined;
  if (!metadata?.endIndex) throw new Error("root offset");
  // Validate the consumed document, including ignored elements and CDATA. Like
  // encoding/xml.Decode, leave bytes after the complete first root unconsumed.
  for (const char of xml.slice(0, metadata.endIndex))
    if (!xmlCharacter(char.codePointAt(0)!)) throw new Error("XML character");
  const children = Object.values(root)[0] as XmlNode[];
  const out = empty();
  const xmlFields: Record<string, StringField> = {
    Name: "name",
    Type: "type",
    Optin: "optin",
    Status: "status",
    Description: "description",
  };
  for (const node of children) {
    const [name, value] = Object.entries(node)[0] ?? [];
    if (!name || !Array.isArray(value)) continue;
    const text = (value as XmlNode[])
      .map((child) => (typeof child["#text"] === "string" ? child["#text"] : ""))
      .join("");
    const field = Object.hasOwn(xmlFields, name) ? xmlFields[name] : undefined;
    if (field) out[field] = text;
    else if (name === "Tags") out.tags.push(text);
  }
  return out;
}

export async function listInput(context: RequestContext): Promise<ListInput> {
  const body = await readBody(context.request);
  const type = context.request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  let value: ListInput;
  try {
    if (!body) value = empty();
    else if (type === "application/json") value = jsonInput(body);
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
