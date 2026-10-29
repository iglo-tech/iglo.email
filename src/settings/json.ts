// Ordered settings JSON and UTF-8 decoding follow Go encoding/json and unicode/utf8 at Go 1.27.2.
// The Go BSD notice is embedded from assets/licenses/go-1.27.2-BSD.txt.
export class Members {
  constructor(readonly entries: [string, unknown][]) {}
}
// DecodeRune consumes one byte on invalid input, unlike WHATWG maximal-subpart replacement.
export function decodeJsonBytes(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index]!;
    if (first < 128) {
      out.push(String.fromCharCode(first));
      index++;
      continue;
    }
    const width = first >= 0xc2 && first <= 0xf4 ? (first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4) : 0;
    let valid = width > 0 && index + width <= bytes.length;
    let rune = first & (width === 2 ? 31 : width === 3 ? 15 : 7);
    for (let offset = 1; valid && offset < width; offset++) {
      const next = bytes[index + offset]!;
      valid = (next & 0xc0) === 0x80;
      rune = (rune << 6) | (next & 63);
    }
    const minimum = width === 2 ? 0x80 : width === 3 ? 0x800 : 0x10000;
    valid &&= rune >= minimum && rune <= 0x10ffff && (rune < 0xd800 || rune > 0xdfff);
    out.push(valid ? String.fromCodePoint(rune) : "\ufffd");
    index += valid ? width : 1;
  }
  return out.join("");
}
const raw = JSON as typeof JSON & {
  rawJSON(value: string): unknown;
  isRawJSON(value: unknown): boolean;
};
export function parseStoredJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    const source = context?.source ?? "";
    if (!/^-?(?:0|[1-9]\d*)$/.test(source) || !Number.isSafeInteger(value))
      return raw.rawJSON(source);
    return value;
  });
}
export function cloneJson<T>(value: T): T {
  return parseStoredJson(JSON.stringify(value)) as T;
}
export function int64(value: unknown): number | object | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (!raw.isRawJSON(value)) return null;
  const source = (value as { rawJSON: string }).rawJSON;
  if (!/^-?(?:0|[1-9]\d*)$/.test(source)) return null;
  const n = BigInt(source);
  if (n < -9223372036854775808n || n > 9223372036854775807n) return null;
  return value as object;
}
export function orderedJson(text: string): unknown {
  // Validate the whole document before retaining its ordered members.
  JSON.parse(text);
  let pos = 0;
  const ws = () => {
    while (/\s/.test(text[pos] ?? "") && pos < text.length) pos++;
  };
  const token = (): string => {
    const start = pos++;
    let escaped = false;
    while (pos < text.length) {
      const c = text[pos++]!;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') break;
    }
    return text.slice(start, pos);
  };
  function value(): unknown {
    ws();
    if (text[pos] === "{") {
      pos++;
      ws();
      const entries: [string, unknown][] = [];
      while (text[pos] !== "}") {
        const key = (JSON.parse(token()) as string).toWellFormed();
        ws();
        pos++; // colon
        entries.push([key, value()]);
        ws();
        if (text[pos] !== ",") break;
        pos++;
        ws();
      }
      pos++;
      return new Members(entries);
    }
    if (text[pos] === "[") {
      pos++;
      ws();
      const result: unknown[] = [];
      while (text[pos] !== "]") {
        result.push(value());
        ws();
        if (text[pos] !== ",") break;
        pos++;
        ws();
      }
      pos++;
      return result;
    }
    if (text[pos] === '"') return (JSON.parse(token()) as string).toWellFormed();
    const start = pos;
    while (pos < text.length && !/[\s,\]}]/.test(text[pos]!)) pos++;
    return parseStoredJson(text.slice(start, pos));
  }
  return value();
}
