// When app.cache_slow_queries_interval next fires, for the specs src/settings/cron.ts accepts:
// github.com/gdgvda/cron v0.7.0's five fields, descriptors and @every, in server time or TZ=.
// Its calendar forms (L, W, #) are not evaluated: such a day field matches every day, so the
// refresh runs more often than the spec and never less.
const descriptors: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};
const months = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
const days = "sun mon tue wed thu fri sat".split(" ");
const bounds = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const;
const MINUTE = 60_000;
const DURATION = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
const units: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  ms: 1,
  s: 1000,
  m: MINUTE,
  h: 3_600_000,
};

/** The values of one field, or null where every value matches. */
function field(text: string, index: number): Set<number> | null {
  const [min, max] = bounds[index]!;
  const names = index === 3 ? months : index === 4 ? days : [];
  const value = (s: string) => {
    const found = names.indexOf(s.toLowerCase());
    return found >= 0 ? found + (index === 3 ? 1 : 0) : Number(s);
  };
  const out = new Set<number>();
  for (const option of text.split(",").filter(Boolean)) {
    const [range, step] = option.split("/") as [string, string | undefined];
    const [first, last] = range.split("-") as [string, string | undefined];
    if (/[LW#]/.test(first) && !names.includes(first.toLowerCase())) return null;
    const wild = first === "*" || first === "?";
    const low = wild ? min : value(first);
    const high = wild ? max : last !== undefined ? value(last) : step ? max : low;
    for (let n = low; n <= high; n += Number(step ?? 1)) out.add(n);
  }
  return out;
}

function zoned(at: Date, zone: string | undefined) {
  if (!zone)
    return [at.getMinutes(), at.getHours(), at.getDate(), at.getMonth() + 1, at.getDay()] as const;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return [
    Number(part("minute")),
    Number(part("hour")),
    Number(part("day")),
    Number(part("month")),
    days.indexOf(part("weekday").toLowerCase()),
  ] as const;
}

/** Whether the spec fires in the half-open span (after, until], looking back one day at most. */
export function dueBetween(input: string, after: Date, until: Date): boolean {
  let spec = input.trim();
  let zone: string | undefined;
  if (spec.startsWith("TZ=") || spec.startsWith("CRON_TZ=")) {
    const space = spec.indexOf(" ");
    zone = spec.slice(spec.indexOf("=") + 1, space);
    spec = spec.slice(space).trim();
  }
  if (spec.startsWith("@every ")) {
    let every = 0;
    for (const [, amount, unit] of spec.slice(7).matchAll(DURATION))
      every += Number(amount) * units[unit!]!;
    if (every <= 0) return false;
    return Math.floor(until.getTime() / every) > Math.floor(after.getTime() / every);
  }
  const fields = (descriptors[spec] ?? spec).split(/\s+/);
  if (fields.length !== 5) return false;
  const sets = fields.map(field);
  // Robfig semantics: two restricted day fields match when either does.
  const wild = (text: string) => text.startsWith("*") || text.startsWith("?");
  const anyDay = !wild(fields[2]!) && !wild(fields[4]!);
  const matches = (at: Date) => {
    const [minute, hour, day, month, weekday] = zoned(at, zone);
    const has = (index: number, value: number) => sets[index] === null || sets[index]!.has(value);
    if (!has(0, minute) || !has(1, hour) || !has(3, month)) return false;
    return anyDay ? has(2, day) || has(4, weekday) : has(2, day) && has(4, weekday);
  };
  const end = Math.floor(until.getTime() / MINUTE);
  const start = Math.max(Math.floor(after.getTime() / MINUTE) + 1, end - 1439);
  for (let minute = start; minute <= end; minute++)
    if (matches(new Date(minute * MINUTE))) return true;
  return false;
}
