// New synthetic workload: fixed deadlines and progress timing, not an upstream send pipeline.
import type { Clock } from "@/clock";
import {
  SpikeStore,
  type Mutation,
  type SyntheticEvent,
} from "@/test/perf/sqlite-write-load/store";

export type Mode = "record" | "batch" | "campaign-only";
export interface WorkloadOptions {
  mode: Mode;
  durationMs: number;
  subscribers: number;
  churn?: boolean;
}
type Samples = {
  campaignLagMs: number[];
  eventAcceptLagMs: number[];
  eventCommitLagMs: number[];
  transactionMs: number[];
  wakeLagMs: number[];
  pumpBlockMs: number[];
};

export class Workload {
  readonly startedAt: number;
  readonly endAt: number;
  readonly samples: Samples = {
    campaignLagMs: [],
    eventAcceptLagMs: [],
    eventCommitLagMs: [],
    transactionMs: [],
    wakeLagMs: [],
    pumpBlockMs: [],
  };
  readonly transactions: Record<string, { count: number; records: number }> = {};
  readonly postWindowTransactions: Record<string, { count: number; records: number }> = {};
  private campaignDone = 0;
  private eventsDone = 0;
  private churnDone = 0;
  private inWindowCampaign = 0;
  private inWindowEvents = 0;
  private inWindowChurn = 0;
  private maxCampaignBacklog = 0;
  private maxEventBacklog = 0;
  private maxChurnBacklog = 0;
  constructor(
    private readonly store: SpikeStore,
    private readonly clock: Clock,
    readonly options: WorkloadOptions,
  ) {
    if (options.durationMs < 1 || options.subscribers < Math.ceil(options.durationMs / 20))
      throw new Error("Invalid workload bounds");
    this.startedAt = clock.now().getTime();
    this.endAt = this.startedAt + options.durationMs;
    store.observer = (kind, size, ms) => {
      const inWindow = this.clock.now().getTime() < this.endAt;
      if (inWindow) this.samples.transactionMs.push(ms);
      const target = inWindow ? this.transactions : this.postWindowTransactions;
      const count = (target[kind] ??= { count: 0, records: 0 });
      count.count++;
      count.records += size;
    };
  }
  private offered(now: number, interval: number) {
    const elapsed = Math.min(now - this.startedAt, this.options.durationMs - 1);
    return elapsed < 0 ? 0 : Math.floor(elapsed / interval) + 1;
  }
  private eventOffered(now: number) {
    return this.options.mode === "campaign-only" ? 0 : this.offered(now, 10);
  }
  private churnOffered(now: number) {
    return this.options.mode === "campaign-only" || this.options.churn === false
      ? 0
      : this.offered(now, 200);
  }
  private observeQueues(now: number) {
    this.maxCampaignBacklog = Math.max(
      this.maxCampaignBacklog,
      this.offered(now, 20) - this.campaignDone,
    );
    this.maxEventBacklog = Math.max(this.maxEventBacklog, this.eventOffered(now) - this.eventsDone);
    this.maxChurnBacklog = Math.max(this.maxChurnBacklog, this.churnOffered(now) - this.churnDone);
  }
  observeWake(deadline: number) {
    this.samples.wakeLagMs.push(Math.max(0, this.clock.now().getTime() - deadline));
  }
  pump(drain = false) {
    const now = this.clock.now().getTime();
    this.observeQueues(now);
    if (!drain && now >= this.endAt) return;
    const maxBatch = this.options.mode === "record" ? 1 : 50;
    const campaignEnd = Math.min(this.offered(now, 20), this.campaignDone + 50);
    while (this.campaignDone < campaignEnd) {
      const index = this.campaignDone;
      const count = Math.min(maxBatch, campaignEnd - index);
      const ids = this.store.reserve(count);
      if (ids.length !== count || ids.some((id, offset) => id !== index + offset + 1))
        throw new Error("Unexpected campaign reservation");
      this.store.process(count);
      const completed = this.clock.now().getTime();
      this.campaignDone += count;
      if (completed < this.endAt) {
        this.inWindowCampaign += count;
        for (let offset = 0; offset < count; offset++)
          this.samples.campaignLagMs.push(
            Math.max(0, completed - (this.startedAt + (index + offset) * 20)),
          );
      }
    }
    const eventsEnd = Math.min(this.eventOffered(now), this.eventsDone + 50);
    while (this.eventsDone < eventsEnd) {
      const index = this.eventsDone;
      const count = Math.min(maxBatch, eventsEnd - index);
      const accepted = this.clock.now().getTime();
      const events: SyntheticEvent[] = Array.from({ length: count }, (_, offset) => {
        const sequence = index + offset;
        return {
          subscriber: (sequence % this.options.subscribers) + 1,
          key: `event-${sequence}`,
          sequence,
          occurredAt: new Date(Date.parse("2026-01-02T03:04:05Z") + sequence * 10).toISOString(),
        };
      });
      this.store.events(events);
      const committed = this.clock.now().getTime();
      this.eventsDone += count;
      if (committed < this.endAt) {
        this.inWindowEvents += count;
        for (let offset = 0; offset < count; offset++) {
          const deadline = this.startedAt + (index + offset) * 10;
          this.samples.eventAcceptLagMs.push(Math.max(0, accepted - deadline));
          this.samples.eventCommitLagMs.push(Math.max(0, committed - deadline));
        }
      }
    }
    const churnEnd = Math.min(this.churnOffered(now), this.churnDone + 20);
    while (this.churnDone < churnEnd) {
      const count = Math.min(maxBatch, churnEnd - this.churnDone);
      const operations: Mutation[] = [];
      for (let offset = 0; offset < count; offset++) {
        const id = this.options.subscribers + this.churnDone + offset + 1;
        operations.push(
          {
            operation: "insert",
            id,
            name: `Churn original ${id}`,
            email: `churn${id}@example.test`,
          },
          {
            operation: "update",
            id,
            name: `Churn changed ${id}`,
            email: `updated${id}@example.test`,
          },
          { operation: "delete", id },
        );
      }
      if (this.options.mode === "record") {
        for (const operation of operations) this.store.mutate([operation]);
      } else this.store.mutate(operations);
      this.churnDone += count;
      if (this.clock.now().getTime() < this.endAt) this.inWindowChurn += count;
    }
  }
  drain() {
    while (
      this.campaignDone < this.offered(this.endAt, 20) ||
      this.eventsDone < this.eventOffered(this.endAt) ||
      this.churnDone < this.churnOffered(this.endAt)
    )
      this.pump(true);
  }
  result() {
    const now = this.clock.now().getTime();
    this.observeQueues(now);
    const offeredCampaign = this.offered(now, 20);
    const offeredEvents = this.eventOffered(now);
    const offeredChurn = this.churnOffered(now);
    return {
      offeredCampaign,
      offeredEvents,
      offeredChurn,
      completedCampaign: this.inWindowCampaign,
      committedEvents: this.inWindowEvents,
      completedChurn: this.inWindowChurn,
      drainedCampaign: this.campaignDone - this.inWindowCampaign,
      drainedEvents: this.eventsDone - this.inWindowEvents,
      drainedChurn: this.churnDone - this.inWindowChurn,
      campaignBacklog: offeredCampaign - this.campaignDone,
      eventBacklog: offeredEvents - this.eventsDone,
      churnBacklog: offeredChurn - this.churnDone,
      maxCampaignBacklog: this.maxCampaignBacklog,
      maxEventBacklog: this.maxEventBacklog,
      maxChurnBacklog: this.maxChurnBacklog,
      windowEndCampaignBacklog: this.offered(this.endAt, 20) - this.inWindowCampaign,
      windowEndEventBacklog: this.eventOffered(this.endAt) - this.inWindowEvents,
      windowEndChurnBacklog: this.churnOffered(this.endAt) - this.inWindowChurn,
      transactions: this.transactions,
      postWindowTransactions: this.postWindowTransactions,
    };
  }
}
