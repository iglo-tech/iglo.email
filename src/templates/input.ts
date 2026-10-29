// Input binding adapted from listmonk models/templates.go and cmd/templates.go at 6fcd95f.
import { SaxesParser } from "saxes";
import type { RequestContext } from "@/server/context";
import { HttpError } from "@/server/response";
import type { TemplatePatch, TemplateType } from "@/templates/store";

const LIMIT = 512 * 1024;
export async function readTemplateBody(request: Request): Promise<Buffer> {
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
  return Buffer.concat(chunks, size);
}
type Field = "name" | "type" | "subject" | "body" | "body_source";
const fields: Readonly<Record<string, Field>> = Object.freeze({
  name: "name",
  type: "type",
  subject: "subject",
  body: "body",
  body_source: "body_source",
});
function set(out: TemplatePatch, key: string, value: unknown) {
  const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
  if (!field) return;
  if (value === null) {
    if (field === "body_source") out.body_source = null;
    return;
  }
  if (typeof value !== "string") throw new Error("Invalid field");
  if (field === "type") out.type = value.toWellFormed() as TemplateType;
  else out[field] = value.toWellFormed();
}
function jsonMembers(body: string): [string, unknown][] {
  const parsed: unknown = JSON.parse(body);
  if (parsed === null) return [];
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid document");
  const result: [string, unknown][] = [];
  const append = (member: string) =>
    result.push(...Object.entries(JSON.parse(`{${member}}`) as Record<string, unknown>));
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
function xmlInput(body: Buffer): TemplatePatch {
  const out: TemplatePatch = {};
  const names: Record<string, Field> = {
    Name: "name",
    Type: "type",
    Subject: "subject",
    Body: "body",
    BodySource: "body_source",
  };
  let depth = 0,
    complete = false,
    field: Field | undefined,
    text = "";
  const parser = new SaxesParser({ xmlns: false, defaultXMLVersion: "1.0", forceXMLVersion: true });
  parser.on("error", (error) => {
    throw error;
  });
  parser.on("doctype", () => {
    throw new Error("Invalid declaration");
  });
  parser.on("xmldecl", (declaration) => {
    if (
      declaration.version !== "1.0" ||
      (declaration.encoding && declaration.encoding.toLowerCase() !== "utf-8")
    )
      throw new Error("Invalid encoding");
  });
  parser.on("opentagstart", () => {
    if (depth >= 64) throw new Error("Depth");
  });
  parser.on("opentag", (tag) => {
    depth++;
    if (depth === 2) {
      const local = tag.name.slice(tag.name.indexOf(":") + 1);
      field = Object.hasOwn(names, local) ? names[local] : undefined;
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
      set(out, field, text);
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
  if (!complete) throw new Error("Missing root");
  return out;
}
export async function templateInput(context: RequestContext): Promise<TemplatePatch> {
  const body = await readTemplateBody(context.request);
  const type = context.request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  try {
    if (!body.length) return {};
    if (type === "application/json") {
      const out: TemplatePatch = {};
      for (const [key, value] of jsonMembers(body.toString("utf8")))
        set(out, key.toLowerCase().replaceAll("ſ", "s"), value);
      return out;
    }
    if (type === "application/xml" || type === "text/xml") return xmlInput(body);
    if (type === "application/x-www-form-urlencoded") {
      const form = body.toString("utf8");
      if (/%(?![0-9a-fA-F]{2})/.test(form) || form.includes(";")) throw new Error("Invalid form");
      // The upstream model has no form tags, so the binder leaves its fields unset.
      return {};
    }
    if (type === "multipart/form-data") {
      await new Request("http://fixture.invalid", {
        method: "POST",
        headers: { "content-type": context.request.headers.get("content-type") ?? "" },
        body: Uint8Array.from(body),
      }).formData();
      return {};
    }
    throw new HttpError(415);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400);
  }
}
