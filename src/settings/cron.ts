// Syntax validation adapted from github.com/gdgvda/cron v0.7.0, parser.go and internal/parser.
// Copyright Rob Figueiredo; the complete MIT license is embedded with the assets.
import { trimSpace } from "@/lists/store";
import { cronDuration } from "@/settings/duration";
import { knownLocation } from "@/settings/timezones";

// time.Duration.String formats the parsed duration, rather than its input spelling.
function durationString(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  let n = value < 0n ? -value : value;
  if (n === 0n) return "0s";
  const decimal = (whole: bigint, fraction: bigint, width: number) =>
    `${whole}${fraction ? `.${String(fraction).padStart(width, "0").replace(/0+$/, "")}` : ""}`;
  if (n < 1000n) return `${sign}${n}ns`;
  if (n < 1000000n) return `${sign}${decimal(n / 1000n, n % 1000n, 3)}µs`;
  if (n < 1000000000n) return `${sign}${decimal(n / 1000000n, n % 1000000n, 6)}ms`;
  const hours = n / 3600000000000n;
  n %= 3600000000000n;
  const minutes = n / 60000000000n;
  n %= 60000000000n;
  const seconds = decimal(n / 1000000000n, n % 1000000000n, 9);
  return `${sign}${hours ? `${hours}h` : ""}${hours || minutes ? `${minutes}m` : ""}${seconds}s`;
}

function parseIntError(value: string): string {
  const quote = JSON.stringify(value).replace(/\ufeff/g, "\\ufeff");
  const parsed = /^[+-]?\d+$/.test(value) ? BigInt(value) : null;
  const inRange =
    parsed !== null && parsed >= -9223372036854775808n && parsed <= 9223372036854775807n;
  if (inRange && parsed < 0n) return `negative number (${parsed}) not allowed: ${value}`;
  const reason = parsed !== null && !inRange ? "value out of range" : "invalid syntax";
  return `failed to parse int from ${value}: strconv.Atoi: parsing ${quote}: ${reason}`;
}

export function cronError(input: string): string | null {
  if (!input) return "empty spec string";
  let spec = input;
  if (spec.startsWith("TZ=") || spec.startsWith("CRON_TZ=")) {
    const i = spec.indexOf(" ");
    if (i < 0) return `invalid location descriptior: ${spec}`;
    const zone = spec.slice(spec.indexOf("=") + 1, i);
    if (zone.includes("..") || zone.startsWith("/") || zone.startsWith("\\"))
      return `provided bad location ${zone}: time: invalid location name`;
    if (!knownLocation(zone)) return `provided bad location ${zone}: unknown time zone ${zone}`;
    spec = trimSpace(spec.slice(i));
  }
  if (spec.startsWith("@")) {
    if (
      ["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"].includes(
        spec,
      )
    )
      return null;
    if (spec.startsWith("@every ")) {
      const raw = spec.slice(7);
      const { nanos, error } = cronDuration(raw);
      if (error) return `failed to parse duration ${spec}: ${error}`;
      if (nanos < 1000000000n)
        return `delay must be at least one second but was ${durationString(nanos)}`;
      if (nanos % 1000000000n)
        return `delay must be a multiple of one second but was ${durationString(nanos)}`;
      return null;
    }
    return `unrecognized descriptor: ${spec}`;
  }
  const trimmed = trimSpace(spec);
  const fields = trimmed
    ? trimmed.split(
        /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u,
      )
    : [];
  if (fields.length !== 5)
    return `expected exactly 5 fields, found ${fields.length}: [${fields.join(" ")}]`;
  const months = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const bounds = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ] as const;
  // The upstream parser validates day of month and day of week before month.
  for (const index of [0, 1, 2, 4, 3]) {
    const [min, max] = bounds[index]!;
    const field = fields[index]!;
    const options = field.split(",").filter(Boolean);
    if (!options.length) return "invalid expression: empty list";
    const number = (s: string) => {
      const names = index === 3 ? months : index === 4 ? days : [];
      const found = names.indexOf(s.toLowerCase());
      if (found >= 0) return BigInt(found + (index === 3 ? 1 : 0));
      return /^\+?\d+$/.test(s) && BigInt(s) <= 9223372036854775807n ? BigInt(s) : null;
    };
    for (const option of options) {
      const slash = option.split("/");
      const range = slash[0]!.split("-");
      if (slash.length > 2 || range.length > 2) return `${option}: invalid expression`;
      const first = range[0]!;
      if (index === 2 && first === "L") {
        if (slash.length > 1) return `${option}: invalid expression`;
        if (range.length === 2 && number(range[1]!) !== null && number(range[1]!)! > 30n)
          return `${option}: invalid amount of days subtracted`;
        if (range.length === 2 && number(range[1]!) === null) return parseIntError(range[1]!);
        continue;
      }
      if (index === 2 && first.endsWith("W")) {
        if (range.length > 1 || slash.length > 1) return `${option}: invalid expression`;
        if (first === "LW") continue;
        const day = number(first.slice(0, -1));
        if (day === null) return parseIntError(first.slice(0, -1));
        if (day < 1n || day > 31n) return `${option}: value ${day} out of valid range [1, 31]`;
        continue;
      }
      if (index === 4 && first === "L" && range.length > 1) return `${option}: invalid expression`;
      if (index === 4 && first !== "L" && (first.endsWith("L") || first.includes("#"))) {
        if (range.length > 1 || slash.length > 1) return `${option}: invalid expression`;
        const parts = first.endsWith("L") ? [first.slice(0, -1)] : first.split("#");
        if (parts.length > 2) return `${option}: invalid expression`;
        const day = number(parts[0]!);
        if (day === null) return parseIntError(parts[0]!);
        if (day > 6n) return `${option}: value ${day} out of valid range [0, 6]`;
        if (parts.length > 1) {
          const rawOccurrence = parts[1]!;
          const occurrence =
            /^\+?\d+$/.test(rawOccurrence) && BigInt(rawOccurrence) <= 9223372036854775807n
              ? BigInt(rawOccurrence)
              : null;
          if (occurrence === null) return parseIntError(parts[1]!);
          if (occurrence < 1n || occurrence > 5n)
            return `${option}: value ${occurrence} out of valid range [1, 5]`;
        }
        continue;
      }
      const wild = first === "*" || (first === "?" && (index === 2 || index === 4));
      if (wild && range.length > 1) return `${option}: invalid expression`;
      const expression =
        slash.length > 1 && range.length === 1
          ? `${wild ? min : first}-${max}/${slash[1]}`
          : option;
      const low = wild ? BigInt(min) : first === "L" && index === 4 ? 6n : number(first);
      const high = wild
        ? BigInt(max)
        : range.length > 1
          ? number(range[1]!)
          : slash.length > 1
            ? BigInt(max)
            : low;
      if (low === null) return parseIntError(first);
      if (low < BigInt(min) || low > BigInt(max))
        return `${expression}: value ${low} out of valid range [${min}, ${max}]`;
      if (high === null) return parseIntError(range[1]!);
      if (high < BigInt(min) || high > BigInt(max))
        return `${expression}: value ${high} out of valid range [${min}, ${max}]`;
      if (high < low)
        return `${expression}: beginning of range (${low}) beyond end of range (${high})`;
      if (slash.length > 1) {
        const step = slash[1]!;
        if (!/^[+-]?\d+$/.test(step) || BigInt(step) < 0n || BigInt(step) > 9223372036854775807n)
          return parseIntError(step);
        if (BigInt(step) === 0n) return "step should be > 0, got 0";
      }
    }
  }
  return null;
}
