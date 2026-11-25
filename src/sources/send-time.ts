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
import type { Enrollments } from "@/sequences/enrollments";
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
  subscribers: RecipientSyncOptions["subscribers"] & Pick<SubscriberStore, "removeLeaving">;
  enrollments: Pick<Enrollments, "endSubscriber">;
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

export function createSendTimeLookup(options: SendTimeOptions) {
  const { db, subscribers, enrollments } = options;
  return {
    /** Whether the project has a source: without one, no subscriber is source-linked. */
    configured: () => options.source() !== null,
    /**
     * The source reads for subscriber `subscriberId` linked to user `externalId`, or null without a
     * source. Never inside a transaction. Throws a `SourceError` (a `SettingsMismatch` for a refused
     * view, transient for an outage, permanent for an address the source cannot give), or the
     * signal's reason.
     */
    async read(
      subscriberId: bigint,
      externalId: string,
      signal?: AbortSignal,
    ): Promise<SendTimePlan | null> {
      const source = options.source();
      if (!source) {
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
          const row = subscribers.external(plan.userId);
          if (row && row.id !== planned.subscriberId) {
            throw new SubscriberChanged();
          }
          leaveUser({ subscribers, enrollments }, plan.userId);
          return { kind: "left" };
        }
        const row = applyRecipient({ subscribers, enrollments }, plan);
        if (row.id !== planned.subscriberId) {
          throw new SubscriberChanged();
        }
        return { kind: "current", row };
      });
    },
  };
}
export type SendTimeLookup = ReturnType<typeof createSendTimeLookup>;
