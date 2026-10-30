// Campaign runner adapted from listmonk internal/manager/manager.go (Run, scanCampaigns,
// worker), internal/manager/pipe.go (NextSubscribers, OnError, cleanup) and
// internal/manager/message.go at 6fcd95f, on the M0.4 loop helper. One batch is in flight
// at a time. Its cursor and per-subscriber claims commit before any of it is sent, so a
// crash can skip at most that batch and never sends a subscriber the campaign twice
// (docs/design/04-sending.md#campaigns).
import type { Database } from "bun:sqlite";
import type { ErrorLogger } from "@/app";
import type { Clock } from "@/clock";
import { writeTransaction } from "@/db/transaction";
import { startLoop } from "@/loops/loop";
import type { ListReferences } from "@/lists/references";
import type { Message, Outcome } from "@/messaging/email";
import { goDuration } from "@/settings/duration";
import type { CampaignRecipient, CampaignRecipients } from "@/subscribers/campaign-recipients";
import {
  createMessageBudget,
  RenderCapacityError,
  type TemplateRenderer,
} from "@/templates/renderer";
import type { Tracking } from "@/unsubscribe/tracking";
import { compileCampaign, dummyUUID } from "@/campaigns/render";
import type { CampaignStore } from "@/campaigns/store";
import type { DeliveryStatus, RunnableCampaign, RunnerStore } from "@/campaigns/runner/store";

export interface RunnerSettings {
  batchSize: number;
  concurrency: number;
  /** Messages per second per worker (app.message_rate). */
  messageRate: number;
  maxSendErrors: number;
  slidingWindow: boolean;
  /** Go duration (app.message_sliding_window_duration). */
  slidingWindowDuration: string;
  slidingWindowRate: number;
  rootUrl: string;
  /** "email" and the names of enabled SMTP servers. */
  messengers: string[];
  unsubscribeHeader: boolean;
  disableTracking: boolean;
  individualTracking: boolean;
}
export interface RunnerDeps {
  db: Database;
  clock: Clock;
  logger: ErrorLogger;
  store: RunnerStore;
  campaigns: Pick<CampaignStore, "registerLink">;
  recipients: CampaignRecipients;
  lists: Pick<ListReferences, "subscriberMetadata">;
  templates: {
    get(id: bigint): { body: string } | null;
    getDefault(): { body: string } | null;
  };
  renderer: TemplateRenderer;
  tracking: Pick<Tracking, "link" | "get">;
  emailer: {
    push(message: Message, delivery?: { copies?: boolean }): { result: Promise<Outcome> };
  };
  settings: () => RunnerSettings;
  /** Idle scan interval; listmonk scans every five seconds. */
  scanIntervalMs?: number;
  leaseMs?: number;
}

interface Pipe {
  campaign: RunnableCampaign;
  compiled: ReturnType<typeof compileCampaign>;
  links: Map<string, string | null>;
  errors: number;
}
interface Batch {
  pipe: Pipe;
  recipients: CampaignRecipient[];
}
type Stop = "status" | "errors" | "shutdown";

const scanInterval = 5_000;
const defaultLease = 30_000;

export function startCampaignRunner(deps: RunnerDeps) {
  const { db, clock, store } = deps;
  const leaseMs = deps.leaseMs ?? defaultLease;
  const token = crypto.randomUUID();
  const pipes = new Map<bigint, Pipe>();
  /** Campaigns whose setup failed are retried at the next scan, as listmonk does. */
  const retryAt = new Map<bigint, number>();
  let rotation = 0;
  const stopping = new AbortController();
  // Worker message counters and the sliding window are shared by all campaigns (Manager).
  const workerCounts: number[] = [];
  let slidingStart = clock.now().getTime();
  let slidingCount = 0;
  let slidingUntil = 0;

  const iso = (ms: number) => new Date(ms).toISOString();
  const log = (message: string) => deps.logger.error(new Error(message));
  const label = (c: RunnableCampaign) => `campaign ${c.id} (${c.name})`;

  function release(pipe: Pipe) {
    pipes.delete(pipe.campaign.id);
    store.release(pipe.campaign.id, token);
  }
  function audience(c: RunnableCampaign) {
    const lists = [];
    for (const id of store.listIds(c.id)) {
      const list = deps.lists.subscriberMetadata(id);
      if (list) lists.push({ id, optin: list.optin });
    }
    return { lists, type: c.type ?? "regular" };
  }
  function templateBody(c: RunnableCampaign) {
    // next-campaigns: the campaign's template body, else the default template's.
    const own = c.template_id === null ? null : deps.templates.get(c.template_id);
    return own?.body ?? deps.templates.getDefault()?.body ?? "";
  }

  /** newPipe and next-campaigns' pickup, inside the claim transaction. */
  function open(id: bigint, now: number, settings: RunnerSettings): void {
    const campaign = store.acquire(id, token, iso(now + leaseMs), iso(now));
    if (!campaign) return;
    const abandoned = store.abandon(id);
    if (abandoned.count)
      log(
        `${label(campaign)}: ${abandoned.count} subscribers with IDs ${abandoned.first}-${abandoned.last} ` +
          "were claimed before the runner stopped and may not have received the campaign. " +
          "They are not sent again; resend to them manually if needed.",
      );
    if (!settings.messengers.includes(campaign.messenger)) {
      store.cancel(id, iso(now));
      store.release(id, token);
      log(`unknown messenger ${campaign.messenger} on ${label(campaign)}`);
      return;
    }
    let compiled;
    try {
      compiled = compileCampaign(deps.renderer, {
        name: campaign.name,
        subject: campaign.subject,
        from_email: campaign.from_email,
        body: campaign.body,
        altbody: campaign.altbody,
        content_type: campaign.content_type,
        headers: JSON.parse(campaign.headers),
        attribs: JSON.parse(campaign.attribs),
        uuid: campaign.uuid,
        templateBody: templateBody(campaign),
      });
    } catch (error) {
      store.release(id, token);
      retryAt.set(id, now + (deps.scanIntervalMs ?? scanInterval));
      log(`error processing ${label(campaign)}: ${errorText(error)}`);
      return;
    }
    const measured = deps.recipients.measure(audience(campaign));
    if (measured.count === 0n) {
      // No recipients: listmonk's pipe ends at once and the campaign is finished.
      store.finish(id, iso(now));
      store.release(id, token);
      return;
    }
    const started = store.start(id, token, measured.count, measured.max, iso(now));
    if (!started) return;
    retryAt.delete(id);
    pipes.set(id, { campaign, compiled, links: new Map(), errors: 0 });
  }

  /** NextSubscribers: claims the next batch and commits its cursor, or ends the pipe. */
  function next(pipe: Pipe, now: number, settings: RunnerSettings): Batch | null {
    const id = pipe.campaign.id;
    const state = store.state(id);
    if (!state || state.runner_lease !== token) {
      pipes.delete(id);
      return null;
    }
    if (state.status !== "running") {
      // Paused or cancelled between batches (cleanup for a stopped pipe).
      release(pipe);
      return null;
    }
    const batchSize = settings.batchSize >= 1 ? Math.floor(settings.batchSize) : 1000;
    const found = deps.recipients.next(
      audience(pipe.campaign),
      state.last_subscriber_id,
      state.max_subscriber_id,
      batchSize,
    );
    if (!found.length) {
      // Subscribers are exhausted: the campaign is finished.
      store.finish(id, iso(now));
      release(pipe);
      return null;
    }
    const at = iso(now);
    const recipients = found.filter((sub) => store.claim(id, sub.id, at));
    store.advance(id, found.at(-1)!.id, at);
    store.renew(id, token, iso(now + leaseMs));
    return { pipe, recipients };
  }

  function claim(nowDate: Date): Batch[] {
    const now = nowDate.getTime();
    const settings = deps.settings();
    for (const id of store.due(iso(now))) {
      if (pipes.has(id) || (retryAt.get(id) ?? 0) > now) continue;
      open(id, now, settings);
    }
    while (pipes.size) {
      const all = [...pipes.values()];
      const pipe = all[rotation++ % all.length]!;
      const batch = next(pipe, now, settings);
      if (batch) return [batch];
    }
    return [];
  }

  function renewAll() {
    const until = iso(clock.now().getTime() + leaseMs);
    writeTransaction(db, () => {
      for (const id of pipes.keys()) store.renew(id, token, until);
    });
  }

  async function sleep(ms: number) {
    if (ms <= 0) return;
    try {
      await clock.sleep(ms, stopping.signal);
    } catch {
      /* Stopping. */
    }
  }

  async function render(pipe: Pipe, sub: CampaignRecipient, settings: RunnerSettings) {
    const c = pipe.campaign;
    const root = settings.rootUrl.replace(/\/+$/, "");
    const unsubscribeUrl = `${root}/subscription/${c.uuid}/${sub.uuid}`;
    const tracked = settings.individualTracking ? sub.uuid : dummyUUID;
    const tracking = settings.disableTracking
      ? undefined
      : {
          view: `${root}/campaign/${c.uuid}/${tracked}/px.png`,
          link(url: string) {
            let uuid = pipe.links.get(url);
            if (uuid === undefined) {
              uuid = deps.tracking.link(url);
              const link = uuid === null ? null : deps.tracking.get(uuid);
              // The campaign redirect follows only links this campaign registered.
              if (link) deps.campaigns.registerLink(c.id, link.id);
              pipe.links.set(url, uuid);
            }
            return uuid ? `${root}/link/${uuid}/${c.uuid}/${tracked}` : url;
          },
        };
    const subscriber = {
      uuid: sub.uuid,
      email: sub.email,
      name: sub.name,
      attribs: JSON.parse(sub.attribs) as Record<string, unknown>,
      external_id: sub.external_id ?? "",
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const out = pipe.compiled.render(
          subscriber,
          { unsubscribeUrl, ...(tracking ? { tracking } : {}) },
          createMessageBudget(),
        );
        const headers: Record<string, string | string[]> = {
          "X-Listmonk-Campaign": c.uuid,
          "X-Listmonk-Subscriber": sub.uuid,
        };
        if (settings.unsubscribeHeader) {
          headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
          headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
        }
        for (const set of out.headers)
          for (const [name, value] of Object.entries(set)) {
            const prior = headers[name];
            headers[name] = prior === undefined ? value : [...[prior].flat(), value];
          }
        let domain = "localhost";
        try {
          domain = new URL(settings.rootUrl).hostname || domain;
        } catch {
          /* Fallback domain. */
        }
        const message: Message = {
          from: out.from,
          to: [sub.email],
          subject: out.subject,
          contentType: c.content_type === "plain" ? "plain" : "html",
          body: Buffer.from(out.body),
          ...(out.altBody !== null ? { altBody: Buffer.from(out.altBody) } : {}),
          headers,
          messenger: c.messenger,
          messageId: `<${c.uuid}.${sub.uuid}@${domain}>`,
        };
        return message;
      } catch (error) {
        // Other renders hold the shared capacity: wait briefly; nothing has been sent.
        if (!(error instanceof RenderCapacityError) || attempt >= 50 || stopping.signal.aborted)
          throw error;
        await sleep(20);
      }
    }
  }

  /** The campaign's message workers for one batch (Manager.worker and pipe flow). */
  async function process(batch: Batch): Promise<void> {
    const { pipe, recipients } = batch;
    const c = pipe.campaign;
    const settings = deps.settings();
    const concurrency = settings.concurrency >= 1 ? Math.floor(settings.concurrency) : 1;
    const rate = settings.messageRate >= 1 ? Math.floor(settings.messageRate) : 1;
    const windowMs = goDuration(settings.slidingWindowDuration);
    const sliding =
      settings.slidingWindow &&
      settings.slidingWindowRate > 0 &&
      Number.isFinite(windowMs) &&
      windowMs > 1000;
    const outcomes = new Map<number, { status: DeliveryStatus; at: number }>();
    const pushed = new Set<number>();
    let stop: Stop | null = null;
    let sent = 0;
    let index = 0;
    const stopped = (): boolean => {
      if (stop) return true;
      if (stopping.signal.aborted) stop = "shutdown";
      else {
        const state = store.state(c.id);
        if (!state || state.status !== "running" || state.runner_lease !== token) stop = "status";
      }
      return stop !== null;
    };
    const heartbeat = new AbortController();
    const beating = (async () => {
      while (!heartbeat.signal.aborted) {
        try {
          await clock.sleep(Math.max(1, Math.floor(leaseMs / 3)), heartbeat.signal);
        } catch {
          return;
        }
        try {
          renewAll();
        } catch (error) {
          deps.logger.error(error);
        }
      }
    })();
    const worker = async (w: number) => {
      while (!stopped()) {
        const i = index++;
        if (i >= recipients.length) return;
        const sub = recipients[i]!;
        let message: Message;
        try {
          message = await render(pipe, sub, settings);
        } catch (error) {
          // listmonk logs a render error and moves on; the subscriber is not retried.
          log(`error rendering message (${c.name}) (${sub.email}): ${errorText(error)}`);
          outcomes.set(i, { status: "failed", at: clock.now().getTime() });
          continue;
        }
        // Pause on hitting the message rate.
        if ((workerCounts[w] ?? 0) >= rate) {
          await sleep(1000);
          workerCounts[w] = 0;
        }
        workerCounts[w] = (workerCounts[w] ?? 0) + 1;
        // The sliding window holds every worker until the window is over.
        while (slidingUntil > clock.now().getTime() && !stopping.signal.aborted)
          await sleep(slidingUntil - clock.now().getTime());
        if (stopped()) return;
        // Consent is rechecked at the push: an unsubscribe or blocklist during the batch holds.
        if (!deps.recipients.eligible(audience(c), sub.id)) {
          outcomes.set(i, { status: "skipped", at: clock.now().getTime() });
          continue;
        }
        pushed.add(i);
        const dispatch = deps.emailer.push(message, { copies: false });
        if (sliding) {
          const nowMs = clock.now().getTime();
          if (nowMs - slidingStart >= windowMs) {
            slidingStart = nowMs;
            slidingCount = 0;
          }
          slidingCount++;
          if (slidingCount >= settings.slidingWindowRate) {
            slidingCount = 0;
            slidingUntil = slidingStart + windowMs;
          }
        }
        let outcome: Outcome;
        try {
          outcome = await dispatch.result;
        } catch {
          outcome = {
            messageId: "",
            status: "ambiguous",
            stage: "unknown",
            accepted: [],
            rejected: [],
          };
        }
        const at = clock.now().getTime();
        if (outcome.status === "accepted" && outcome.rejected.length === 0) {
          sent++;
          outcomes.set(i, { status: "sent", at });
          continue;
        }
        // No automatic retry: a proven rejection fails, anything uncertain is unknown (D24).
        outcomes.set(i, { status: outcome.status === "ambiguous" ? "unknown" : "failed", at });
        log(
          `error sending message in campaign ${c.name}: subscriber ${sub.id}: ${outcome.status} at ${outcome.stage}`,
        );
        // OnError: pause the campaign when the error threshold is met.
        if (settings.maxSendErrors >= 1 && ++pipe.errors >= settings.maxSendErrors && !stop) {
          stop = "errors";
          log(`error count exceeded ${settings.maxSendErrors}. pausing campaign ${c.name}`);
        }
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, recipients.length) }, (_, w) => worker(w)),
      );
    } finally {
      heartbeat.abort();
      await beating;
    }
    // Progress for the batch: sent count, outcomes, and the unsent rest returned to the cursor.
    const now = iso(clock.now().getTime());
    const unsent = recipients.filter((_, i) => !pushed.has(i) && !outcomes.has(i));
    writeTransaction(db, () => {
      store.addSent(c.id, sent, now);
      for (const [i, outcome] of outcomes)
        store.settle(c.id, recipients[i]!.id, outcome.status, iso(outcome.at));
      if (unsent.length) {
        for (const sub of unsent) store.unclaim(c.id, sub.id);
        store.rewind(c.id, token, unsent[0]!.id - 1n, now);
      }
      if (stop === "errors") {
        store.pause(c.id, now);
        release(pipe);
      } else if (stop === "status") release(pipe);
    });
  }

  const loop = startLoop<Batch>({
    db,
    clock,
    logger: deps.logger,
    intervalMs: deps.scanIntervalMs ?? scanInterval,
    leaseMs,
    batchSize: 1,
    signal: stopping.signal,
    claim: (now) => claim(now),
    async process(batch) {
      try {
        await process(batch);
      } catch (error) {
        // The claims stay in place: the batch is skipped, never resent.
        deps.logger.error(error);
        pipes.delete(batch.pipe.campaign.id);
        try {
          store.release(batch.pipe.campaign.id, token);
        } catch {
          /* The lease expires. */
        }
      }
    },
  });

  return {
    done: loop.done,
    wake: () => loop.wake(),
    /** Stops claims, lets the batch in flight finish, then releases every lease. */
    async stop(): Promise<void> {
      stopping.abort();
      try {
        await loop.done;
      } finally {
        if (pipes.size)
          writeTransaction(db, () => {
            for (const pipe of pipes.values()) release(pipe);
          });
      }
    },
  };
}
export type CampaignRunner = ReturnType<typeof startCampaignRunner>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
