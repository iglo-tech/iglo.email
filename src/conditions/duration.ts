// ISO 8601 durations for `since` (docs/design/05-sequences.md#conditions); no upstream source.
import { limits } from "@/conditions/types";

/**
 * Milliseconds in an ISO 8601 duration of weeks, days, hours, minutes and seconds
 * (`P30D`, `PT12H`, `P1DT6H`), or undefined. Years and months have no fixed length and
 * fractions are not accepted; the result is at most `limits.durationDays`.
 */
export function parseDuration(text: string): number | undefined {
  const m =
    /^P(?:(\d{1,6})W)?(?:(\d{1,6})D)?(?:T(?:(\d{1,6})H)?(?:(\d{1,6})M)?(?:(\d{1,6})S)?)?$/.exec(
      text,
    );
  if (!m || text === "P" || text.endsWith("T")) return undefined;
  const [weeks, days, hours, minutes, seconds] = m.slice(1).map((part) => Number(part ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = ((((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  return ms <= limits.durationDays * 86_400_000 ? ms : undefined;
}
