// Native (15-external-sources sections 3, 4, 5 and 7, D169, D173): what a source record does. The
// `RecordHandler` the realtime stream (src/sources/stream.ts) hands each record to:
//
// - An events record: its source reads first (each matching external sequence's `trigger.condition`
//   through B150c's `evaluateTriggerCondition`, the user's recipients-view row, and the row of an
//   address holder whose person may be gone), then one SQLite write transaction: the address
//   conflict's resolution, the subscriber upsert keyed on `external_id`, the `grant_lists` grants,
//   exit-then-trigger with the record's `occurredAt` and ID, and the stream's dedupe entry.
// - A users record matching the leaving filter, or an events record whose user the recipients
//   view no longer has: the user is leaving, so the subscriber is removed (its enrollments with it).
//
// No network call runs inside a transaction: each transaction re-checks the SQLite state the reads
// were planned on and, when it changed, rolls back with a transient error, so the retry queue reads
// again. Nothing here sends: marketing stays at-most-once.
import type { Database } from "bun:sqlite";
import type { ErrorLogger } from "@/app";
import type { Clock } from "@/clock";
import { evaluateTriggerCondition } from "@/conditions/source";
import { whereHolds } from "@/conditions/strict";
import { writeTransaction } from "@/db/transaction";
import { TRIGGER_WINDOW_MS } from "@/events/store";
import { trimSpace } from "@/lists/store";
import type { SafeMessage } from "@/maintenance/log-buffer";
import type { Enrollments } from "@/sequences/enrollments";
import { isSourceObject, sourceJson } from "@/sources/json";
import type { SourceJson } from "@/sources/json";
import type { GrantRule } from "@/sources/settings";
import { isSourceError, SourceError } from "@/sources/source";
import type { ExternalSource, SourceEvent, SourceRecipient } from "@/sources/source";
import { SettingsMismatch } from "@/sources/stream-record";
import type { RecordCommit, RecordHandler, SourceUser } from "@/sources/stream-record";
import { sanitizeEmail } from "@/subscribers/email";
import type { SubscriberStore } from "@/subscribers/store";

/** What a grant did to one list (spec section 5): `added` is the only one that writes. */
export type RecordGrant =
  | "added"
  | "member"
  | "unsubscribed"
  | "opted_out"
  | "suppressed"
  | "blocklisted"
  | "unavailable";

/** One handled record's outcome (for tests and measurements; nothing stores it). */
export interface RecordOutcome {
  record: string;
  /** `left`: the subscriber was removed; `exits`: only exits applied; `written`: the full path. */
  kind: "left" | "exits" | "written";
  subscriberId: bigint | null;
  grants: Array<{ list_id: number; result: RecordGrant }>;
  started: number;
  ended: number;
}

export interface RecordHandlerOptions {
  db: Database;
  clock: Clock;
  logger: Pick<ErrorLogger, "attention">;
  /** The project's source (the stream's own adapter). */
  source: ExternalSource;
  /** The project's `source.grant_lists` rules, read for each record. */
  grantRules: () => ReadonlyArray<GrantRule>;
  subscribers: Pick<
    SubscriberStore,
    | "external"
    | "byEmail"
    | "sourceWrite"
    | "carryConsent"
    | "remove"
    | "removeLeaving"
    | "grantable"
    | "membership"
    | "insertConfirmedIfAbsent"
    | "suppressed"
  >;
  enrollments: Pick<Enrollments, "externalTriggers" | "recordExitThenTrigger" | "endSubscriber">;
  /** The privacy domain policy for a new or changed address. */
  emailAllowed: (email: string) => boolean;
  /** Called after each committed record (tests and measurements). */
  onOutcome?: (outcome: RecordOutcome) => void;
}

type Row = NonNullable<ReturnType<SubscriberStore["external"]>>;

const CONDITION_FAILED: SafeMessage = "Sequence trigger condition failed: not started";
/** Distinct causes remembered for the condition attention line, so one bad condition writes once. */
const MAX_WARNED = 100;

/** The record changed under the handler: roll back, and the retry queue reads again. */
const changedMeanwhile = () =>
  new SourceError("transient", "The subscriber changed while the record was read");

/**
 * A recipients-view read whose failure is the settings' (a `400`, `403` or `404` of the view, or a
 * mapped field the rows lack) refuses the stream as a `SettingsMismatch`: the record is not consumed
 * and fixing the settings delivers it. Any other failure is the record's or transient.
 */
async function readRecipient(
  source: ExternalSource,
  userId: string,
  signal: AbortSignal,
): Promise<SourceRecipient | null> {
  try {
    return await source.recipient(userId, { signal });
  } catch (error) {
    if (
      isSourceError(error) &&
      error.kind === "permanent" &&
      (error.status === 400 ||
        error.status === 403 ||
        error.status === 404 ||
        (error.status === undefined && error.message.includes(" records have no field ")))
    ) {
      throw new SettingsMismatch(`The recipients view refused a read: ${error.message}`);
    }
    throw error;
  }
}

/** The view's address as iglo.email stores it, or null when it is no address. */
function addressOf(recipient: SourceRecipient): string | null {
  const raw = recipient.email.toWellFormed();
  if (!raw || Buffer.byteLength(raw) > 1000) {
    return null;
  }
  return sanitizeEmail(raw) ?? null;
}

/** The view's name as a display name: trimmed, "" when unusable (no name from the address). */
function nameOf(recipient: SourceRecipient): string {
  const name = trimSpace(recipient.name.toWellFormed());
  return name.includes("\0") || Buffer.byteLength(name) > 2000 ? "" : name;
}

/** The parts of a stored external trigger the handler reads. */
interface StoredTrigger {
  where?: Record<string, SourceJson>;
  condition?: SourceJson;
}

/** A sequence's stored trigger: its `data.*` equalities match the record strictly (D172). */
function triggerOf(text: string): StoredTrigger | null {
  const trigger = sourceJson(JSON.parse(text));
  if (!isSourceObject(trigger)) {
    return null;
  }
  const where = trigger.where;
  if (where !== undefined && !isSourceObject(where)) {
    return null;
  }
  const parsed: StoredTrigger = {};
  if (where !== undefined) {
    parsed.where = where;
  }
  if (trigger.condition !== undefined) {
    parsed.condition = trigger.condition;
  }
  return parsed;
}

const scalarWhere = (
  where: Record<string, SourceJson> | undefined,
): Record<string, string | number | boolean> | null => {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(where ?? {})) {
    if (
      !key.startsWith("data.") ||
      !(typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    ) {
      return null;
    }
    Object.defineProperty(out, key, { value, enumerable: true });
  }
  return out;
};

/**
 * How the incoming address meets another subscriber that holds it (spec section 4), as read before
 * the transaction: `moved` (the holder's user now has `email` in the view: move the holder there),
 * `gone` (the holder has no `external_id`, or the view no longer has its user).
 */
type Conflict =
  | { kind: "none" }
  | { kind: "moved"; holder: Row; email: string }
  | { kind: "gone"; holder: Row };

export function createRecordHandler(options: RecordHandlerOptions): RecordHandler {
  const { db, clock, source, subscribers, enrollments } = options;
  const warned = new Set<string>();
  const warn = (detail: string) => {
    if (warned.has(detail) || warned.size >= MAX_WARNED) {
      return;
    }
    warned.add(detail);
    try {
      options.logger.attention(`${CONDITION_FAILED}: ${detail}`, CONDITION_FAILED);
    } catch {
      /* Logging never changes the record. */
    }
  };
  const report = (outcome: RecordOutcome) => {
    options.onOutcome?.(outcome);
  };

  /**
   * The user is leaving (spec section 7): the subscriber goes, and its enrollments with it. Consent
   * the person withdrew (a blocklist, an unsubscribe) stays as a suppression, in the same
   * transaction, so a returning user is not re-granted it.
   */
  function leave(userId: string, recordId: string, commit: RecordCommit) {
    const removed = writeTransaction(db, () => {
      const row = subscribers.external(userId);
      if (row) {
        enrollments.endSubscriber(row.id);
        subscribers.removeLeaving(row.id);
      }
      commit.write();
      return row?.id ?? null;
    });
    report({
      record: recordId,
      kind: "left",
      subscriberId: removed,
      grants: [],
      started: 0,
      ended: 0,
    });
  }

  /** The sequences the record would start: trigger matched strictly, condition true (reads first). */
  async function startable(record: SourceEvent, signal: AbortSignal) {
    if (record.occurredAt.getTime() < clock.now().getTime() - TRIGGER_WINDOW_MS) {
      // As a pushed event: an old record exits and grants, but starts nothing.
      return [];
    }
    const chosen: Array<{ id: bigint; trigger: string }> = [];
    for (const sequence of enrollments.externalTriggers(record.name)) {
      const trigger = triggerOf(sequence.trigger);
      const where = trigger && scalarWhere(trigger.where);
      if (!trigger || !where || !whereHolds(record.data, where)) {
        continue;
      }
      if (trigger.condition !== undefined) {
        const result = await evaluateTriggerCondition(
          source,
          trigger.condition,
          record.user,
          record,
          { signal },
        );
        if (!result.ok) {
          if (result.kind === "transient") {
            throw new SourceError("transient", result.message);
          }
          // A condition the source refuses, or that no longer validates, starts nothing; the
          // record's grants and other sequences still apply.
          warn(`sequence ${sequence.id}: ${result.message}`);
          continue;
        }
        if (!result.value) {
          continue;
        }
      }
      chosen.push({ id: sequence.id, trigger: sequence.trigger });
    }
    return chosen;
  }

  /** Reads the holder of `email` in the view (before the transaction) and plans the resolution. */
  async function conflictOf(
    email: string,
    current: Row | null,
    signal: AbortSignal,
  ): Promise<Conflict> {
    const holder = subscribers.byEmail(email);
    if (!holder || holder.id === current?.id) {
      return { kind: "none" };
    }
    if (holder.external_id === null) {
      return { kind: "gone", holder };
    }
    const row = await readRecipient(source, holder.external_id, signal);
    if (!row) {
      return { kind: "gone", holder };
    }
    const moved = addressOf(row);
    if (moved === null || moved === email) {
      throw new SourceError(
        "permanent",
        `Two users in the source have one address: ${holder.external_id} holds it as subscriber ${holder.id}`,
      );
    }
    const taken = subscribers.byEmail(moved);
    if (taken && taken.id !== holder.id) {
      throw new SourceError(
        "permanent",
        `The address holder's user ${holder.external_id} moved to an address subscriber ${taken.id} holds`,
      );
    }
    if (!options.emailAllowed(moved)) {
      throw new SourceError(
        "permanent",
        `The address holder's user ${holder.external_id} moved to a blocklisted domain`,
      );
    }
    return { kind: "moved", holder, email: moved };
  }

  /** One grant (spec section 5): refused over opt-out, unsubscribe, suppression and blocklist. */
  function grant(row: Row, list: number, optOut: boolean, suppressed: boolean): RecordGrant {
    const id = BigInt(list);
    if (!subscribers.grantable(id)) {
      return "unavailable";
    }
    if (row.status === "blocklisted") {
      return "blocklisted";
    }
    if (suppressed) {
      return "suppressed";
    }
    const previous = subscribers.membership(row.id, id);
    if (previous) {
      return previous.status === "unsubscribed" ? "unsubscribed" : "member";
    }
    if (optOut) {
      return "opted_out";
    }
    subscribers.insertConfirmedIfAbsent(row.id, id);
    return "added";
  }

  async function event(record: SourceEvent, commit: RecordCommit, signal: AbortSignal) {
    const lists: Array<number> = [];
    for (const rule of options.grantRules()) {
      if (rule.event === record.name && whereHolds(record.data, rule.where)) {
        for (const list of rule.lists) {
          if (!lists.includes(list)) {
            lists.push(list);
          }
        }
      }
    }
    const sequences = await startable(record, signal);
    const triggerRecord = { id: record.id, name: record.name, occurredAt: record.occurredAt };

    if (!lists.length && !sequences.length) {
      // Nothing to grant or start: an exit ends a linked subscriber's enrollments, and no
      // subscriber is created for it.
      const outcome = writeTransaction(db, () => {
        const row = subscribers.external(record.user);
        const result = row
          ? enrollments.recordExitThenTrigger({
              subscriberId: row.id,
              subscriberStatus: row.status,
              suppressed: () => subscribers.suppressed(row),
              record: triggerRecord,
              sequences: [],
            })
          : null;
        commit.write();
        return { row, ended: result?.ended.length ?? 0 };
      });
      report({
        record: record.id,
        kind: "exits",
        subscriberId: outcome.row?.id ?? null,
        grants: [],
        started: 0,
        ended: outcome.ended,
      });
      return;
    }

    const recipient = await readRecipient(source, record.user, signal);
    if (!recipient) {
      // The view no longer has the user: leaving (spec section 7). Nothing is created.
      leave(record.user, record.id, commit);
      return;
    }
    const email = addressOf(recipient);
    if (email === null) {
      throw new SourceError("permanent", `The source user ${record.user} has no valid address`);
    }
    const name = nameOf(recipient);
    const current = subscribers.external(record.user);
    const conflict = await conflictOf(email, current, signal);
    const newAddress = conflict.kind !== "gone" && current?.email !== email;
    if (newAddress && !options.emailAllowed(email)) {
      throw new SourceError(
        "permanent",
        `The source user ${record.user}'s address is in a blocklisted domain`,
      );
    }

    const outcome = writeTransaction(db, () => {
      // The reads above planned on this state; anything changed since is read again by a retry.
      const now = subscribers.external(record.user);
      if ((now?.id ?? null) !== (current?.id ?? null)) {
        throw changedMeanwhile();
      }
      const holder = subscribers.byEmail(email);
      const expected = conflict.kind === "none" ? null : conflict.holder;
      if (
        (holder && holder.id !== now?.id ? holder.id : null) !== (expected?.id ?? null) ||
        (holder && expected && holder.external_id !== expected.external_id)
      ) {
        throw changedMeanwhile();
      }
      // Every write below goes by ID and touches only the fields the source owns (address, name,
      // user ID), and every status decision reads the rows as they are now: a blocklist, bounce or
      // unsubscribe that landed while the source was read stays.
      let row: Row;
      if (conflict.kind === "moved") {
        const taken = subscribers.byEmail(conflict.email);
        if (taken && taken.id !== conflict.holder.id) {
          throw changedMeanwhile();
        }
        subscribers.sourceWrite(conflict.holder.id, {
          externalId: conflict.holder.external_id ?? "",
          email: conflict.email,
        });
        row = subscribers.sourceWrite(now?.id ?? null, { externalId: record.user, email, name });
      } else if (conflict.kind === "gone") {
        enrollments.endSubscriber(conflict.holder.id);
        if (!now) {
          // Re-point the holder to the incoming user: blocklist, unsubscribes and cap history stay.
          row = subscribers.sourceWrite(conflict.holder.id, {
            externalId: record.user,
            email,
            name,
          });
        } else {
          // Carry the holder's consent onto the incoming row, delete the holder, take the address.
          subscribers.carryConsent(conflict.holder.id, now.id);
          subscribers.remove([conflict.holder.id]);
          row = subscribers.sourceWrite(now.id, { externalId: record.user, email, name });
        }
      } else {
        row = subscribers.sourceWrite(now?.id ?? null, { externalId: record.user, email, name });
      }
      // Grants before exit-then-trigger, so a zero-wait marketing step sees the consent (D99).
      const suppressed = lists.length > 0 && subscribers.suppressed(row);
      const grants = lists.map((list) => ({
        list_id: list,
        result: grant(row, list, recipient.optOut, suppressed),
      }));
      const result = enrollments.recordExitThenTrigger({
        subscriberId: row.id,
        subscriberStatus: row.status,
        suppressed: () => subscribers.suppressed(row),
        record: triggerRecord,
        sequences,
      });
      if (result.stale) {
        throw changedMeanwhile();
      }
      commit.write();
      return { row, grants, started: result.started.length, ended: result.ended.length };
    });
    report({
      record: record.id,
      kind: "written",
      subscriberId: outcome.row.id,
      grants: outcome.grants,
      started: outcome.started,
      ended: outcome.ended,
    });
  }

  return {
    event,
    userLeft(record: SourceUser, commit: RecordCommit) {
      leave(record.id, record.id, commit);
      return Promise.resolve();
    },
  };
}
