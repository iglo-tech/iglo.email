// CSV export formatting adapted from listmonk cmd/subscribers.go ExportSubscribers at 6fcd95f:
// Go encoding/csv quoting, Go time.Time.String() timestamps and PostgreSQL JSONB attribute text.

// Go unicode.IsSpace.
const space = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

/** One record as written by Go's csv.Writer with the default comma and "\n" line ends. */
export function csvRecord(fields: string[]): string {
  return `${fields
    .map((field) =>
      field !== "" && (field === "\\." || /[\n\r",]/.test(field) || space.test(field))
        ? `"${field.replaceAll('"', '""')}"`
        : field,
    )
    .join(",")}\n`;
}

/**
 * A stored UTC timestamp in Go's time.Time.String() form for the UTC location, e.g.
 * `2026-10-29 13:39:17.456 +0000 UTC`; a missing value is Go's zero time.
 */
export function goTime(value: string | null): string {
  if (value === null) return "0001-01-01 00:00:00 +0000 UTC";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const iso = date.toISOString();
  const fraction = iso.slice(20, 23).replace(/0+$/, "");
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}${fraction ? `.${fraction}` : ""} +0000 UTC`;
}

const utf8Length = (value: string) => Buffer.byteLength(value);
function compareKeys(a: string, b: string): number {
  const la = utf8Length(a),
    lb = utf8Length(b);
  if (la !== lb) return la - lb;
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** PostgreSQL JSONB text output: keys ordered by length then bytes, ", " and ": " separators. */
export function jsonbText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort(compareKeys)
      .map((key) => `${JSON.stringify(key)}: ${jsonbText((value as Record<string, unknown>)[key])}`)
      .join(", ")}}`;
  return JSON.stringify(value);
}

export const exportHeader = csvRecord([
  "uuid",
  "email",
  "name",
  "attributes",
  "status",
  "created_at",
  "updated_at",
]);

export interface ExportRow {
  uuid: string;
  email: string;
  name: string;
  attribs: string;
  status: string;
  created_at: string | null;
  updated_at: string | null;
}

export function exportRecord(row: ExportRow): string {
  return csvRecord([
    row.uuid,
    row.email,
    row.name,
    jsonbText(JSON.parse(row.attribs)),
    row.status,
    goTime(row.created_at),
    goTime(row.updated_at),
  ]);
}
