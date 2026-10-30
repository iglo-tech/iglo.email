// When app.cache_slow_queries_interval next fires, for the specs src/settings/cron.ts accepts:
// github.com/gdgvda/cron v0.7.0's five fields, descriptors and @every, in server time or TZ=.
// Its calendar forms (L, W, #) are not evaluated: such a day field matches every day, so the
// refresh runs more often than the spec and never less.
import { cronDuration } from "@/settings/duration";

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

/** Calendar fields of an instant in a zone; a null format reads the system zone. */
function zoned(at: Date, format: Intl.DateTimeFormat | null) {
  if (!format)
    return [at.getMinutes(), at.getHours(), at.getDate(), at.getMonth() + 1, at.getDay()] as const;
  const parts = format.formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return [
    Number(part("minute")),
    Number(part("hour")),
    Number(part("day")),
    Number(part("month")),
    days.indexOf(part("weekday").toLowerCase()),
  ] as const;
}

/** The zone prefix and the rest of a spec. No prefix and Local are the system zone. */
function parts(input: string): {
  zone: Intl.DateTimeFormat | null;
  spec: string;
} {
  const spec = input.trim();
  if (!spec.startsWith("TZ=") && !spec.startsWith("CRON_TZ=")) return { zone: null, spec };
  const space = spec.indexOf(" ");
  const name = spec.slice(spec.indexOf("=") + 1, space);
  const rest = spec.slice(space).trim();
  if (name === "Local") return { zone: null, spec: rest };
  // Go's LoadLocation reads an empty name as UTC, and tzdata's Factory has no offset.
  const timeZone = name === "" || name === "Factory" ? "UTC" : name;
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  });
  return { zone, spec: rest };
}

/** Whether a cron expression matches the minute that starts at an instant. */
function matcher(spec: string, zone: Intl.DateTimeFormat | null) {
  const fields = (descriptors[spec] ?? spec).split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron expression: ${spec}`);
  const sets = fields.map(field);
  // Robfig semantics: two restricted day fields match when either does.
  const wild = (text: string) => text.startsWith("*") || text.startsWith("?");
  const anyDay = !wild(fields[2]!) && !wild(fields[4]!);
  return (at: Date) => {
    const [minute, hour, day, month, weekday] = zoned(at, zone);
    const has = (index: number, value: number) => sets[index] === null || sets[index]!.has(value);
    if (!has(0, minute) || !has(1, hour) || !has(3, month)) return false;
    return anyDay ? has(2, day) || has(4, weekday) : has(2, day) && has(4, weekday);
  };
}

/** Whether a minute in the half-open span (after, until] matches, looking back one day at most. */
function matchedBetween(matches: (at: Date) => boolean, after: Date, until: Date): boolean {
  const end = Math.floor(until.getTime() / MINUTE);
  const start = Math.max(Math.floor(after.getTime() / MINUTE) + 1, end - 1439);
  for (let minute = start; minute <= end; minute++)
    if (matches(new Date(minute * MINUTE))) return true;
  return false;
}

/** Whether a cron expression fires in the half-open span (after, until]. */
export function dueBetween(input: string, after: Date, until: Date): boolean {
  const { zone, spec } = parts(input);
  return matchedBetween(matcher(spec, zone), after, until);
}

export interface Schedule {
  /** Whether the spec fired since the previous call, or since scheduling started. */
  due(now: Date): boolean;
  /** Milliseconds from now until due can next be true. */
  delay(now: Date): number;
}

/**
 * A running schedule from a start time. As robfig's ConstantDelaySchedule, @every counts from
 * the start and then from each firing, never from multiples of the duration. Cron minutes are
 * checked one at a time, so a spec that never fires costs one zone conversion a minute.
 * Throws when the spec cannot be evaluated.
 */
export function createSchedule(input: string, start: Date): Schedule {
  const { zone, spec } = parts(input);
  if (spec.startsWith("@every ")) {
    const { nanos, error } = cronDuration(spec.slice(7));
    if (error || nanos <= 0n) throw new Error(`Invalid duration: ${spec}`);
    const every = Number(nanos / 1_000_000n);
    let next = start.getTime() + every;
    return {
      due(now) {
        if (now.getTime() < next) return false;
        next = now.getTime() + every;
        return true;
      },
      delay: (now) => next - now.getTime(),
    };
  }
  const matches = matcher(spec, zone);
  let checked = start;
  return {
    due(now) {
      const fired = matchedBetween(matches, checked, now);
      checked = now;
      return fired;
    },
    delay: (now) => MINUTE - (now.getTime() % MINUTE),
  };
}
