// Native (15-external-sources section 7, D174): the fresh address and name of a source-linked
// subscriber at send time, for sequence steps (src/scheduler/scheduler.ts) and campaign batches
// (src/campaigns/runner/runner.ts). A subscriber is source-linked when the project has a source
// and the subscriber has an `external_id` (section 3: it is the source's user ID).
//
// Two steps, so a campaign batch reads every recipient before it writes any:
// - `read` does the source reads (the recipients view, and the conflict's holder) with no
//   transaction open, and plans what changes;
// - `apply` writes the plan in its own short write transaction, through B150d's conflict path
//   (src/sources/recipient-sync.ts): an address or name change, or the user leaving (absent from
//   the view: its enrollments end and the subscriber is removed, D125 suppression kept).
// Nothing here sends.
import type { Database } from "bun:sqlite";
import { writeTransaction } from "@/db/transaction";
import type { SourceProvider } from "@/sources/project";
import {
  applyRecipient,
  leaveUser,
  planRecipient,
  planUnchanged,
  SubscriberChanged,
} from "@/sources/recipient-sync";
import type { RecipientPlan, RecipientSyncOptions, SubscriberRow } from "@/sources/recipient-sync";
import type { SubscriberStore } from "@/subscribers/store";

export interface SendTimeOptions {
  db: Database;
  /** The project's source; null without one (then nothing is looked up). */
  source: SourceProvider;
  /**
   * D188 (r1): the instance's sources module is off while the project stores a source. Its
   * source-linked subscribers are then unreadable: the callers send them nothing. Omitted: never.
   */
  held?: () => boolean;
  subscribers: RecipientSyncOptions["subscribers"] & Pick<SubscriberStore, "removeLeaving" | "get">;
  enrollments: RecipientSyncOptions["enrollments"];
  /** The privacy domain policy for a new or changed address. */
  emailAllowed: (email: string) => boolean;
}

/** One subscriber's planned refresh: `apply` it, or skip the write when `unchanged`. */
export interface SendTimePlan {
  subscriberId: bigint;
  plan: RecipientPlan;
  /** The subscriber already has the view's address and name: there is nothing to write. */
  unchanged: boolean;
}

/**
 * What applying a plan did. `left`: the user is absent from the view and the subscriber was
 * removed. `current`: the subscriber as it is now, with the view's address and name.
 */
export type SendTimeResult = { kind: "left" } | { kind: "current"; row: SubscriberRow };

/**
 * D188 (r2): a send-time read found no source because the instance's sources module is off while
 * the project still stores one. Distinct from "no source" (`read` returning null, the subscriber
 * treated as unlinked): the subscriber is source-linked but unreadable, so the caller sends it
 * nothing. Not a `SourceError`: it is neither an outage to wait out nor a refused view.
 */
export class SourceHeld extends Error {
  readonly sourceHeld = true;
  constructor() {
    super("External sources are off on this instance");
  }
}
export const isSourceHeld = (error: unknown): error is SourceHeld =>
  error instanceof Error && "sourceHeld" in error && error.sourceHeld === true;

export function createSendTimeLookup(options: SendTimeOptions) {
  const { db, subscribers, enrollments } = options;
  /**
   * An absent user may stand for the claimed subscriber only while that subscriber still has the
   * user ID. B166 (D194): one that still exists without it (its `external_id` cleared or changed
   * during the read) is a changed subscriber, read again, not one that left; and so is the user ID
   * now on another subscriber.
   */
  const absentChecked = (subscriberId: bigint, userId: string) => {
    const row = subscribers.external(userId);
    if (row ? row.id !== subscriberId : subscribers.get(subscriberId) !== null) {
      throw new SubscriberChanged();
    }
  };
  return {
    /** Whether the project has a source: without one, no subscriber is source-linked. */
    configured: () => options.source() !== null,
    /**
     * D188 (r1): the module is off but the project stores a source. A subscriber with an
     * `external_id` is then source-linked yet cannot be read: never sent to, never treated as
     * unlinked.
     */
    held: () => options.held?.() ?? false,
    /**
     * The source reads for subscriber `subscriberId` linked to user `externalId`, or null without a
     * source. Never inside a transaction. Throws `SourceHeld` when the source is missing only
     * because the module is off (`held`), checked on every call so a toggle during a batch's reads
     * never turns a linked subscriber into an unlinked one (D188 r2). Otherwise throws a
     * `SourceError` (a `SettingsMismatch` for a refused view, transient for an outage, permanent
     * for an address the source cannot give), or the signal's reason.
     */
    async read(
      subscriberId: bigint,
      externalId: string,
      signal?: AbortSignal,
    ): Promise<SendTimePlan | null> {
      const source = options.source();
      if (!source) {
        if (options.held?.()) {
          throw new SourceHeld();
        }
        return null;
      }
      const plan = await planRecipient(
        { source, subscribers, enrollments, emailAllowed: options.emailAllowed },
        externalId,
        signal,
      );
      if (plan.kind === "present" && plan.current?.id !== subscriberId) {
        // The user ID moved to another subscriber (or away) after the claim: never create or
        // re-point a subscriber at send time. The caller reads again.
        throw new SubscriberChanged();
      }
      if (plan.kind === "absent") {
        absentChecked(subscriberId, externalId);
      }
      return { subscriberId, plan, unchanged: planUnchanged(plan) };
    },
    /**
     * Writes a plan in one short write transaction. Throws `SubscriberChanged` when a subscriber the
     * reads planned on changed since; the caller reads again.
     */
    apply(planned: SendTimePlan): SendTimeResult {
      const { plan } = planned;
      return writeTransaction(db, (): SendTimeResult => {
        if (plan.kind === "absent") {
          absentChecked(planned.subscriberId, plan.userId);
          leaveUser({ subscribers, enrollments }, plan.userId);
          return { kind: "left" };
        }
        const row = applyRecipient(
          { subscribers, enrollments, emailAllowed: options.emailAllowed },
          plan,
        );
        if (row.id !== planned.subscriberId) {
          throw new SubscriberChanged();
        }
        return { kind: "current", row };
      });
    },
  };
}
export type SendTimeLookup = ReturnType<typeof createSendTimeLookup>;
