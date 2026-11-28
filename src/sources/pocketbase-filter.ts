// Native (15-external-sources section 6, D170, D188): the PocketBase connector's filter literals and
// dates. A filter travels as text over HTTP with no bound parameters, so every value is written as a
// literal here and nowhere else. Measured against the 0.40.5 binary (test/sources/filter.test.ts): a single-quoted
// literal with each backslash and each single quote escaped by a backslash reads back exactly,
// whatever the text holds (quotes, backslashes, `&&`, `||`, unicode).
import { SourceError, UnfitQuery } from "@/sources/source";
import type { SourceScalar } from "@/sources/source";

/** A field, collection or JSON path segment name the adapter writes into a filter or a path. */
export const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
/** One segment of a `data.*` path: a key or an array index. */
const segmentPattern = /^[A-Za-z0-9_]{1,64}$/;
const MAX_SEGMENTS = 8;
/** The longest text literal, in UTF-8 bytes. */
const MAX_TEXT_BYTES = 4096;

/** A text literal. */
export function textLiteral(value: string): string {
  if (value.includes("\0") || Buffer.byteLength(value, "utf-8") > MAX_TEXT_BYTES) {
    throw new UnfitQuery("A filter value is too long or holds a NUL character");
  }
  return `'${value
    .toWellFormed()
    .replaceAll("\\", String.raw`\\`)
    .replaceAll("'", String.raw`\'`)}'`;
}

/** Any scalar as a literal. A number must be finite and written without an exponent. */
export function scalarLiteral(value: SourceScalar | null): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    const text = String(value);
    if (!Number.isFinite(value) || /e/i.test(text)) {
      throw new UnfitQuery(`A filter number is out of range: ${text}`);
    }
    return text;
  }
  return textLiteral(value);
}

/** PocketBase's date text: `YYYY-MM-DD HH:mm:ss.sssZ`, UTC. */
export function sourceDate(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    throw new UnfitQuery("A filter date is invalid");
  }
  return date.toISOString().replace("T", " ");
}

/** A date PocketBase returned, or `undefined` when it holds none. */
export function parseSourceDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  const date = new Date(value.replace(" ", "T"));
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/** A date literal for a comparison with a date field. */
export const dateLiteral = (date: Date) => textLiteral(sourceDate(date));

/** A field name checked before it is written into a filter. */
export function fieldName(name: string): string {
  if (!identifierPattern.test(name)) {
    throw new SourceError("permanent", `Not a field name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** `<field>.<path>` for a path inside a JSON field; each segment is a key or an array index. */
export function jsonPath(field: string, path: string): string {
  const segments = path.split(".");
  if (segments.length > MAX_SEGMENTS || !segments.every((part) => segmentPattern.test(part))) {
    throw new UnfitQuery(`Not a data path: ${JSON.stringify(path)}`);
  }
  return `${fieldName(field)}.${path}`;
}
