// XML binding follows listmonk models/settings.go with Echo's encoding/xml decoder.
import { SaxesParser } from "saxes";
import { int64, Members, parseStoredJson } from "@/settings/json";
import { xmlNames } from "@/settings/xml-names";

type Node = { name: string; text: string; children: Node[] };
function xmlRoot(body: Buffer): Node {
  const parser = new SaxesParser({ xmlns: false, defaultXMLVersion: "1.0", forceXMLVersion: true });
  let root: Node | undefined;
  let complete = false;
  const stack: Node[] = [];
  parser.on("error", (error) => {
    throw error;
  });
  parser.on("xmldecl", (decl) => {
    if (decl.version !== "1.0" || (decl.encoding && decl.encoding.toLowerCase() !== "utf-8"))
      throw new Error("encoding");
  });
  parser.on("doctype", () => {
    throw new Error("doctype");
  });
  parser.on("opentag", (tag) => {
    if (stack.length >= 64) throw new Error("depth");
    const node: Node = { name: tag.name.slice(tag.name.indexOf(":") + 1), text: "", children: [] };
    if (stack.length) stack[stack.length - 1]!.children.push(node);
    else root = node;
    stack.push(node);
  });
  const characters = (text: string) => {
    if (stack.length) stack[stack.length - 1]!.text += text;
  };
  parser.on("text", characters);
  parser.on("cdata", characters);
  parser.on("closetag", () => {
    stack.pop();
    if (!stack.length) complete = true;
  });
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== 62) continue;
    parser.write(decoder.decode(body.subarray(start, i + 1), { stream: true }));
    if (complete) break;
    start = i + 1;
  }
  if (!complete || !root) throw new Error("invalid XML");
  return root;
}
export function xmlValue(body: Buffer): string {
  return xmlRoot(body).text;
}
export function xmlSettings(body: Buffer, shapes: Record<string, unknown>): Members {
  const root = xmlRoot(body);
  function convert(node: Node, shape: any): unknown {
    if (shape === null) {
      if (!/^[-+]?\d+$/.test(node.text.trim())) throw new Error("invalid integer");
      const n = Number(node.text.trim());
      if (!Number.isSafeInteger(n)) throw new Error("invalid integer");
      return n;
    }
    if (typeof shape === "string") return node.text;
    if (typeof shape === "number") {
      if (!/^[-+]?\d+$/.test(node.text.trim())) throw new Error("invalid integer");
      const value = int64(parseStoredJson(BigInt(node.text.trim()).toString()));
      if (value === null) throw new Error("invalid integer");
      return value;
    }
    if (typeof shape === "boolean") {
      const value = node.text.trim();
      if (["1", "t", "T", "TRUE", "true", "True"].includes(value)) return true;
      if (["0", "f", "F", "FALSE", "false", "False"].includes(value)) return false;
      throw new Error("invalid boolean");
    }
    if (shape && typeof shape === "object") {
      if (Object.hasOwn(shape, "*")) throw new Error("unsupported XML map");
      return object(node, shape);
    }
    throw new Error("invalid XML field");
  }
  function object(node: Node, shape: Record<string, any>): Members {
    const entries: [string, unknown][] = [];
    const arrays = new Map<string, unknown[]>();
    for (const child of node.children) {
      const key = xmlNames[child.name];
      if (!key || !Object.hasOwn(shape, key)) continue;
      const field = shape[key];
      if (Array.isArray(field)) {
        let values = arrays.get(key);
        if (!values) {
          values = [];
          arrays.set(key, values);
          entries.push([key, values]);
        }
        values.push(convert(child, field[0]));
      } else entries.push([key, convert(child, field)]);
    }
    return new Members(entries);
  }
  return object(root, shapes);
}
