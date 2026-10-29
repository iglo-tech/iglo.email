// Serialized template context for listmonk's manager/message.go at 6fcd95f.
const MAX_BYTES = 256 * 1024;
const MAX_STRING = 64 * 1024;
const MAX_NODES = 10_000;
const MAX_ENTRIES = 1_024;
const MAX_DEPTH = 16;
const denied = new Set(["__proto__", "prototype", "constructor"]);

export type TemplateData =
  | null
  | boolean
  | number
  | string
  | TemplateData[]
  | { [key: string]: TemplateData };

/** Admit only bounded wire data. No operation on a non-string caller value is performed. */
export function parseTemplateData(input: unknown): { [key: string]: TemplateData } {
  if (typeof input !== "string") throw new Error("Invalid template data");
  if (Buffer.byteLength(input, "utf8") > MAX_BYTES) throw new Error("Template data limit exceeded");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Invalid template data");
  }
  let nodes = 0;
  function copy(value: unknown, depth: number): TemplateData {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("Template data limit exceeded");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > MAX_STRING)
        throw new Error("Template data limit exceeded");
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object") throw new Error("Invalid template data");
    if (Array.isArray(value)) {
      if (value.length > MAX_ENTRIES) throw new Error("Template data limit exceeded");
      return value.map((item) => copy(item, depth + 1));
    }
    // JSON.parse creates ordinary own data properties; the bounded input limits
    // the allocation of its keys before this enumeration.
    const keys = Object.keys(value);
    if (keys.length > MAX_ENTRIES) throw new Error("Template data limit exceeded");
    const result: { [key: string]: TemplateData } = Object.create(null);
    for (const key of keys) {
      if (denied.has(key)) throw new Error("Invalid template data");
      if (Buffer.byteLength(key, "utf8") > MAX_STRING)
        throw new Error("Template data limit exceeded");
      result[key] = copy((value as Record<string, unknown>)[key], depth + 1);
    }
    return result;
  }
  const result = copy(parsed, 0);
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid template data");
  return result;
}
