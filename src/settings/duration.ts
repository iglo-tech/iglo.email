// Duration syntax adapted from Go time.ParseDuration and the explicit settings day convention.
import { HttpError } from "@/server/response";
const fail = (): never => {
  throw new HttpError(400, "Invalid data.");
};
function duration(input: string, days = false): number {
  const units: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    µs: 1e-3,
    μs: 1e-3,
    ms: 1,
    s: 1000,
    m: 60000,
    h: 3600000,
    ...(days ? { d: 86400000 } : {}),
  };
  let total = 0,
    pos = 0;
  const re = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h|d)/gy;
  while (pos < input.length) {
    re.lastIndex = pos;
    const m = re.exec(input);
    if (!m) return NaN;
    if (!Object.hasOwn(units, m[2]!)) return NaN;
    total += Number(m[1]) * units[m[2]!]!;
    pos = re.lastIndex;
  }
  return total;
}
export function sessionDuration(input: string, now: number): number {
  const value = duration(input.startsWith("+") ? input.slice(1) : input, true);
  const milliseconds = Math.floor(value);
  if (
    !Number.isFinite(value) ||
    value < 1000 ||
    !Number.isSafeInteger(milliseconds) ||
    !Number.isFinite(now) ||
    milliseconds > 8640000000000000 - now
  )
    return fail();
  return milliseconds;
}

export function goDuration(input: string): number {
  if (input === "0" || input === "+0" || input === "-0") return 0;
  const negative = input.startsWith("-");
  const unsigned = input.startsWith("+") || negative ? input.slice(1) : input;
  if (!unsigned) return NaN;
  const result = duration(unsigned);
  if (!Number.isFinite(result) || result > 9223372036854.775) return NaN;
  return negative ? -result : result;
}

// Go 1.27.2 time.ParseDuration, in nanoseconds. Keep the signed 64-bit
// boundary and classify errors before handing milliseconds to the cron helper.
export function cronDuration(input: string): { nanos: bigint; error: string | null } {
  const quote = (value: string) => JSON.stringify(value);
  const fail = (kind: string) => ({ nanos: 0n, error: `time: ${kind} ${quote(input)}` });
  let rest = input;
  const negative = rest.startsWith("-");
  if (/^[+-]/.test(rest)) rest = rest.slice(1);
  if (rest === "0") return { nanos: 0n, error: null };
  if (!rest) return fail("invalid duration");
  const units: Record<string, bigint> = {
    ns: 1n,
    us: 1000n,
    µs: 1000n,
    μs: 1000n,
    ms: 1000000n,
    s: 1000000000n,
    m: 60000000000n,
    h: 3600000000000n,
  };
  const limit = 9223372036854775808n;
  let total = 0n;
  while (rest) {
    const numeric = /^(\d*)(?:\.(\d*))?/.exec(rest)!;
    const integer = numeric[1]!;
    const fraction = numeric[2] ?? "";
    if ((!integer && !fraction) || (integer && BigInt(integer) > limit))
      return fail("invalid duration");
    rest = rest.slice(numeric[0].length);
    const unit = /^[^\d.]*/u.exec(rest)![0];
    if (!unit) return fail("missing unit in duration");
    if (!Object.hasOwn(units, unit)) return fail(`unknown unit ${quote(unit)} in duration`);
    rest = rest.slice(unit.length);
    const factor = units[unit]!;
    let value = BigInt(integer || "0") * factor;
    if (value > limit) return fail("invalid duration");
    // Go's leadingFraction retains digits until its uint64 accumulator would overflow.
    let digits = "";
    for (const digit of fraction) {
      const next = digits + digit;
      if (BigInt(next) > limit) break;
      digits = next;
    }
    if (digits)
      value += BigInt(Math.trunc(Number(digits) * (Number(factor) / 10 ** digits.length)));
    total += value;
    if (value > limit || total > limit) return fail("invalid duration");
  }
  if (!negative && total === limit) return fail("invalid duration");
  return { nanos: negative ? -total : total, error: null };
}

// Native marketing.min_interval: an ISO 8601 duration such as P7D, PT12H or P1M.
// Calendar parts are subtracted in UTC; fractions and negative values are rejected.
const iso =
  /^P(?=\d|T\d)(?:(\d{1,4})Y)?(?:(\d{1,5})M)?(?:(\d{1,5})W)?(?:(\d{1,6})D)?(?:T(?=\d)(?:(\d{1,7})H)?(?:(\d{1,9})M)?(?:(\d{1,10})S)?)?$/;
/** The earliest instant still inside the interval ending at `now`; null when "" disables it. */
export function intervalStart(input: string, now: Date): Date | null | undefined {
  if (input === "") return null;
  const m = iso.exec(input);
  if (!m) return undefined;
  const [y, mo, w, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0)) as number[];
  const at = new Date(now.getTime());
  // Calendar months clamp to the target month's last day (31 March - P1M = 28 February).
  const year = at.getUTCFullYear() - y!,
    month = at.getUTCMonth() - mo!;
  const days = new Date(0);
  days.setUTCFullYear(year, month + 1, 0);
  at.setUTCFullYear(year, month, Math.min(at.getUTCDate(), days.getUTCDate()));
  at.setUTCDate(at.getUTCDate() - w! * 7 - d!);
  const time = at.getTime() - ((h! * 60 + mi!) * 60 + s!) * 1000;
  // Bound to dates JavaScript and ISO strings represent (year 0 onwards).
  if (!Number.isFinite(time) || time < -62167219200000) return undefined;
  return new Date(time);
}
