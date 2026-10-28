// Syntax validation adapted from github.com/gdgvda/cron v0.7.0, parser.go and internal/parser.
// Copyright Rob Figueiredo; the complete MIT license is embedded with the assets.
import { goDuration } from "@/settings/duration";

// time.Duration.String formats the parsed duration, rather than its input spelling.
function durationString(milliseconds: number): string {
  const sign = milliseconds < 0 ? "-" : "";
  const n = Math.abs(milliseconds);
  const decimal = (value: number) => String(Number(value.toFixed(9)));
  if (n === 0) return "0s";
  if (n < 0.001) return `${sign}${decimal(n * 1e6)}ns`;
  if (n < 1) return `${sign}${decimal(n * 1000)}µs`;
  if (n < 1000) return `${sign}${decimal(n)}ms`;
  const hours = Math.floor(n / 3600000);
  const minutes = Math.floor((n % 3600000) / 60000);
  const seconds = (n % 60000) / 1000;
  return `${sign}${hours ? `${hours}h` : ""}${hours || minutes ? `${minutes}m` : ""}${decimal(seconds)}s`;
}

export function cronError(input: string): string | null {
  if (!input) return "empty spec string";
  let spec = input;
  if (spec.startsWith("TZ=") || spec.startsWith("CRON_TZ=")) {
    const i = spec.indexOf(" ");
    if (i < 0) return `invalid location descriptior: ${spec}`;
    const zone = spec.slice(spec.indexOf("=") + 1, i);
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
    } catch {
      return `provided bad location ${zone}: unknown time zone ${zone}`;
    }
    spec = spec.slice(i).trim();
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
      const n = goDuration(raw);
      if (!Number.isFinite(n) || n > 9223372036854.775)
        return `failed to parse duration ${spec}: time: invalid duration ${JSON.stringify(raw)}`;
      if (n < 1000) return `delay must be at least one second but was ${durationString(n)}`;
      if (n % 1000) return `delay must be a multiple of one second but was ${durationString(n)}`;
      return null;
    }
    return `unrecognized descriptor: ${spec}`;
  }
  const fields = spec.trim() ? spec.trim().split(/\s+/u) : [];
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
      if (found >= 0) return found + (index === 3 ? 1 : 0);
      return /^\+?\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : NaN;
    };
    for (const option of options) {
      const slash = option.split("/");
      const range = slash[0]!.split("-");
      if (slash.length > 2 || range.length > 2) return `${option}: invalid expression`;
      const first = range[0]!;
      if (index === 2 && first === "L") {
        if (slash.length > 1 || (range.length === 2 && !(number(range[1]!) <= 30)))
          return `${option}: invalid expression`;
        continue;
      }
      if (index === 2 && first.endsWith("W")) {
        if (range.length > 1 || slash.length > 1) return `${option}: invalid expression`;
        if (first === "LW" || (number(first.slice(0, -1)) >= 1 && number(first.slice(0, -1)) <= 31))
          continue;
        return `${option}: invalid expression`;
      }
      if (index === 4 && first !== "L" && (first.endsWith("L") || first.includes("#"))) {
        if (range.length > 1 || slash.length > 1) return `${option}: invalid expression`;
        const parts = first.endsWith("L") ? [first.slice(0, -1)] : first.split("#");
        if (
          number(parts[0]!) > 6 ||
          !Number.isFinite(number(parts[0]!)) ||
          (parts.length > 1 &&
            (parts.length !== 2 || !(number(parts[1]!) >= 1 && number(parts[1]!) <= 5)))
        )
          return `${option}: invalid expression`;
        continue;
      }
      const wild = first === "*" || (first === "?" && (index === 2 || index === 4));
      if (wild && range.length > 1) return `${option}: invalid expression`;
      const low = wild ? min : first === "L" && index === 4 ? 6 : number(first);
      const high = wild ? max : range.length > 1 ? number(range[1]!) : slash.length > 1 ? max : low;
      if (!Number.isFinite(low))
        return `failed to parse int from ${first}: strconv.Atoi: parsing ${JSON.stringify(first)}: invalid syntax`;
      if (low < min || low > max)
        return `${option}: value ${low} out of valid range [${min}, ${max}]`;
      if (!Number.isFinite(high))
        return `failed to parse int from ${range[1]}: strconv.Atoi: parsing ${JSON.stringify(range[1])}: invalid syntax`;
      if (high < min || high > max)
        return `${option}: value ${high} out of valid range [${min}, ${max}]`;
      if (high < low) return `${option}: beginning of range (${low}) beyond end of range (${high})`;
      if (slash.length > 1) {
        const step = slash[1]!;
        if (!/^\+?\d+$/.test(step) || !Number.isSafeInteger(Number(step)))
          return `failed to parse int from ${step}: strconv.Atoi: parsing ${JSON.stringify(step)}: invalid syntax`;
        if (Number(step) === 0) return "step should be > 0, got 0";
      }
    }
  }
  return null;
}
