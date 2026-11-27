// Native (15-external-sources sections 4 and 7, D173, D174): a source user's recipients-view row
// into the subscriber linked to it. The record handler (src/sources/records.ts) and the send-time
// lookup (src/sources/send-time.ts) share it, so an address change takes one conflict path:
//
// - `planRecipient` does every read (the user's row in the view, and for an address another
//   subscriber holds, the holder's row) and plans the resolution. Never inside a transaction.
// - `applyRecipient` writes the plan inside the caller's write transaction, after checking that
//   the subscribers the reads planned on are unchanged (else `SubscriberChanged`, transient) and
//   checking the privacy domain policy again on the rows as they are now (B155d, D179).
// - `leaveUser` removes a leaving user's subscriber inside the caller's write transaction.
import type { Enrollments } from "@/sequences/enrollments";
import { trimSpace } from "@/lists/store";
import { isSourceError, SourceError } from "@/sources/source";
import type { ExternalSource, SourceRecipient } from "@/sources/source";
import { isNotSourceId, isRecordUnreadable } from "@/sources/pocketbase";
import { isSettingsMismatch, SettingsMismatch } from "@/sources/stream-record";
import { sanitizeEmail } from "@/subscribers/email";
import type { SubscriberStore } from "@/subscribers/store";

export type SubscriberRow = NonNullable<ReturnType<SubscriberStore["external"]>>;

/** The subscribers the reads planned on changed before the write: roll back and read again. */
export class SubscriberChanged extends SourceError {
  readonly subscriberChanged = true;
  constructor() {
    super("transient", "The subscriber changed while the record was read");
  }
}
export const isSubscriberChanged = (error: unknown): error is SubscriberChanged =>
  isSourceError(error) && "subscriberChanged" in error && error.subscriberChanged === true;

export interface RecipientSyncOptions {
  source: ExternalSource;
  subscribers: Pick<
    SubscriberStore,
    | "external"
    | "byEmail"
    | "sourceWrite"
    | "carryConsent"
    | "remove"
    | "addressSuppressed"
    | "unsubscribeAll"
  >;
  enrollments: Pick<Enrollments, "endSubscriber" | "unsubscribeEffects">;
  /** The privacy domain policy for a new or changed address. */
  emailAllowed: (email: string) => boolean;
}

/**
 * A recipients-view read. B166 (D194): classified by exception. Only the failures of this one
 * record stay per-record permanent errors: an ID the source cannot have, an answer over the
 * response limit, a body that is no record, an address field that is not text. Every other
 * permanent failure (a `400`, `401`, `403` or `404` of the view, a redirect, a host the
 * private-address block refuses, a mapped field the rows lack, a row with no `id`) is the settings'
 * and a `SettingsMismatch`, so a caller waits for them to be fixed instead of giving the record up.
 * Transient failures stay transient.
 */
export async function readRecipient(
  source: ExternalSource,
  userId: string,
  signal: AbortSignal | undefined,
): Promise<SourceRecipient | null> {
  try {
    return await source.recipient(userId, signal ? { signal } : {});
  } catch (error) {
    if (
      isSourceError(error) &&
      error.kind === "permanent" &&
      !isSettingsMismatch(error) &&
      !isNotSourceId(error) &&
      !isRecordUnreadable(error)
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

/**
 * How the incoming address meets another subscriber that holds it (spec section 4), as read before
 * the transaction: `moved` (the holder's user now has `email` in the view: move the holder there,
 * also when `email` is the incoming user's own current address, a swap), `gone` (the holder has no
 * `external_id`, one the source cannot have, or the view no longer has its user).
 */
type Conflict =
  | { kind: "none" }
  | { kind: "moved"; holder: SubscriberRow; email: string }
  | { kind: "gone"; holder: SubscriberRow };

/** What the reads found for one source user. */
export type RecipientPlan =
  | { kind: "absent"; userId: string }
  | {
      kind: "present";
      userId: string;
      recipient: SourceRecipient;
      email: string;
      name: string;
      /** The user's subscriber when the reads were planned. */
      current: SubscriberRow | null;
      conflict: Conflict;
    };

/** Whether applying the plan would write nothing: the linked row already has the view's values. */
export const planUnchanged = (plan: RecipientPlan): boolean =>
  plan.kind === "present" &&
  plan.conflict.kind === "none" &&
  plan.current !== null &&
  plan.current.email === plan.email &&
  plan.current.name === plan.name;

/** Reads the holder of `email` in the view (before the transaction) and plans the resolution. */
async function conflictOf(
  options: RecipientSyncOptions,
  email: string,
  current: SubscriberRow | null,
  signal: AbortSignal | undefined,
): Promise<Conflict> {
  const { subscribers } = options;
  const holder = subscribers.byEmail(email);
  if (!holder || holder.id === current?.id) {
    return { kind: "none" };
  }
  if (holder.external_id === null) {
    return { kind: "gone", holder };
  }
  let row: SourceRecipient | null;
  try {
    row = await readRecipient(options.source, holder.external_id, signal);
  } catch (error) {
    // B155d (D179): an `external_id` the source cannot have (set by pushed events before the
    // project moved to a source) names no source user: the holder is gone, as one with none.
    if (isNotSourceId(error)) {
      return { kind: "gone", holder };
    }
    throw error;
  }
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
  // B155d (D179): the holder moving to the incoming user's own current address is a swap of two
  // users' addresses: `applyRecipient` moves both in one transaction. A third holder stays terminal.
  if (taken && taken.id !== holder.id && taken.id !== current?.id) {
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

/**
 * Every source read for one user, before any write: the user's row in the recipients view and, for
 * an address another subscriber holds, the holder's. Throws a `SourceError` (a `SettingsMismatch`
 * for a refused view) or the signal's reason.
 */
export async function planRecipient(
  options: RecipientSyncOptions,
  userId: string,
  signal: AbortSignal | undefined,
): Promise<RecipientPlan> {
  const recipient = await readRecipient(options.source, userId, signal);
  if (!recipient) {
    return { kind: "absent", userId };
  }
  const email = addressOf(recipient);
  if (email === null) {
    throw new SourceError("permanent", `The source user ${userId} has no valid address`);
  }
  const name = nameOf(recipient);
  const current = options.subscribers.external(userId);
  const conflict = await conflictOf(options, email, current, signal);
  // B163 (D191): only the re-point (no subscriber yet, a gone holder already holding the address)
  // brings no new address; a subscriber of the user moving onto a gone holder's address changes it.
  const repoint = conflict.kind === "gone" && current === null;
  const newAddress = !repoint && current?.email !== email;
  if (newAddress && !options.emailAllowed(email)) {
    throw new SourceError(
      "permanent",
      `The source user ${userId}'s address is in a blocklisted domain`,
    );
  }
  return { kind: "present", userId, recipient, email, name, current, conflict };
}

/**
 * Writes a present plan inside the caller's write transaction: the conflict's resolution, then the
 * user's subscriber (created when it has none) with the view's address and name. Returns that
 * subscriber. Throws `SubscriberChanged` when a subscriber the reads planned on changed since.
 */
export function applyRecipient(
  options: Pick<RecipientSyncOptions, "subscribers" | "enrollments" | "emailAllowed">,
  plan: Extract<RecipientPlan, { kind: "present" }>,
): SubscriberRow {
  const { subscribers, enrollments, emailAllowed } = options;
  const { userId, email, name, current, conflict } = plan;
  // The reads planned on this state; anything changed since is read again by a retry.
  const now = subscribers.external(userId);
  if ((now?.id ?? null) !== (current?.id ?? null)) {
    throw new SubscriberChanged();
  }
  const holder = subscribers.byEmail(email);
  const expected = conflict.kind === "none" ? null : conflict.holder;
  if (
    (holder && holder.id !== now?.id ? holder.id : null) !== (expected?.id ?? null) ||
    (holder && expected && holder.external_id !== expected.external_id)
  ) {
    throw new SubscriberChanged();
  }
  // B155d (D179): the privacy domain policy is checked again here, on the row as it is now and the
  // policy as it is now, so a domain blocklisted (or a stored address changed) after the reads
  // checked it does not let the source's address in. The reads' check stays as the early answer.
  // B163 (D191): exempt only the re-point, where the holder row already holds the address.
  const repoint = conflict.kind === "gone" && now === null;
  if (!repoint && now?.email !== email && !emailAllowed(email)) {
    throw new SourceError(
      "permanent",
      `The source user ${userId}'s address is in a blocklisted domain`,
    );
  }
  if (conflict.kind === "moved" && !emailAllowed(conflict.email)) {
    throw new SourceError(
      "permanent",
      `The address holder's user ${conflict.holder.external_id} moved to a blocklisted domain`,
    );
  }
  /**
   * B166 (D194): a row that has just taken `previous`'s place with a new address a suppression
   * names takes the withdrawal it stands for, as a holder row would have carried it: the public
   * "all lists" path (D128), every membership unsubscribed with its consent webhook and the running
   * enrollments whose next step is marketing ended. The status stays, so transactional mail flows.
   */
  const took = (row: SubscriberRow, previous: string | undefined): SubscriberRow => {
    if (row.email !== previous && subscribers.addressSuppressed(row.email)) {
      subscribers.unsubscribeAll(row.id);
      enrollments.unsubscribeEffects.unsubscribedAll({ subscriberId: row.id });
    }
    return row;
  };
  // Every write below goes by ID and touches only the fields the source owns (address, name,
  // user ID), and every status decision reads the rows as they are now: a blocklist, bounce or
  // unsubscribe that landed while the source was read stays.
  if (conflict.kind === "moved") {
    const taken = subscribers.byEmail(conflict.email);
    if (taken && taken.id !== conflict.holder.id) {
      if (!now || taken.id !== now.id) {
        throw new SubscriberChanged();
      }
      // A swap (D179): the user's own row frees its old address for the holder through a
      // placeholder no mail can reach; the row takes the view's address below, in this transaction.
      subscribers.sourceWrite(now.id, {
        externalId: userId,
        email: `swap-${crypto.randomUUID()}@swap.invalid`,
      });
    }
    took(
      subscribers.sourceWrite(conflict.holder.id, {
        externalId: conflict.holder.external_id ?? "",
        email: conflict.email,
      }),
      conflict.holder.email,
    );
    return took(
      subscribers.sourceWrite(now?.id ?? null, { externalId: userId, email, name }),
      now?.email,
    );
  }
  if (conflict.kind === "gone") {
    enrollments.endSubscriber(conflict.holder.id);
    if (!now) {
      // Re-point the holder to the incoming user: blocklist, unsubscribes and cap history stay.
      // The holder row keeps its own address: it takes nothing new.
      return subscribers.sourceWrite(conflict.holder.id, { externalId: userId, email, name });
    }
    // Carry the holder's consent onto the incoming row, delete the holder, take the address.
    subscribers.carryConsent(conflict.holder.id, now.id);
    subscribers.remove([conflict.holder.id]);
    return took(subscribers.sourceWrite(now.id, { externalId: userId, email, name }), now.email);
  }
  return took(
    subscribers.sourceWrite(now?.id ?? null, { externalId: userId, email, name }),
    now?.email,
  );
}

/**
 * The user is leaving (spec section 7): the subscriber goes, its enrollments ended first. Consent
 * the person withdrew (a blocklist, an unsubscribe) stays as a suppression, in the same
 * transaction, so a returning user is not re-granted it. The caller holds the write. Returns the
 * removed subscriber's ID, or null when the user had none.
 */
export function leaveUser(
  options: {
    subscribers: Pick<SubscriberStore, "external" | "removeLeaving">;
    enrollments: Pick<Enrollments, "endSubscriber">;
  },
  userId: string,
): bigint | null {
  const row = options.subscribers.external(userId);
  if (row) {
    options.enrollments.endSubscriber(row.id);
    options.subscribers.removeLeaving(row.id);
  }
  return row?.id ?? null;
}
