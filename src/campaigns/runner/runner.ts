// Campaign runner adapted from listmonk internal/manager/manager.go (Run, scanCampaigns,
// worker), internal/manager/pipe.go (NextSubscribers, OnError, cleanup) and
// internal/manager/message.go at 6fcd95f, on the M0.4 loop helper. One batch per project is in
// flight at a time. A batch is reserved before it is claimed (B141, 14-projects section 7): the
// runner asks the dispatcher for slots, claims at most that many recipients, and its cursor and
// per-subscriber claims commit before any of it is sent, so a crash can skip at most the granted
// batch and never sends a subscriber the campaign twice (docs/design/04-sending.md#campaigns).
// listmonk's per-campaign pacing (app.concurrency, app.message_rate, the sliding window) is gone:
// the dispatcher paces every send.
import type { Database } from "bun:sqlite";
import type { ErrorLogger } from "@/app";
import type { Clock } from "@/clock";
import { writeTransaction } from "@/db/transaction";
import { must } from "@/invariant";
import { createLoop } from "@/loops/loop";
import { sendingHeld } from "@/settings/hold";
import type { ListReferences } from "@/lists/references";
import type { SafeMessage } from "@/maintenance/log-buffer";
import type { EmbedImages, InlineImage } from "@/media/embed";
import type { Message, Outcome } from "@/messaging/email";
import type { Grant, Sender } from "@/messaging/dispatcher";
import { plainText } from "@/messaging/plain";
import type { AdminNotifier } from "@/messaging/notify";
import type { BrandSite } from "@/public/brand";
import type { SubscriberRow } from "@/sources/recipient-sync";
import type { SendTimeLookup, SendTimePlan } from "@/sources/send-time";
import { isPermanent, isSourceError } from "@/sources/source";
import { isSettingsMismatch } from "@/sources/stream-record";
import type { CampaignRecipient, CampaignRecipients } from "@/subscribers/campaign-recipients";
import { createMessageBudget, RenderCapacityError } from "@/templates/renderer";
import type { TemplateRenderer } from "@/templates/renderer";
import type { Tracking } from "@/unsubscribe/tracking";
import { campaignHeaders, compileCampaign, dummyUUID } from "@/campaigns/render";
import type { CampaignStore } from "@/campaigns/store";
import type { DeliveryStatus, RunnableCampaign, RunnerStore } from "@/campaigns/runner/store";

export interface RunnerSettings {
  maxSendErrors: number;
  rootUrl: string;
  /** The site's brand, which a campaign template reads (B129, D127). */
  brand: BrandSite;
  /** "email" and the names of enabled SMTP servers. */
  messengers: Array<string>;
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
  /** This project's side of the instance dispatcher: grants, and pushes in their slots. */
  sender: Pick<Sender, "push" | "request" | "closed">;
  settings: () => RunnerSettings;
  /** Reads a campaign's files, so never inside the claim transaction. */
  attachments(ids: Array<bigint>, inline: Array<InlineImage>): Promise<Attachments>;
  embedImages: EmbedImages;
  /**
   * Campaigns with a live pipe in this process. Runners sharing a data directory share it
   * (D15: one process per data directory), so no campaign gets a second pipe while one
   * lives, even after the first pipe's lease expired during a stall.
   */
  registry?: CampaignRunnerRegistry;
  /**
   * D174: source-linked recipients' fresh address and name, read per batch before render and
   * eligibility, and their leaving. None in fixtures without a source.
   */
  sendTime?: SendTimeLookup;
  /** Idle scan interval; listmonk scans every five seconds. */
  scanIntervalMs?: number;
  leaseMs?: number;
  notify?: AdminNotifier;
}

interface Pipe {
  campaign: RunnableCampaign;
  compiled: ReturnType<typeof compileCampaign>;
  /** The files of the pipe, by ID. Their bytes are loaded for each batch and kept by no pipe. */
  media: Array<bigint>;
  images: Array<InlineImage>;
  /** Why the campaign's images cannot be embedded: found when it compiles, reported as `attach`. */
  embedProblem: string | null;
  /** Tracked links seen in the current batch; campaign_links is the lasting record. */
  links: Map<string, string | null>;
  errors: number;
}
type Attachments = NonNullable<Message["attachments"]>;
interface Batch {
  pipe: Pipe;
  recipients: Array<CampaignRecipient>;
}
/**
 * Why a batch stopped early. "emailer": the sender closed under the batch, so nothing more of it
 * is pushed and the unsent recipients are handed back.
 */
type Stop = "status" | "errors" | "shutdown" | "emailer";

/**
 * The most recipients one batch asks slots for and claims (14-projects section 4). The grant caps
 * it further: at most the slots this project gets within the 2 s horizon. Chosen by measurement
 * (D155, docs/perf/projects-B141.md).
 */
export const MAX_CLAIM = 100;
const scanInterval = 5000;
const defaultLease = 30_000;
/** Bound on the per-batch tracked link cache: personalized URLs are distinct per recipient. */
const maxCachedLinks = 10_000;
/** D174: recipients-view reads of one batch in flight at once (docs/perf/B150e-send.md). */
export const SOURCE_LOOKUPS = 8;
/**
 * D174: after a source outage rewinds a batch, the campaign waits this long before its next batch,
 * doubling per failed batch up to the cap; a batch whose reads succeed resets it.
 */
const SOURCE_WAIT_MS = 5000;
const SOURCE_WAIT_MAX_MS = 5 * 60_000;
/**
 * Why a claimed delivery was skipped at its push (B116, D131): the same reasons a send row
 * skipped for the same condition carries.
 */
const SKIP_REASON = {
  changed: "subscriber_unavailable",
  unavailable: "subscriber_unavailable",
  blocklisted: "subscriber_blocklisted",
  unsubscribed: "unsubscribed",
  membership_changed: "membership_changed",
} as const;
/** D174: a recipient the send-time lookup skips, with why; `message` is logged when not empty. */
interface SourceSkip {
  reason: (typeof SKIP_REASON)[keyof typeof SKIP_REASON];
  message: string;
}

/** In-process owners of live campaign pipes. */
export function createCampaignRunnerRegistry() {
  const owners = new Map<bigint, string>();
  return {
    /** Takes the campaign for `token`; false while another runner's pipe holds it. */
    take(id: bigint, token: string): boolean {
      const owner = owners.get(id);
      if (owner !== undefined && owner !== token) {
        return false;
      }
      owners.set(id, token);
      return true;
    },
    drop(id: bigint, token: string): void {
      if (owners.get(id) === token) {
        owners.delete(id);
      }
    },
  };
}
export type CampaignRunnerRegistry = ReturnType<typeof createCampaignRunnerRegistry>;

/** Create and start, for callers that claim at once. The server creates, then starts (B52). */
export function startCampaignRunner(deps: RunnerDeps) {
  const runner = createCampaignRunner(deps);
  runner.start();
  return runner;
}

const iso = (ms: number) => new Date(ms).toISOString();
const label = (c: RunnableCampaign) => `campaign ${c.id} (${c.name})`;
/** Creates the runner without starting it: no orphan is recovered and nothing is claimed yet. */
export function createCampaignRunner(deps: RunnerDeps) {
  const { db, clock, store } = deps;
  const leaseMs = deps.leaseMs ?? defaultLease;
  const token = crypto.randomUUID();
  const registry = deps.registry ?? createCampaignRunnerRegistry();
  const pipes = new Map<bigint, Pipe>();
  /** Campaigns whose setup failed are retried at the next scan, as listmonk does. */
  const retryAt = new Map<bigint, number>();
  /** D174: batches handed back in a row per campaign while its source could not be read. */
  const sourceWaits = new Map<bigint, number>();
  let rotation = 0;
  const stopping = new AbortController();

  const log = (safe: SafeMessage, message: string) => deps.logger.attention(message, safe);

  const pendingNotifications: Array<{
    campaign: { id: bigint; name: string; status: string; sent: number; to_send: number };
    reason?: string;
  }> = [];

  function flushNotifications() {
    if (!deps.notify || pendingNotifications.length === 0) {
      return;
    }
    const batch = pendingNotifications.splice(0, pendingNotifications.length);
    for (const item of batch) {
      const current = store.state(item.campaign.id);
      if (current?.status !== item.campaign.status) {
        continue;
      }
      try {
        deps.notify.campaignStatus(item.campaign, item.reason);
      } catch (error) {
        deps.logger.error(error);
      }
    }
  }

  function enqueueNotification(item: {
    campaign: { id: bigint; name: string; status: string; sent: number; to_send: number };
    reason?: string;
  }) {
    if (!deps.notify) {
      return;
    }
    pendingNotifications.push(item);
    queueMicrotask(flushNotifications);
  }

  /** Ends the pipe. Its batch has drained: nothing it pushed is still outstanding. */
  function drop(id: bigint) {
    pipes.delete(id);
    registry.drop(id, token);
  }
  function release(pipe: Pipe) {
    drop(pipe.campaign.id);
    store.release(pipe.campaign.id, token);
  }
  function audience(c: RunnableCampaign) {
    const lists = [];
    for (const id of store.listIds(c.id)) {
      const list = deps.lists.subscriberMetadata(id);
      if (list) {
        lists.push({ id, optin: list.optin });
      }
    }
    return { lists, type: c.type ?? "regular" };
  }
  function templateBody(c: RunnableCampaign) {
    // next-campaigns: the campaign's template body, else the default template's.
    const own = c.template_id === null ? null : deps.templates.get(c.template_id);
    return own?.body ?? deps.templates.getDefault()?.body ?? "";
  }

  /** Marks claims no live pipe owns as unknown and logs their range, so they stop holding the cap. */
  function abandonClaims(id: bigint, now: number, name: string) {
    const abandoned = store.abandon(id, iso(now));
    if (abandoned.count) {
      log(
        "campaign claims abandoned after the runner stopped: resend manually if needed",
        `${name}: ${abandoned.count} subscribers with IDs ${abandoned.first}-${abandoned.last} ` +
          "were claimed before the runner stopped and may not have received the campaign. " +
          "They are not sent again; resend to them manually if needed.",
      );
    }
  }
  /**
   * One process per data directory (D15): at startup, claims that no pipe in this process owns
   * were left by a stopped runner. A cancelled or paused campaign never reopens, so they are
   * recovered here rather than only when their campaign is picked up again.
   */
  function recoverOrphans() {
    const now = clock.now().getTime();
    writeTransaction(db, () => {
      for (const { id, name } of store.claimedCampaigns()) {
        if (!registry.take(id, token)) {
          continue;
        }
        try {
          abandonClaims(id, now, `campaign ${id} (${name})`);
        } finally {
          registry.drop(id, token);
        }
      }
    });
  }

  /** newPipe and next-campaigns' pickup, inside the claim transaction. */
  function open(id: bigint, now: number, settings: RunnerSettings): void {
    // A pipe still alive in this process, even one whose lease lapsed, keeps the campaign.
    if (!registry.take(id, token)) {
      return;
    }
    try {
      openPipe(id, now, settings);
    } finally {
      if (!pipes.has(id)) {
        registry.drop(id, token);
      }
    }
  }
  function openPipe(id: bigint, now: number, settings: RunnerSettings): void {
    const campaign = store.acquire(id, token, iso(now + leaseMs), iso(now));
    if (!campaign) {
      return;
    }
    abandonClaims(id, now, label(campaign));
    if (!settings.messengers.includes(campaign.messenger)) {
      store.cancel(id, iso(now));
      store.release(id, token);
      log(
        "unknown messenger on campaign: campaign cancelled",
        `unknown messenger ${campaign.messenger} on ${label(campaign)}`,
      );
      return;
    }
    let compiled;
    let embedded;
    try {
      embedded = deps.embedImages({
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
      compiled = compileCampaign(deps.renderer, embedded.campaign);
    } catch (error) {
      store.release(id, token);
      retryAt.set(id, now + (deps.scanIntervalMs ?? scanInterval));
      log("error processing campaign", `error processing ${label(campaign)}: ${errorText(error)}`);
      return;
    }
    const measured = deps.recipients.measure(audience(campaign));
    if (measured.count === 0n) {
      // No recipients. listmonk finishes such a campaign on a scan after its start, never on the
      // wake that started it (D120): the first visit leaves it running for one scan interval.
      if (!retryAt.has(id)) {
        store.release(id, token);
        retryAt.set(id, now + (deps.scanIntervalMs ?? scanInterval));
        return;
      }
      retryAt.delete(id);
      store.finish(id, iso(now));
      store.release(id, token);
      const counts = store.counts(id);
      enqueueNotification({
        campaign: {
          id,
          name: campaign.name,
          status: "finished",
          sent: counts ? Number(counts.sent) : 0,
          to_send: counts ? Number(counts.to_send) : 0,
        },
      });
      return;
    }
    const started = store.start(id, token, measured.count, measured.max, iso(now));
    if (!started) {
      return;
    }
    retryAt.delete(id);
    pipes.set(id, {
      // The scheduled -> running flip bumped the generation (a trigger, so RETURNING cannot
      // show it): the pipe opens at the current one.
      campaign: {
        ...campaign,
        runner_generation: must(store.state(id), "campaign state").runner_generation,
      },
      compiled,
      media: store.mediaIds(id),
      images: embedded.images,
      embedProblem: embedded.problem,
      links: new Map(),
      errors: 0,
    });
  }

  /**
   * NextSubscribers: claims the next batch of at most `limit` (the granted slots) and commits its
   * cursor, or ends the pipe. The cursor advances only over the recipients read for the grant.
   */
  function next(pipe: Pipe, now: number, limit: number): Batch | null {
    const id = pipe.campaign.id;
    const state = store.state(id);
    if (!state || state.runner_lease !== token) {
      drop(id);
      return null;
    }
    if (state.status !== "running" || state.runner_generation !== pipe.campaign.runner_generation) {
      // Paused or cancelled between batches, even if resumed since (cleanup for a stopped
      // pipe). A resumed campaign reopens with its current content, lists and audience.
      release(pipe);
      return null;
    }
    const found = deps.recipients.next(
      audience(pipe.campaign),
      state.last_subscriber_id,
      state.max_subscriber_id,
      limit,
    );
    if (!found.length) {
      // Subscribers are exhausted: the campaign is finished.
      store.finish(id, iso(now));
      release(pipe);
      const counts = store.counts(id);
      enqueueNotification({
        campaign: {
          id,
          name: pipe.campaign.name,
          status: "finished",
          sent: counts ? Number(counts.sent) : 0,
          to_send: counts ? Number(counts.to_send) : 0,
        },
      });
      return null;
    }
    const at = iso(now);
    const recipients = found.filter((sub) => store.claim(id, sub.id, at));
    if (!store.advance(id, token, must(found.at(-1), "last recipient").id, at)) {
      // The lease passed to another holder during this step: write nothing more.
      drop(id);
      return null;
    }
    store.renew(id, token, iso(now + leaseMs));
    return { pipe, recipients };
  }

  /** Held (D67) or closed: nothing is opened or claimed, so no batch is handed back and claimed again. */
  const idle = () => sendingHeld(db) || deps.sender.closed;
  /**
   * The loop's claim, inside its transaction: opens the due campaigns, and asks for a batch while a
   * pipe is open. No recipient is claimed here: that waits for the grant.
   */
  function scan(nowDate: Date): Array<true> {
    if (idle()) {
      return [];
    }
    const now = nowDate.getTime();
    const settings = deps.settings();
    const due = store.due(iso(now));
    // D174: a campaign paused, cancelled or finished while it waited for its source starts a later
    // outage afresh (an attention line, the first wait), and a resume does not wait out the old one.
    for (const id of sourceWaits.keys()) {
      if (!pipes.has(id) && !due.includes(id)) {
        sourceWaits.delete(id);
        retryAt.delete(id);
      }
    }
    for (const id of due) {
      if (pipes.has(id) || (retryAt.get(id) ?? 0) > now) {
        continue;
      }
      open(id, now, settings);
    }
    return pipes.size ? [true] : [];
  }
  /** Claims a batch of at most the granted slots from the next pipe in rotation. */
  function claimBatch(limit: number): Batch | null {
    if (idle()) {
      return null;
    }
    const now = clock.now().getTime();
    while (pipes.size) {
      const all = [...pipes.values()];
      const pipe = must(all[rotation++ % all.length], "pipe");
      const batch = next(pipe, now, limit);
      if (batch) {
        return batch;
      }
    }
    return null;
  }

  function renewAll() {
    const until = iso(clock.now().getTime() + leaseMs);
    writeTransaction(db, () => {
      for (const id of pipes.keys()) {
        store.renew(id, token, until);
      }
    });
  }

  /** Renews every pipe's lease a third of the way through it until the returned stop is awaited. */
  function heartbeat(): () => Promise<void> {
    const beat = new AbortController();
    const beating = (async () => {
      while (!beat.signal.aborted) {
        try {
          await clock.sleep(Math.max(1, Math.floor(leaseMs / 3)), beat.signal);
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
    return async () => {
      beat.abort();
      await beating;
    };
  }

  async function sleep(ms: number) {
    if (ms <= 0) {
      return;
    }
    try {
      await clock.sleep(ms, stopping.signal);
    } catch {
      /* Stopping. */
    }
  }

  async function render(
    pipe: Pipe,
    sub: CampaignRecipient,
    settings: RunnerSettings,
    attachments: Attachments,
  ) {
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
              if (pipe.links.size >= maxCachedLinks) {
                pipe.links.clear();
              }
              uuid = deps.tracking.link(url);
              const link = uuid === null ? null : deps.tracking.get(uuid);
              // The campaign redirect follows only links this campaign registered.
              if (link) {
                deps.campaigns.registerLink(c.id, link.id);
              }
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
        const budget = createMessageBudget();
        const out = pipe.compiled.render(
          subscriber,
          {
            rootUrl: root,
            unsubscribeUrl,
            brand: settings.brand,
            ...(tracking ? { tracking } : {}),
          },
          budget,
        );
        // An HTML campaign without a stored altbody gets a generated text part (B120, D118); none
        // when the HTML has no text.
        const altBody =
          out.altBody ??
          (c.content_type === "plain" ? null : (await plainText(out.body, budget)) || null);
        const headers = campaignHeaders(
          {
            campaignUuid: c.uuid,
            subscriberUuid: sub.uuid,
            unsubscribeUrl: settings.unsubscribeHeader ? unsubscribeUrl : null,
          },
          out.headers,
        );
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
          ...(altBody !== null ? { altBody: Buffer.from(altBody) } : {}),
          headers,
          ...(attachments.length ? { attachments } : {}),
          messenger: c.messenger,
          messageId: `<${c.uuid}.${sub.uuid}@${domain}>`,
        };
        return message;
      } catch (error) {
        // Other renders hold the shared capacity: wait briefly; nothing has been sent.
        if (!(error instanceof RenderCapacityError) || attempt >= 50 || stopping.signal.aborted) {
          throw error;
        }
        await sleep(20);
      }
    }
  }

  /**
   * attachMedia, for one batch. A campaign does not go out without its files, and a missing file
   * does not come back by itself, so this pauses the campaign rather than retrying each scan as
   * listmonk does. Nothing of the batch was pushed: every claim returns to the cursor for the
   * resume. A crash before that leaves the batch claimed, so it is skipped as unknown.
   */
  async function attach(batch: Batch): Promise<Attachments | null> {
    const c = batch.pipe.campaign;
    try {
      if (batch.pipe.embedProblem) {
        throw new Error(batch.pipe.embedProblem);
      }
      return await deps.attachments(batch.pipe.media, batch.pipe.images);
    } catch (error) {
      log(
        "error fetching campaign attachments: campaign paused",
        `error fetching attachments on ${label(c)}: ${errorText(error)}. Pausing the campaign.`,
      );
    }
    handBack(batch, true);
    return null;
  }

  /**
   * Hands a batch none of which was pushed back to the cursor: every claim is removed, the cursor
   * rewinds to before its first recipient, and the pipe ends, paused or not. A crash before this
   * commits leaves the batch claimed, so it is skipped as unknown, never sent twice.
   */
  function handBack({ pipe, recipients }: Batch, pause: boolean) {
    const c = pipe.campaign;
    const now = iso(clock.now().getTime());
    writeTransaction(db, () => {
      for (const sub of recipients) {
        store.unclaim(c.id, token, sub.id);
      }
      if (recipients.length) {
        store.rewind(c.id, token, must(recipients[0], "first recipient").id - 1n, now);
      }
      if (pause) {
        store.pause(c.id, token, c.runner_generation, now);
      }
      release(pipe);
    });
  }

  /**
   * D174 (15-external-sources section 7): the batch's source-linked recipients (an `external_id`
   * while the project has a source) with the source's current address and name, read before any
   * of the batch renders or is checked for eligibility. Every read runs first, with no transaction
   * open (at most `SOURCE_LOOKUPS` at once); then each change is written through the record
   * handler's conflict path in its own short transaction, and the batch's copy takes the new
   * address and name. A user the recipients view no longer has is leaving: removed (enrollments
   * ended, a withdrawn consent kept as a suppression) and skipped. Returns the recipients to skip
   * (by index) with why, or null when the batch was handed back:
   * - a transient failure (an outage, or a subscriber changed by another write meanwhile) hands the
   *   whole batch back before anything of it is pushed, and the campaign waits (`SOURCE_WAIT_MS`,
   *   doubling) with its status unchanged: no message was handed to the emailer, so the batch is
   *   claimed again and sent once (marketing at-most-once);
   * - a recipients view the source refuses (`SettingsMismatch`) hands it back and pauses the
   *   campaign, which needs the settings fixed and a resume;
   * - a permanent failure of one recipient (no valid address, two users with one address, a
   *   blocked domain), from its reads or from its write's re-check of the domain policy, skips
   *   that recipient only.
   */
  async function fresh(batch: Batch): Promise<Map<number, SourceSkip> | null> {
    const skip = new Map<number, SourceSkip>();
    const lookup = deps.sendTime;
    const { pipe, recipients } = batch;
    const c = pipe.campaign;
    const linked = recipients.flatMap((sub, i) => (sub.external_id === null ? [] : [i]));
    if (!lookup || !linked.length || !lookup.configured()) {
      return skip;
    }
    const plans: Array<[number, SendTimePlan]> = [];
    /** The batch's copy of recipient `i` takes the subscriber row as the lookup found or wrote it. */
    const adopt = (i: number, row: SubscriberRow) => {
      recipients[i] = {
        id: row.id,
        uuid: row.uuid,
        email: row.email,
        name: row.name,
        attribs: row.attribs,
        external_id: row.external_id,
      };
    };
    let failure: { error: unknown } | null = null;
    let cursor = 0;
    const reader = async () => {
      while (!failure) {
        const i = linked[cursor++];
        if (i === undefined) {
          return;
        }
        const sub = must(recipients[i], "recipient");
        try {
          const planned = await lookup.read(
            sub.id,
            must(sub.external_id, "external ID"),
            stopping.signal,
          );
          if (planned) {
            plans.push([i, planned]);
          }
        } catch (error) {
          if (isPermanent(error) && !isSettingsMismatch(error)) {
            skip.set(i, { reason: SKIP_REASON.unavailable, message: error.message });
          } else {
            failure ??= { error };
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SOURCE_LOOKUPS, linked.length) }, reader));
    if (!failure) {
      try {
        for (const [i, planned] of plans) {
          const { plan } = planned;
          if (planned.unchanged && plan.kind === "present" && plan.current) {
            // B166 (D194): nothing to write, but the row the reads verified may be newer than the
            // claim (the stream or a sequence step wrote it since): the batch takes it, so the
            // push's identity check and the render see the row as it is.
            adopt(i, plan.current);
          } else if (!planned.unchanged) {
            let result: ReturnType<typeof lookup.apply>;
            try {
              result = lookup.apply(planned);
            } catch (error) {
              // B159a (D182): the write's own re-check refused this recipient (a domain
              // blocklisted since the reads, D179). Its transaction rolled back; the source is up,
              // so this recipient is skipped as the read path skips it, and the batch goes on.
              if (isPermanent(error) && !isSettingsMismatch(error)) {
                skip.set(i, { reason: SKIP_REASON.unavailable, message: error.message });
                continue;
              }
              throw error;
            }
            if (result.kind === "left") {
              skip.set(i, { reason: SKIP_REASON.unavailable, message: "" });
              continue;
            }
            adopt(i, result.row);
          }
          // The view's opt-out field set: the user declined marketing, which a campaign is.
          // Skipped as unsubscribed, with no membership change (the source owns the flag).
          if (planned.plan.kind === "present" && planned.plan.recipient.optOut) {
            skip.set(i, { reason: SKIP_REASON.unsubscribed, message: "" });
          }
        }
      } catch (error) {
        failure = { error };
      }
    }
    if (failure) {
      const { error } = failure;
      if (stopping.signal.aborted) {
        handBack(batch, false);
        return null;
      }
      if (!isSourceError(error)) {
        throw error;
      }
      if (isSettingsMismatch(error)) {
        log(
          "campaign paused: the source refused a recipient read",
          `${label(c)}: the source refused a recipient read (${error.message}). Pausing the ` +
            "campaign: fix the source settings, then resume it.",
        );
        handBack(batch, true);
        return null;
      }
      const waited = sourceWaits.get(c.id) ?? 0;
      if (waited === 0) {
        log(
          "campaign waiting for its source: batch handed back",
          `${label(c)}: the source could not be read (${error.message}). The batch was handed ` +
            "back unsent; the campaign retries it when the source answers.",
        );
      }
      sourceWaits.set(c.id, waited + 1);
      handBack(batch, false);
      retryAt.set(
        c.id,
        clock.now().getTime() +
          Math.min(SOURCE_WAIT_MAX_MS, SOURCE_WAIT_MS * 2 ** Math.min(waited, 16)),
      );
      return null;
    }
    sourceWaits.delete(c.id);
    for (const [i, { message }] of skip) {
      if (message) {
        log(
          "campaign recipient skipped: the source has no usable address",
          `${label(c)}: subscriber ${must(recipients[i], "recipient").id} skipped: ${message}`,
        );
      }
    }
    return skip;
  }

  /**
   * The campaign's message workers for one batch (Manager.worker and pipe flow): one per recipient,
   * each pushing in a slot of the batch's grant, so the dispatcher alone sets the pace.
   */
  async function process(batch: Batch, grant: Grant): Promise<void> {
    const { pipe, recipients } = batch;
    const c = pipe.campaign;
    // The reads can wait on a slow source: the lease is renewed meanwhile.
    const stopReading = heartbeat();
    let skip: Map<number, SourceSkip> | null;
    try {
      skip = await fresh(batch);
    } finally {
      await stopReading();
    }
    if (!skip) {
      return;
    }
    const attachments = await attach(batch);
    if (!attachments) {
      return;
    }
    const settings = deps.settings();
    /** A recipient that will not be pushed returns its slot at once. */
    const unused = () => grant.keep(grant.count - 1);
    pipe.links.clear();
    const outcomes = new Map<number, { status: DeliveryStatus; at: number; reason?: string }>();
    const pushed = new Set<number>();
    let stop: Stop | null = null;
    let sent = 0;
    let index = 0;
    /**
     * Ends the batch: nothing more of it is pushed, and its pushes still waiting for their slots
     * end not-started, so their recipients return to the cursor with the rest.
     */
    const halt = (reason: Stop) => {
      stop ??= reason;
      grant.release();
    };
    const stopped = (): boolean => {
      if (stop) {
        return true;
      }
      if (stopping.signal.aborted) {
        halt("shutdown");
      } else {
        const state = store.state(c.id);
        if (
          !state ||
          state.status !== "running" ||
          state.runner_lease !== token ||
          state.runner_generation !== c.runner_generation
        ) {
          halt("status");
        }
      }
      return stop !== null;
    };
    const stopBeating = heartbeat();
    const worker = async () => {
      while (!stopped()) {
        const i = index++;
        if (i >= recipients.length) {
          return;
        }
        const sub = must(recipients[i], "recipient");
        const skipped = skip.get(i);
        if (skipped) {
          // D174: the source has no usable address for it, the user left (and the subscriber
          // with it), or the user opted out of marketing. Nothing is rendered or pushed.
          outcomes.set(i, {
            status: "skipped",
            at: clock.now().getTime(),
            reason: skipped.reason,
          });
          unused();
          continue;
        }
        let message: Message;
        try {
          message = await render(pipe, sub, settings, attachments);
        } catch (error) {
          // listmonk logs a render error and moves on; the subscriber is not retried.
          log(
            "error rendering campaign message",
            `error rendering message (${c.name}) (${sub.email}): ${errorText(error)}`,
          );
          outcomes.set(i, { status: "failed", at: clock.now().getTime() });
          unused();
          continue;
        }
        if (stopped()) {
          return;
        }
        // Consent is rechecked at the push: an unsubscribe or blocklist during the batch holds.
        // The message was rendered for the captured address: a changed one is not sent.
        const current = deps.recipients.eligible(audience(c), sub);
        if (current !== "eligible") {
          if (current === "changed") {
            log(
              "campaign subscriber changed after its claim: message not sent",
              `${label(c)}: subscriber ${sub.id} changed its UUID or email after the batch was ` +
                "claimed; the message was not sent. Resend to them manually if needed.",
            );
          }
          // B116 (D131): the delivery names why it was skipped. Only the changed-identity case logs
          // above; the other reasons log nothing, since a membership or block change is not a fault.
          outcomes.set(i, {
            status: "skipped",
            at: clock.now().getTime(),
            reason: SKIP_REASON[current],
          });
          unused();
          continue;
        }
        pushed.add(i);
        // The message starts in its granted slot; it waits for no other token (no double pacing).
        let outcome: Outcome;
        try {
          outcome = await deps.sender.push(message, { copies: false, grant }).result;
        } catch {
          outcome = {
            messageId: "",
            status: "ambiguous",
            stage: "unknown",
            accepted: [],
            rejected: [],
          };
        }
        if (outcome.stage === "not-started") {
          // The message never reached a pool (the batch halted, or the sender closed): it is not
          // failed, and no later recipient of this batch is pushed.
          pushed.delete(i);
          halt("emailer");
          return;
        }
        const at = clock.now().getTime();
        if (outcome.status === "accepted" && outcome.rejected.length === 0) {
          sent++;
          outcomes.set(i, { status: "sent", at });
          continue;
        }
        // No automatic retry: a proven rejection fails, anything uncertain is unknown (D24).
        outcomes.set(i, {
          status: outcome.status === "ambiguous" ? "unknown" : "failed",
          at,
        });
        log(
          "error sending campaign message",
          `error sending message in campaign ${c.name}: subscriber ${sub.id}: ${outcome.status} at ${outcome.stage}`,
        );
        // OnError: pause the campaign when the error threshold is met.
        if (settings.maxSendErrors >= 1 && ++pipe.errors >= settings.maxSendErrors && !stop) {
          halt("errors");
          log(
            "error count limit reached: campaign paused",
            `error count exceeded ${settings.maxSendErrors}. pausing campaign ${c.name}`,
          );
        }
      }
    };
    let failure: PromiseRejectedResult | undefined;
    try {
      // Every worker settles before the pipe can end: none leaves a push outstanding.
      const settled = await Promise.allSettled(Array.from(recipients, () => worker()));
      failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    } finally {
      await stopBeating();
      pipe.links.clear();
    }
    if (failure) {
      throw failure.reason;
    }
    // Progress for the batch: sent count, outcomes, and the unsent rest returned to the cursor.
    const now = iso(clock.now().getTime());
    const unsent = recipients.filter((_, i) => !pushed.has(i) && !outcomes.has(i));
    let paused = false;
    writeTransaction(db, () => {
      // A runner whose lease has passed to another holder writes nothing and drops the pipe.
      if (store.state(c.id)?.runner_lease !== token || !store.addSent(c.id, token, sent, now)) {
        drop(c.id);
        return;
      }
      for (const [i, outcome] of outcomes) {
        store.settle(
          c.id,
          token,
          must(recipients[i], "recipient").id,
          outcome.status,
          iso(outcome.at),
          outcome.reason ?? null,
        );
      }
      if (unsent.length) {
        for (const sub of unsent) {
          store.unclaim(c.id, token, sub.id);
        }
        store.rewind(c.id, token, must(unsent[0], "first unsent recipient").id - 1n, now);
      }
      if (stop === "errors") {
        paused = store.pause(c.id, token, c.runner_generation, now);
        release(pipe);
      } else if (stop === "status") {
        release(pipe);
      }
    });
    if (paused) {
      try {
        const counts = store.counts(c.id);
        deps.notify?.campaignStatus(
          {
            id: c.id,
            name: c.name,
            status: "paused",
            sent: counts ? Number(counts.sent) : 0,
            to_send: counts ? Number(counts.to_send) : 0,
          },
          "Too many errors",
        );
      } catch (error) {
        deps.logger.error(error);
      }
    }
  }

  /** One batch: ask for slots (no transaction open), claim at most that many, send in them. */
  async function batch(): Promise<void> {
    let grant: Grant;
    // A wait for slots can be long (a backlog of marketing work, or B145's guard): the campaigns
    // stay running with their leases renewed, and their cursors do not move.
    const stopBeating = heartbeat();
    try {
      grant = await deps.sender.request("campaign", MAX_CLAIM, stopping.signal);
    } catch {
      return;
    } finally {
      await stopBeating();
    }
    let claimed: Batch | null = null;
    try {
      claimed = writeTransaction(db, () => claimBatch(grant.count));
      if (!claimed) {
        return;
      }
      grant.keep(claimed.recipients.length);
      await process(claimed, grant);
    } catch (error) {
      if (!claimed) {
        throw error;
      }
      // The batch is skipped, never resent. Its workers have drained, so its claims are marked
      // unknown now instead of holding the cap until the campaign reopens.
      const { pipe } = claimed;
      deps.logger.error(error);
      drop(pipe.campaign.id);
      try {
        writeTransaction(db, () =>
          abandonClaims(pipe.campaign.id, clock.now().getTime(), label(pipe.campaign)),
        );
      } catch {
        /* Recovered at the next pickup or startup. */
      }
      try {
        store.release(pipe.campaign.id, token);
      } catch {
        /* The lease expires. */
      }
    } finally {
      grant.release();
    }
  }

  const loop = createLoop<true>({
    db,
    clock,
    logger: deps.logger,
    intervalMs: deps.scanIntervalMs ?? scanInterval,
    leaseMs,
    batchSize: 1,
    signal: stopping.signal,
    claim: (now) => scan(now),
    process: () => batch(),
  });

  return {
    done: loop.done,
    wake: () => loop.wake(),
    /**
     * A campaign's status was changed through the API (B155a, D176). Its wait for an earlier source
     * outage ends, as the scan ends it for a campaign that left the due list: a pause and resume
     * between two scans would otherwise keep it due and wait out the old backoff. A later outage
     * starts at 5 s with a new attention line. Nothing is sent twice: a waiting campaign has no batch
     * claimed.
     */
    statusChanged(id: bigint): void {
      if (sourceWaits.delete(id)) {
        retryAt.delete(id);
      }
    },
    /** Recovers the batches a previous process left, then claims. Called once, after the bind. */
    start() {
      recoverOrphans();
      loop.start();
    },
    /** Stops claims, lets the batch in flight finish, then releases every lease. */
    async stop(): Promise<void> {
      stopping.abort();
      flushNotifications();
      try {
        await loop.done;
      } finally {
        flushNotifications();
        if (pipes.size) {
          writeTransaction(db, () => {
            for (const pipe of pipes.values()) {
              release(pipe);
            }
          });
        }
      }
    },
  };
}
export type CampaignRunner = ReturnType<typeof startCampaignRunner>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
