// The from and to bounds of listmonk's analytics queries, which Postgres casts to timestamptz
// in the session's zone (UTC). Accepts the ISO forms clients send: a date, a date and time
// with T or a space, optional seconds and fraction, and Z or a numeric offset.
const FORM =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{1,2}(?::?\d{2})?)?$/i;

/** The stored text form of a bound, or null when it is not one of the accepted forms. */
export function parseBound(text: string, rounding: "up" | "down"): string | null {
  const match = FORM.exec(text.trim());
  if (!match) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", fraction = "", zone = "Z"] = match;
  const at = new Date(0);
  at.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  at.setUTCHours(Number(h), Number(mi), Number(s));
  if (
    at.getUTCMonth() !== Number(mo) - 1 ||
    at.getUTCDate() !== Number(d) ||
    Number(h) > 24 ||
    Number(mi) > 59 ||
    Number(s) > 60
  )
    return null;
  let time = at.getTime();
  const ms = Number(`0.${fraction || "0"}`) * 1000;
  time += rounding === "up" ? Math.ceil(ms) : Math.floor(ms);
  if (zone.toUpperCase() !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const hours = Number(digits.length <= 2 ? digits : digits.slice(0, -2));
    const minutes = digits.length <= 2 ? 0 : Number(digits.slice(-2));
    time -= (zone[0] === "-" ? -1 : 1) * (hours * 60 + minutes) * 60_000;
  }
  return new Date(time).toISOString();
}
