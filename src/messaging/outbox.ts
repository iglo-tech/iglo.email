// Native outbox: claim and recovery are journal-owned, SMTP is outside writes. The claim is split by
// kind (B141, 14-projects section 7): transactional rows are claimed at once and take the next start;
// marketing rows are claimed only against the dispatcher's grant, with no transaction open while it
// waits, so a crash leaves at most the granted slots claimed and not started.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import type { ErrorLogger } from "@/app";
import type { Claimed, Sends } from "@/messaging/sends";
import type { Outcome } from "@/messaging/email";
import { HORIZON_MS } from "@/messaging/dispatcher";
import type { Grant, Sender, SenderDelivery } from "@/messaging/dispatcher";
import { writeTransaction } from "@/db/transaction";
import { createLoop } from "@/loops/loop";
import { sendingHeld } from "@/settings/hold";
import { must } from "@/invariant";

// A marketing send has exactly one SMTP recipient, its admitted subscriber.
const copies = (row: { kind: string }) => ({ copies: row.kind !== "marketing" });
/** One turn of the event loop: resolves after the callbacks already queued have run (B118a). */
const loopTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
/**
 * A claim's lease (D80). A push is cut off 60 s after it starts (`dispatch` in email.ts), so a
 * healthy push settles well inside this; only a row that outlives it is moved to `unknown`.
 */
const leaseMs = 120_000;
/** Rows claimed per commit, and marketing slots asked for; their SMTP calls run in parallel. */
const batchSize = 10;
/** A synchronous marketing send waits at most this long for a grant, then stays queued (B141). */
const syncGrantWaitMs = HORIZON_MS + 5000;

const uncertain = (row: { smtp_message_id: string }): Outcome => ({
  messageId: row.smtp_message_id,
  status: "ambiguous",
  stage: "unknown",
  accepted: [],
  rejected: [],
});

/** Create and start, for callers that claim at once. The server creates, then starts (B52). */
export function startOutbox(options: OutboxOptions) {
  const outbox = createOutbox(options);
  outbox.start();
  return outbox;
}

export interface OutboxOptions {
  db: Database;
  clock: Clock;
  logger: ErrorLogger;
  sends: Sends;
  /** This project's side of the instance dispatcher. */
  sender: Pick<Sender, "push" | "request" | "closed">;
}

/** Creates the outbox without claiming: nothing is recovered, claimed or armed before `start`. */
export function createOutbox(options: OutboxOptions) {
  // Rows whose push is live in this process; their lease is not expired under them.
  const live = new Set<bigint>();
  let deadline: AbortController | undefined;
  let stopped = false;
  // Ends every wait for a grant at stop: a marketing loop or dispatch waiting holds no claim.
  const stopping = new AbortController();
  let failTimer!: (error: Error) => void;
  const timerFailure = new Promise<never>((_resolve, reject) => {
    failTimer = reject;
  });
  void timerFailure.catch(() => {});
  const arm = () => {
    deadline?.abort();
    deadline = undefined;
    const due = options.sends.nextDue();
    if (!due || stopped || sendingHeld(options.db)) {
      return;
    }
    const delay = Math.max(0, Date.parse(due) - options.clock.now().getTime());
    const controller = new AbortController();
    deadline = controller;
    void options.clock.sleep(delay, controller.signal).then(
      () => {
        if (deadline === controller) {
          deadline = undefined;
          loop.wake();
          marketingLoop.wake();
        }
      },
      () => {
        if (!controller.signal.aborted) {
          try {
            options.logger.attention("Outbox deadline failed", "Outbox deadline failed");
          } catch {
            /* Preserve deadline failure. */
          }
          failTimer(new Error("Outbox deadline failed"));
          void loop.stop();
          void marketingLoop.stop();
        }
      },
    );
  };
  const loop = createLoop({
    db: options.db,
    clock: options.clock,
    logger: { error: () => options.logger.attention("Outbox failed", "Outbox failed") },
    intervalMs: 1000,
    leaseMs,
    batchSize: 1,
    // One loop item is a batch of transactional rows: its claims and admissions committed together
    // before SMTP. They take the next start, ahead of every marketing and campaign message.
    claim: (now, lease) => {
      options.sends.expireLeases(now, [...live]);
      // Held (D67) or closed: nothing is claimed, so refused rows are not claimed again at once.
      if (sendingHeld(options.db) || options.sender.closed) {
        return [];
      }
      const batch = options.sends.claimBatch(now, lease, batchSize, "transactional");
      return batch.length ? [batch] : [];
    },
    async process(batch) {
      await deliver(batch);
      arm();
    },
  });
  // Marketing rows reserve before they claim, in a loop of their own so a wait for slots never
  // holds up a transactional row. Its claim only looks: a due row asks for a grant.
  const marketingLoop = createLoop({
    db: options.db,
    clock: options.clock,
    logger: { error: () => options.logger.attention("Outbox failed", "Outbox failed") },
    intervalMs: 1000,
    leaseMs,
    batchSize: 1,
    signal: stopping.signal,
    claim: (now) =>
      sendingHeld(options.db) || options.sender.closed || !options.sends.marketingDue(now)
        ? []
        : [true],
    async process() {
      await granted((grant) => {
        const now = options.clock.now();
        return writeTransaction(options.db, () => {
          options.sends.expireLeases(now, [...live]);
          if (sendingHeld(options.db) || options.sender.closed) {
            return [];
          }
          const lease = new Date(now.getTime() + leaseMs);
          return options.sends.claimBatch(now, lease, grant.count, "marketing");
        });
      }, stopping.signal);
      arm();
    },
  });
  /**
   * Asks for up to a batch of marketing slots, claims at most that many rows with `claim` once the
   * grant is in hand, and pushes them in its slots. Slots no admitted row uses go back at once. A
   * wait that ends without a grant (stop, or the synchronous bound) claims nothing.
   */
  async function granted(claim: (grant: Grant) => Array<Claimed>, signal: AbortSignal) {
    let grant: Grant;
    try {
      grant = await options.sender.request("marketing", batchSize, signal);
    } catch {
      return;
    }
    try {
      const batch = claim(grant);
      grant.keep(batch.filter((claimed) => claimed.message).length);
      await deliver(batch, grant);
    } finally {
      grant.release();
    }
  }
  /**
   * Push every admitted message of a committed batch and journal all outcomes in one commit.
   * A push that rejects is journaled `unknown`/`uncertain`, as the campaign runner does (the
   * message may have left; never retried), and then fails the caller.
   */
  async function deliver(batch: Array<Claimed>, grant?: Grant) {
    type Settled = { row: Claimed["row"]; refused?: unknown; result?: Promise<Outcome> };
    const pending: Array<Settled> = [];
    const ids: Array<bigint> = [];
    let settled: Array<PromiseSettledResult<Outcome | undefined>>;
    try {
      for (const claimed of batch) {
        const { row, message } = claimed;
        if (!message) {
          continue;
        }
        // The emailer owns the message from here; the batch must not keep it alive (B28).
        claimed.message = null;
        ids.push(row.id);
        live.add(row.id);
        try {
          const delivery: SenderDelivery = grant ? { ...copies(row), grant } : copies(row);
          const result = options.sender.push(message, delivery).result;
          // Handled from the push on: a rejection that lands during the turn below, before the
          // settle loop attaches, is not an unhandled one. The settle loop still sees it.
          void Promise.resolve(result).catch(() => {});
          pending.push({ row, result });
        } catch (error) {
          // Thrown before a pool saw the message (the restore hold refuses here): never sent.
          pending.push({ row, refused: error });
        }
        // Each message's MIME is built on the loop as it is pushed; a turn between messages lets
        // other requests run while a batch of them is pushed (B118a).
        await loopTurn();
      }
      // A refused row has no push: Promise.resolve settles it as undefined, as allSettled already did.
      settled = await Promise.allSettled(pending.map((p) => Promise.resolve(p.result)));
    } finally {
      for (const id of ids) {
        live.delete(id);
      }
    }
    const held = sendingHeld(options.db);
    let failure: { reason: unknown } | undefined;
    options.sends.finishAll(
      pending.map((p, i) => {
        const s = must(settled[i], "settled send");
        if (!p.result) {
          if (!held) {
            failure ??= { reason: p.refused };
          }
          return { row: p.row, unsent: held ? "held" : "failed" } as const;
        }
        if (s.status === "rejected") {
          failure ??= { reason: s.reason };
        }
        if (s.status === "fulfilled" && s.value?.stage === "not-started") {
          return { row: p.row, unsent: "held" } as const;
        }
        return {
          row: p.row,
          outcome: s.status === "fulfilled" ? must(s.value, "send outcome") : uncertain(p.row),
        };
      }),
    );
    if (failure) {
      throw failure.reason;
    }
  }
  /**
   * A synchronous marketing send (POST /api/tx): waits at most the horizon plus 5 s for a grant,
   * then claims its rows against it. Without one (a backlog, or the quota guard) its rows stay
   * `queued` and the outbox sends them later; the response is the async answer.
   */
  async function dispatchMarketing(ids: Array<bigint>) {
    const bound = new AbortController();
    const onStop = () => bound.abort();
    stopping.signal.addEventListener("abort", onStop, { once: true });
    void options.clock.sleep(syncGrantWaitMs, bound.signal).then(
      () => bound.abort(),
      () => {},
    );
    try {
      await granted((grant) => {
        const now = options.clock.now();
        const lease = new Date(now.getTime() + leaseMs);
        return sendingHeld(options.db) || options.sender.closed
          ? []
          : options.sends.claimQueued(ids, now, lease, "marketing", grant.count);
      }, bound.signal);
    } finally {
      stopping.signal.removeEventListener("abort", onStop);
      bound.abort();
    }
  }
  const inflight = new Set<Promise<void>>();
  const done = Promise.race([loop.done, marketingLoop.done, timerFailure]);
  void done.catch(() => {});
  return {
    done,
    /**
     * Recovers the rows a previous process left, then claims. Called once, after the port is
     * bound, so a start that cannot listen recovers and claims nothing.
     */
    start() {
      options.sends.recover();
      loop.start();
      marketingLoop.start();
      options.sends.onWake((kinds) => {
        if (!kinds || kinds.includes("transactional")) {
          loop.wake();
        }
        if (!kinds || kinds.includes("marketing")) {
          marketingLoop.wake();
        }
        arm();
      });
      arm();
    },
    /**
     * Send specific just-committed queued rows now and resolve after their outcomes
     * are journaled. Call synchronously after the enqueue commit so the loop cannot
     * claim them first; a row it did claim is left to the loop. Retry deadlines and
     * unclaimed rows stay with the loop.
     */
    dispatch(ids: Array<bigint>): Promise<void> {
      if (stopped || sendingHeld(options.db)) {
        return Promise.resolve();
      }
      const now = options.clock.now();
      const lease = new Date(now.getTime() + leaseMs);
      const marketing = options.sends.queuedOfKind(ids, "marketing");
      const batch = options.sends.claimQueued(ids, now, lease, "transactional");
      // Both halves settle before this does: a failed transactional half must not let stop() pass
      // while the marketing half still pushes and journals (its requeues need the open database).
      const all = Promise.allSettled([
        deliver(batch),
        marketing.length ? dispatchMarketing(marketing) : null,
      ])
        .then((results) => {
          for (const result of results) {
            if (result.status === "rejected") {
              throw result.reason;
            }
          }
        })
        .then(
          () => arm(),
          () => options.logger.attention("Outbox dispatch failed", "Outbox dispatch failed"),
        );
      inflight.add(all);
      void all.finally(() => inflight.delete(all));
      return all;
    },
    async stop() {
      stopped = true;
      deadline?.abort();
      stopping.abort();
      options.sends.onWake(() => {});
      try {
        await Promise.all([loop.stop(), marketingLoop.stop()]);
      } finally {
        await Promise.allSettled(inflight);
      }
    },
  };
}
