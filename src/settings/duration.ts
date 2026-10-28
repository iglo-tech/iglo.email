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
