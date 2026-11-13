// The campaign runner wired over the M3.1 campaigns fixture as src/main.ts wires it, with a
// controllable emailer that records each push on the injected clock.
import { campaignsFixture } from "@/test/campaigns/fixture";
import { createRunnerStore } from "@/campaigns/runner/store";
import {
  createCampaignRunnerRegistry,
  startCampaignRunner,
  type RunnerDeps,
  type RunnerSettings,
} from "@/campaigns/runner/runner";
import type { Clock } from "@/clock";
import { createCampaignRecipients } from "@/subscribers/campaign-recipients";
import type { Message, Outcome } from "@/messaging/email";
import { WAIT_WALL_MS, waitWall } from "@/test/wait";

export interface Push {
  at: number;
  message: Message;
  to: string;
  settle(status?: Outcome["status"]): void;
}

export async function runnerFixture(
  options: { hold?: boolean; realEmailer?: boolean } & Parameters<typeof campaignsFixture>[0] = {},
) {
  const f = await campaignsFixture(options);
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
    closed: false,
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
      emailer: options.realEmailer ? (f.owners.emailer as RunnerDeps["emailer"]) : emailer,
      settings: () => settings,
      attachments: f.owners.attachments,
      embedImages: f.owners.embedImages,
      leaseMs,
    });
    runners.push(runner);
    f.runnerWake.current = () => runner.wake();
    return runner;
  };
  /** Campaigns this fixture created, so a stuck wait can report their state. */
  const campaignIds: number[] = [];
  const campaign = async (input: object) => {
    const created = await f.campaign(input);
    campaignIds.push(created.id);
    return created;
  };
  /**
   * The state of the campaigns a stuck wait was waiting on, from public reads and the runner
   * store. It runs only while a wait's own error is being reported, so it never throws.
   */
  async function stuckState(): Promise<string> {
    const parts = await Promise.all(
      campaignIds.map(async (id) => {
        try {
          const body = (await read(id)) as { status: string; sent: number; to_send: number };
          const lease = store.state(BigInt(id))?.runner_lease ? "held" : "free";
          return (
            `campaign ${id} status ${body.status} sent ${body.sent} ` +
            `to_send ${body.to_send} lease ${lease}`
          );
        } catch (error) {
          return `campaign ${id} unreadable (${error instanceof Error ? error.message : String(error)})`;
        }
      }),
    );
    return parts.join("; ") || "no campaigns";
  }
  /**
   * Lets I/O and microtasks run, then advances the clock by `step`, until `done()`. The wait is
   * bounded by real time (`wallMs`, default WAIT_WALL_MS) and by `limit` iterations, and it fails
   * with the stuck state (docs/perf/B49-drive-bound.md, test/wait.ts).
   */
  const drive = async (
    done: () => boolean | Promise<boolean>,
    step = 50,
    limit = 10_000_000,
    wallMs = WAIT_WALL_MS,
  ) => {
    const clockStart = f.clock.now().getTime();
    await waitWall(done, {
      label: "drive",
      advance: (ms) => f.clock.advance(ms),
      step,
      limit,
      wallMs,
      describe: async () =>
        `clock ${f.clock.now().toISOString()} (+${f.clock.now().getTime() - clockStart} ms); ` +
        `pushes ${pushes.length}, pending sends ${inFlight}, ` +
        `sink messages ${f.sink.messages.length}; ` +
        // Only the state read is replaced on failure: the clock, pushes and sink counts still show.
        (await stuckState().catch((error: unknown) => `state unavailable (${error})`)),
    });
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
    campaign,
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
