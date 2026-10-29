// Sequence condition language (docs/design/05-sequences.md#conditions); no upstream source.

/** A comparison value: JSON text, a finite number or a boolean. */
export type Scalar = string | number | boolean;

export type Since = "trigger" | "enrollment" | "last_step" | (string & {});

export interface EventCount {
  gte?: number;
  lte?: number;
  eq?: number;
}

export type AttrOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "exists";

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { event: string; since?: Since; where?: Record<string, Scalar>; count?: EventCount }
  | { attr: string; op: AttrOp; value?: Scalar | Scalar[] }
  | { list: number; status?: string[] }
  | { sql: string };

/**
 * What a condition is evaluated against. Times are the stored ISO 8601 instants (or Dates);
 * `now` comes from the caller's injected clock.
 */
export interface ConditionContext {
  subscriberId: bigint | number;
  /** The enrollment's trigger event `occurred_at`. */
  triggerAt?: Date | string;
  /** When the enrollment started. */
  enrolledAt?: Date | string;
  /** When the previous step ran; absent before the first step, which falls back to the trigger. */
  lastStepAt?: Date | string | null;
  now: Date;
}

/** Bounds against hostile definitions; every compiled query stays small and bounded. */
export const limits = {
  /** Nesting depth of the whole condition, counting the root and its leaves. */
  depth: 10,
  /** Predicates and combinators in one condition. */
  nodes: 64,
  /** Values in one `in` list. */
  inValues: 100,
  /** `where` fields on one event predicate. */
  whereFields: 8,
  /** Segments in an attribute or `data.*` path, and characters in each segment. */
  pathSegments: 8,
  segmentLength: 64,
  /** UTF-8 bytes in a string value. */
  stringBytes: 1000,
  /** UTF-8 bytes in an event name, as accepted by the events API. */
  eventNameBytes: 200,
  /** Largest `count` comparand; counting stops one past the largest comparand. */
  count: 1000,
  /** `sql` predicates in one condition, and characters in each fragment. */
  sqlPredicates: 8,
  sqlLength: 10_000,
  /** Longest `since` duration, in days. */
  durationDays: 36_600,
  /** Field errors reported for one condition. */
  errors: 20,
} as const;

export interface FieldError {
  /** Dotted path to the offending field, e.g. `condition.all.2.op`. */
  field: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; condition: Condition }
  | { ok: false; errors: FieldError[] };

export type ConditionErrorKind =
  /** The condition is not valid. */
  | "invalid"
  /** The context lacks a time the condition needs, or a time is invalid. */
  | "context"
  /** The subscriber does not exist. */
  | "not_found"
  /** A `sql` predicate exceeded the raw-query time limit. */
  | "timeout"
  /** A `sql` predicate exceeded the raw-query memory limit. */
  | "memory"
  /** Every raw-query slot was busy for the admission time. */
  | "busy"
  /** A `sql` fragment was refused or did not compile. */
  | "query"
  /** Any other failure while running the query. */
  | "execution";

export interface ConditionError {
  kind: ConditionErrorKind;
  message: string;
}

export type EvaluationResult = { ok: true; value: boolean } | { ok: false; error: ConditionError };
