// The campaign runner wired over the M3.1 campaigns fixture as src/main.ts wires it, with a
// controllable emailer that records each push on the injected clock.
import { campaignsFixture } from "@/test/campaigns/fixture";
import { createRunnerStore } from "@/campaigns/runner/store";
import {
  createCampaignRunnerRegistry,
  startCampaignRunner,
  type RunnerSettings,
} from "@/campaigns/runner/runner";
import type { Clock } from "@/clock";
import { createCampaignRecipients } from "@/subscribers/campaign-recipients";
import type { Message, Outcome } from "@/messaging/email";

export interface Push {
  at: number;
  message: Message;
  to: string;
  settle(status?: Outcome["status"]): void;
}

export async function runnerFixture(options: { hold?: boolean } = {}) {
  const f = await campaignsFixture();
  const store = createRunnerStore(f.db);
  const recipients = createCampaignRecipients(f.db);
  const pushes: Push[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const control = {
    hold: options.hold ?? false,
    outcome: "accepted" as Outcome["status"],
  };
  const emailer = {
    push(message: Message) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      let resolve!: (outcome: Outcome) => void;
      const result = new Promise<Outcome>((done) => (resolve = done));
      let settled = false;
      const settle = (status = control.outcome) => {
        if (settled) return;
        settled = true;
        inFlight--;
        resolve({
          messageId: message.messageId ?? "",
          status,
          stage: status === "accepted" ? "smtp-complete" : "recipients",
          accepted: status === "accepted" ? [...message.to] : [],
          rejected: [],
        });
      };
      pushes.push({ at: f.clock.now().getTime(), message, to: message.to[0]!, settle });
      if (!control.hold) queueMicrotask(() => settle());
      return { messageId: message.messageId ?? "", result };
    },
  };
  const settings: RunnerSettings = {
    batchSize: 1000,
    concurrency: 10,
    messageRate: 1000,
    maxSendErrors: 1000,
    slidingWindow: false,
    slidingWindowDuration: "1h",
    slidingWindowRate: 10000,
    rootUrl: "http://fixture.test",
    messengers: ["email", "fixture"],
    unsubscribeHeader: true,
    disableTracking: false,
    individualTracking: false,
  };
  const runners: ReturnType<typeof startCampaignRunner>[] = [];
  // Runners of one fixture share a process and so a data directory (D15).
  const registry = createCampaignRunnerRegistry();
  const start = (leaseMs = 30_000, clock: Clock = f.clock) => {
    const runner = startCampaignRunner({
      db: f.db,
      clock,
      registry,
      logger: { error: (error) => f.errors.push(error) },
      store,
      campaigns: f.owners.store,
      recipients,
      lists: f.owners.lists,
      templates: f.owners.templates,
      renderer: f.owners.renderer,
      tracking: f.owners.tracking,
      emailer,
      settings: () => settings,
      leaseMs,
    });
    runners.push(runner);
    return runner;
  };
  /** Lets I/O and microtasks run, then advances the clock by `step`, until `done()`. */
  const drive = async (done: () => boolean | Promise<boolean>, step = 50, limit = 20_000) => {
    for (let i = 0; i < limit; i++) {
      for (let j = 0; j < 3; j++) await Bun.sleep(0);
      if (await done()) return;
      f.clock.advance(step);
    }
    throw new Error("drive: condition not reached");
  };
  const read = async (id: number) => (await f.json(`/api/campaigns/${id}`)).body.data;
  const until = (id: number, value: string) => drive(async () => (await read(id)).status === value);
  const status = (id: number, value: string) =>
    f.json(`/api/campaigns/${id}/status`, "PUT", { status: value });
  /** Subscribers with given list statuses; `status` blocklists the subscriber. */
  const member = async (
    email: string,
    lists: number[],
    listStatus: "unconfirmed" | "confirmed" | "unsubscribed" = "confirmed",
    extra: object = {},
  ) => {
    const sub = await f.subscriber(email, lists, {
      preconfirm_subscriptions: listStatus === "confirmed",
      ...extra,
    });
    if (listStatus === "unsubscribed") {
      const r = await f.json("/api/subscribers/lists", "PUT", {
        ids: [sub.id],
        action: "unsubscribe",
        target_list_ids: lists,
      });
      if (r.status !== 200) throw new Error(`unsubscribe ${r.status}`);
    }
    return sub;
  };
  const listStatus = async (subscriberId: number, listId: number) =>
    (await f.json(`/api/subscribers/${subscriberId}`)).body.data.lists.find(
      (l: { id: number }) => l.id === listId,
    )?.subscription_status as string | undefined;
  return {
    ...f,
    pushes,
    control,
    runnerStore: store,
    settings,
    start,
    drive,
    read,
    until,
    status,
    member,
    listStatus,
    get maxInFlight() {
      return maxInFlight;
    },
    get inFlight() {
      return inFlight;
    },
    async close() {
      const stopping = runners.map((runner) => runner.stop().catch(() => {}));
      control.hold = false;
      for (const push of pushes) push.settle();
      await Promise.all(stopping);
      recipients.close();
      store.close();
      await f.close();
    },
  };
}
export type RunnerFixture = Awaited<ReturnType<typeof runnerFixture>>;
