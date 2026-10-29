// Plain template data boundary for the contexts used by listmonk's manager/message.go at 6fcd95f.
import { types } from "node:util";
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

/** Copy data without evaluating getters or retaining caller-owned objects. */
export function copyTemplateData(input: unknown): TemplateData {
  let bytes = 0;
  let nodes = 0;
  const active = new Set<object>();
  const charge = (count: number) => {
    bytes += count;
    if (bytes > MAX_BYTES) throw new Error("Template data limit exceeded");
  };
  const text = (value: string) => {
    if (Buffer.byteLength(value) > MAX_STRING) throw new Error("Template data limit exceeded");
    charge(Buffer.byteLength(JSON.stringify(value)));
    return value;
  };
  function copy(value: unknown, depth: number): TemplateData {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("Template data limit exceeded");
    if (value === null) {
      charge(4);
      return null;
    }
    if (typeof value === "string") return text(value);
    if (typeof value === "boolean") {
      charge(value ? 4 : 5);
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      charge(Buffer.byteLength(JSON.stringify(value)));
      return value;
    }
    if (typeof value !== "object") throw new Error("Invalid template data");
    if (types.isProxy(value)) throw new Error("Invalid template data");
    if (active.has(value)) throw new Error("Invalid template data");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array) {
      if (prototype !== null && prototype !== Array.prototype) {
        if (types.isProxy(prototype)) throw new Error("Invalid template data");
        const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
        if (constructor && (!("value" in constructor) || constructor.value !== Array))
          throw new Error("Invalid template data");
      }
    } else if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Invalid template data");
    }
    active.add(value);
    try {
      charge(2);
      let enumerable = 0;
      for (const key in value)
        if (Object.hasOwn(value, key) && ++enumerable > MAX_ENTRIES)
          throw new Error("Template data limit exceeded");
      const names = Object.getOwnPropertyNames(value);
      if (names.length > MAX_ENTRIES + (array ? 1 : 0))
        throw new Error("Template data limit exceeded");
      for (const key of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in descriptor) || denied.has(key) || typeof descriptor.value === "function")
          throw new Error("Invalid template data");
      }
      if (Object.getOwnPropertySymbols(value).length) throw new Error("Invalid template data");
      if (array) {
        if (value.length > MAX_ENTRIES) throw new Error("Template data limit exceeded");
        const result: TemplateData[] = [];
        for (let i = 0; i < value.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (descriptor && !("value" in descriptor)) throw new Error("Invalid template data");
          if (i) charge(1);
          // Holes become own nulls; inherited indices are never read.
          result.push(copy(descriptor ? descriptor.value : null, depth + 1));
        }
        return result;
      }
      const result: { [key: string]: TemplateData } = Object.create(null);
      let entries = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (++entries > MAX_ENTRIES || denied.has(key)) throw new Error("Invalid template data");
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in descriptor)) throw new Error("Invalid template data");
        if (entries > 1) charge(1);
        text(key);
        charge(1);
        result[key] = copy(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      active.delete(value);
    }
  }
  return copy(input, 0);
}
