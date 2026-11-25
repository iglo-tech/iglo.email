// Native (15-external-sources sections 4 and 7, D173, D174): a source user's recipients-view row
// into the subscriber linked to it. The record handler (src/sources/records.ts) and the send-time
// lookup (src/sources/send-time.ts) share it, so an address change takes one conflict path:
//
// - `planRecipient` does every read (the user's row in the view, and for an address another
//   subscriber holds, the holder's row) and plans the resolution. Never inside a transaction.
// - `applyRecipient` writes the plan inside the caller's write transaction, after checking that
//   the subscribers the reads planned on are unchanged (else `SubscriberChanged`, transient).
// - `leaveUser` removes a leaving user's subscriber inside the caller's write transaction.
import type { Enrollments } from "@/sequences/enrollments";
import { trimSpace } from "@/lists/store";
import { isSourceError, SourceError } from "@/sources/source";
import type { ExternalSource, SourceRecipient } from "@/sources/source";
import { SettingsMismatch } from "@/sources/stream-record";
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
    "external" | "byEmail" | "sourceWrite" | "carryConsent" | "remove"
  >;
  enrollments: Pick<Enrollments, "endSubscriber">;
  /** The privacy domain policy for a new or changed address. */
  emailAllowed: (email: string) => boolean;
}

/**
 * A recipients-view read whose failure is the settings' (a `400`, `403` or `404` of the view, or a
 * mapped field the rows lack) is a `SettingsMismatch`. Any other failure is the record's or
 * transient.
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

/**
 * How the incoming address meets another subscriber that holds it (spec section 4), as read before
 * the transaction: `moved` (the holder's user now has `email` in the view: move the holder there),
 * `gone` (the holder has no `external_id`, or the view no longer has its user).
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
  const row = await readRecipient(options.source, holder.external_id, signal);
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
  const newAddress = conflict.kind !== "gone" && current?.email !== email;
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
  options: Pick<RecipientSyncOptions, "subscribers" | "enrollments">,
  plan: Extract<RecipientPlan, { kind: "present" }>,
): SubscriberRow {
  const { subscribers, enrollments } = options;
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
  // Every write below goes by ID and touches only the fields the source owns (address, name,
  // user ID), and every status decision reads the rows as they are now: a blocklist, bounce or
  // unsubscribe that landed while the source was read stays.
  if (conflict.kind === "moved") {
    const taken = subscribers.byEmail(conflict.email);
    if (taken && taken.id !== conflict.holder.id) {
      throw new SubscriberChanged();
    }
    subscribers.sourceWrite(conflict.holder.id, {
      externalId: conflict.holder.external_id ?? "",
      email: conflict.email,
    });
    return subscribers.sourceWrite(now?.id ?? null, { externalId: userId, email, name });
  }
  if (conflict.kind === "gone") {
    enrollments.endSubscriber(conflict.holder.id);
    if (!now) {
      // Re-point the holder to the incoming user: blocklist, unsubscribes and cap history stay.
      return subscribers.sourceWrite(conflict.holder.id, { externalId: userId, email, name });
    }
    // Carry the holder's consent onto the incoming row, delete the holder, take the address.
    subscribers.carryConsent(conflict.holder.id, now.id);
    subscribers.remove([conflict.holder.id]);
    return subscribers.sourceWrite(now.id, { externalId: userId, email, name });
  }
  return subscribers.sourceWrite(now?.id ?? null, { externalId: userId, email, name });
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
