// The campaign runner wired over the M3.1 campaigns fixture as src/main.ts wires it, with a
// controllable sender that stands in for the dispatcher (B141): it grants `control.grant` slots per
// request, so that is the batch size, and records each push on the injected clock.
import { campaignsFixture } from "@/test/campaigns/fixture";
import type { JsonObject } from "@/test/json-object";
import { createRunnerStore } from "@/campaigns/runner/store";
import { createCampaignRunnerRegistry, startCampaignRunner } from "@/campaigns/runner/runner";
import type { RunnerSettings } from "@/campaigns/runner/runner";
import type { Clock } from "@/clock";
import { createCampaignRecipients } from "@/subscribers/campaign-recipients";
import type { Message, Outcome } from "@/messaging/email";
import type { Grant, GrantClass, SenderDelivery } from "@/messaging/dispatcher";
import { WAIT_WALL_MS, waitWall } from "@/test/wait";
import { asBody } from "@/test/read-body";
import { fixtureGrant } from "@/test/messaging/sender";

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
  const pushes: Array<Push> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const control = {
    hold: options.hold ?? false,
    outcome: "accepted" as Outcome["status"],
    /** Slots granted per request: a batch claims at most this many recipients. */
    grant: 1000,
    /**
     * While set, a batch waits after its claim commits and before any of it is pushed, so a test
     * can change consent between the claim and the push. `claimed` resolves when one waits.
     */
    gate: null as Promise<void> | null,
  };
  let claimed: (() => void) | undefined;
  /** Resolves once a claimed batch waits at `control.gate`. */
  const batchClaimed = () =>
    new Promise<void>((resolve) => {
      claimed = resolve;
    });
  /** The grants this sender handed out; a push with one uses one of its slots. */
  const grants = new WeakMap<Grant, ReturnType<typeof fixtureGrant>>();
  const used = (grant: Grant) => grants.get(grant)?.use();
  const emailer = {
    closed: false,
    request: (_cls: GrantClass, count: number) => {
      const grant = fixtureGrant(Math.min(count, control.grant));
      grants.set(grant, grant);
      return Promise.resolve(grant);
    },
    push(message: Message, delivery?: SenderDelivery) {
      const grant = delivery?.grant;
      if (grant) {
        used(grant);
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      let resolve!: (outcome: Outcome) => void;
      const result = new Promise<Outcome>((done) => {
        resolve = done;
      });
      let settled = false;
      const settle = (status = control.outcome) => {
        if (settled) {
          return;
        }
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
      if (!control.hold) {
        queueMicrotask(() => settle());
      }
      return { messageId: message.messageId ?? "", result };
    },
  };
  const settings: RunnerSettings = {
    maxSendErrors: 1000,
    rootUrl: "http://fixture.test",
    brand: {
      logoUrl: "",
      siteName: "Fixture",
      siteUrl: "",
      accent: "",
      font: "system-sans",
      header: "auto",
    },
    messengers: ["email", "fixture"],
    unsubscribeHeader: true,
    disableTracking: false,
    individualTracking: false,
  };
  const runners: Array<ReturnType<typeof startCampaignRunner>> = [];
  // Runners of one fixture share a process and so a data directory (D15).
  const registry = createCampaignRunnerRegistry();
  const start = (leaseMs = 30_000, clock: Clock = f.clock) => {
    const runner = startCampaignRunner({
      db: f.db,
      clock,
      registry,
      logger: {
        error: (error) => f.errors.push(error),
        attention: (message) => f.errors.push(new Error(message)),
      },
      store,
      campaigns: f.owners.store,
      recipients,
      lists: f.owners.lists,
      templates: f.owners.templates,
      renderer: f.owners.renderer,
      tracking: f.owners.tracking,
      sender: options.realEmailer ? f.owners.emailer.sender : emailer,
      settings: () => settings,
      attachments: async (ids, inline) => {
        const gate = control.gate;
        if (gate) {
          claimed?.();
          await gate;
        }
        return f.owners.attachments(ids, inline);
      },
      embedImages: f.owners.embedImages,
      leaseMs,
    });
    runners.push(runner);
    f.runnerWake.current = () => runner.wake();
    return runner;
  };
  /** Campaigns this fixture created, so a stuck wait can report their state. */
  const campaignIds: Array<number> = [];
  const campaign = async (input: JsonObject) => {
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
          const body = asBody<{ status: string; sent: number; to_send: number }>(await read(id));
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
        (await stuckState().catch((error: unknown) => `state unavailable (${error})`)) +
        // What the runner logged: a subscriber that was not pushed is named here, not only counted.
        `; logged errors ${f.errors.length}` +
        (f.errors.length
          ? ` (first: ${f.errors
              .slice(0, 3)
              .map((error) => (error instanceof Error ? error.message : String(error)))
              .join(" | ")})`
          : ""),
    });
  };
  const read = async (id: number) =>
    asBody<Record<string, any>>((await f.json(`/api/campaigns/${id}`)).body.data);
  const until = (id: number, value: string) => drive(async () => (await read(id)).status === value);
  const status = (id: number, value: string) =>
    f.json(`/api/campaigns/${id}/status`, "PUT", { status: value });
  /** Subscribers with given list statuses; `status` blocklists the subscriber. */
  const member = async (
    email: string,
    lists: Array<number>,
    listStatus: "unconfirmed" | "confirmed" | "unsubscribed" = "confirmed",
    extra: JsonObject = {},
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
      if (r.status !== 200) {
        throw new Error(`unsubscribe ${r.status}`);
      }
    }
    return sub;
  };
  const listStatus = async (subscriberId: number, listId: number) =>
    asBody<Array<{ id: number; subscription_status: string }>>(
      (await f.json(`/api/subscribers/${subscriberId}`)).body.data.lists,
    ).find((l) => l.id === listId)?.subscription_status;
  return {
    ...f,
    campaign,
    pushes,
    control,
    batchClaimed,
    runnerStore: store,
    settings,
    /** The public routes' settings (the campaigns fixture's), read by the view pixel and the pages. */
    publicSettings: f.settings,
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
      for (const push of pushes) {
        push.settle();
      }
      await Promise.all(stopping);
      recipients.close();
      store.close();
      await f.close();
    },
  };
}
export type RunnerFixture = Awaited<ReturnType<typeof runnerFixture>>;
