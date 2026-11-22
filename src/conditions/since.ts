// Context times and `since` bounds shared by sequence conditions and event aggregates
// (docs/design/05-sequences.md#conditions, #aggregates); no upstream source. Both read the same
// stored instants and the same injected clock, so `since` means the same instant in each.
import { parseDuration } from "@/conditions/duration";
import type { ConditionContext } from "@/conditions/types";

export const MIN_TIME = Date.UTC(1000, 0, 1),
  MAX_TIME = Date.UTC(10_000, 0, 1);

/** The context lacks a time or subscriber the query needs, or one is invalid. */
export class ContextError extends Error {}

/** A context time as epoch milliseconds, within the stored range. */
export function instant(value: Date | string | null | undefined, name: string): number {
  if (value === undefined || value === null) {
    throw new ContextError(`${name} is required`);
  }
  const time = (typeof value === "string" ? new Date(value) : value).getTime();
  if (!(time >= MIN_TIME && time < MAX_TIME)) {
    throw new ContextError(`${name} is invalid`);
  }
  return time;
}

/** A subscriber ID as a bigint, or ContextError. */
export function subscriberID(value: unknown): bigint {
  if (typeof value === "bigint" && value > 0n) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return BigInt(value);
  }
  throw new ContextError("subscriberId is invalid");
}

/**
 * The stored instant an event must be strictly after for `since`, measured against `now`
 * (epoch milliseconds). `""` when the bound is before any stored instant: no lower bound.
 * ContextError when the context lacks the time `since` names.
 */
export function sinceBound(context: ConditionContext, now: number, since: string): string {
  let time: number;
  if (since === "trigger") {
    time = instant(context.triggerAt, "triggerAt");
  } else if (since === "enrollment") {
    time = instant(context.enrolledAt, "enrolledAt");
  } else if (since === "last_step") {
    time =
      context.lastStepAt === undefined || context.lastStepAt === null
        ? instant(context.triggerAt, "triggerAt")
        : instant(context.lastStepAt, "lastStepAt");
  } else {
    // An unparsed duration is NaN, as the unchecked subtraction gave, and that fails the bound later.
    time = now - (parseDuration(since) ?? Number.NaN);
  }
  // Stored instants are ISO strings from year 1000; an earlier bound admits every event.
  return time < MIN_TIME ? "" : new Date(time).toISOString();
}
