// The SES notification route (B142, D156; 14-projects section 8). Adapted from the `ses` branch of
// listmonk cmd/bounce.go at 6fcd95f (BounceWebhook), which src/bounces/routes.ts served per install.
// Native: the route is the instance's, with the instance's bounce settings and topic ARNs; a notice
// is routed to the one project whose own records its Message-ID names, and each project records it in its own database.
import type { Database } from "bun:sqlite";
import type { ErrorLogger } from "@/app";
import type { BounceEvent, BounceStore } from "@/bounces/store";
import {
  SES_BODY_LIMIT,
  SNS_MAX_AGE_MS,
  createSnsClient,
  messageIdentity,
  parseSns,
  sesEvents,
  topicAllowed,
} from "@/bounces/ses";
import type { SnsClient } from "@/bounces/ses";
import type { Clock } from "@/clock";
import { writeTransaction } from "@/db/transaction";
import type { TestSendRecord } from "@/messaging/test-sends";
import type { PageSite } from "@/public/layout";
import { publicNotFound } from "@/public/message";
import type { Handler, Middleware, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";

const MAX_RECEIPT_ID = 256;
/** The path the instance answers on the instance host and on a host no project claims. */
export const SES_PATH = "/webhooks/service/ses";
/** The fixed text GET /api/logs shows for a notice no single project claims. */
export const UNMATCHED_NOTICE = "An SES notice matched no project";

/** The instance keys the route reads (B139: `bounce.*` is the instance's). */
export interface SesSettings {
  enabled: boolean;
  webhooksEnabled: boolean;
  ses: boolean;
  /** `bounce.ses_topic_arns`: empty accepts no SES message (D75). */
  sesTopics: Array<string>;
}

/** A verified notice for one project: its receipt key and expiry, and the bounces it names. */
export interface SesNotice {
  key: string;
  expiresAt: Date;
  events: Array<BounceEvent>;
  /**
   * B149b r1/r2 (D165): true once the instance has served several projects, even with one left.
   * The events act only on the subscriber their own send or delivery names: no address fallback,
   * and no subscriber a header contradicts.
   */
  ownRecord: boolean;
}

/** What the instance's route reaches of one project: narrow functions, never its database. */
export interface SesProject {
  /** Whether the Message-ID's UUIDs name one of this project's sends, campaigns or test sends. */
  claims(messageId: string): boolean;
  /** Records the notice with today's rules, deduplicated by its receipt in this project. */
  receive(notice: SesNotice): void;
}

/** One project's side: its bounce store, its database and its own log. */
export function createSesProject(deps: {
  db: Database;
  store: Pick<BounceStore, "claims" | "pruneReceipts" | "receive" | "testOf" | "record">;
  logger: ErrorLogger;
}): SesProject {
  const { db, store, logger } = deps;
  /**
   * B108 (D114): one attention line for a test send's bounce or complaint. The fixed text is what
   * GET /api/logs shows; stderr also names the kind, the IDs, the recipient and the bounce or feedback type.
   */
  const testNotice = (event: BounceEvent, test: TestSendRecord) => {
    const parsed: unknown = JSON.parse(event.meta);
    const codes = Object.fromEntries(
      new Map<string, unknown>(parsed && typeof parsed === "object" ? Object.entries(parsed) : []),
    );
    const named =
      test.kind === "campaign"
        ? `campaign ${test.campaign_id}`
        : `sequence ${test.sequence_id} step ${test.step_id}`;
    // The address is the notice's own (bouncedRecipients or complainedRecipients), not a stored one.
    const where = `kind ${test.kind}, ${named}, recipient ${event.email}`;
    if (event.type === "complaint") {
      logger.attention(
        `Test send got a complaint: ${where}, feedback ${String(codes.feedback_type ?? "unknown")}`,
        "A test send got a complaint",
      );
    } else {
      logger.attention(
        `Test send bounced: ${where}, bounce ${String(codes.bounce_type ?? "unknown")} ${String(codes.bounce_sub_type ?? "")}`.trimEnd(),
        "A test send bounced",
      );
    }
  };
  return {
    claims(messageId) {
      const identity = messageIdentity(messageId);
      return store.claims({
        sendUuid: identity.sendUuid,
        campaignUuid: identity.campaignUuid,
        subscriberUuid: identity.subscriberUuid,
        messageId,
      });
    },
    receive(notice) {
      const tests: Array<{ event: BounceEvent; test: TestSendRecord }> = [];
      writeTransaction(db, () => {
        store.pruneReceipts();
        // SNS delivers at least once: a repeated message is recorded once.
        if (!store.receive(notice.key, notice.expiresAt)) {
          return;
        }
        for (const event of notice.events) {
          const test = store.testOf(event);
          if (test) {
            tests.push({ event, test });
          } else {
            store.record(event, { ownRecord: notice.ownRecord });
          }
        }
      });
      // Named after the commit, so a line is never written for a notice that did not land.
      for (const { event, test } of tests) {
        testNotice(event, test);
      }
    },
  };
}

/** The body, up to SNS's own message limit; a larger one is refused before it is parsed. */
const readSns = async (request: Request) => {
  if (Number(request.headers.get("content-length")) > SES_BODY_LIMIT) {
    throw new HttpError(413);
  }
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) {
          break;
        }
        size += item.value.length;
        if (size > SES_BODY_LIMIT) {
          await reader.cancel();
          throw new HttpError(413);
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
};

const invalidData = (c: RequestContext) =>
  new HttpError(400, c.app.i18n.T("globals.messages.invalidData"));

/**
 * The project a notice is for (section 8): the only project of an instance that has never served
 * more than one; else the one project whose own
 * sends, campaign deliveries or test sends the Message-ID names. Its domain decides nothing: a
 * project user can choose a test send's Message-ID, and a hostname can move to another project
 * (B149b, D165). Never by address: the same address can be a subscriber in two projects. A
 * delivery's `X-Listmonk-Campaign` and `X-Listmonk-Subscriber` must name the Message-ID's own
 * UUIDs (B149b r1): a project can't route by one record and act on another subscriber. Once a
 * project is deleted, the one left gets only what its own records name (B149b r2): the deleted
 * project's late notices are no longer that project's, and its address must not match them.
 */
function routeOf(
  projects: ReadonlyArray<SesProject>,
  events: Array<BounceEvent>,
  several: boolean,
): SesProject | undefined {
  if (!several) {
    return projects[0];
  }
  const messageId = events[0]?.messageId ?? "";
  if (!messageId) {
    return undefined;
  }
  const delivery = messageIdentity(messageId);
  if (
    delivery.campaignUuid &&
    events.some(
      (event) =>
        event.campaignUuid !== delivery.campaignUuid ||
        event.subscriberUuid !== delivery.subscriberUuid,
    )
  ) {
    return undefined;
  }
  const matches = projects.filter((project) => project.claims(messageId));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * `POST /webhooks/service/ses` on `router`, the instance's (14-projects section 8). `projects` are
 * the served projects in slug order.
 */
export function registerSesRoute(
  router: Router,
  deps: {
    clock: Clock;
    settings: () => SesSettings;
    /** The branding of the public 404 when webhooks are off, and of the 429 page. */
    page: () => PageSite;
    /** The public rate limit for the provider's route. */
    limit: Middleware;
    /** SNS signature checks and confirmations; tests inject the network. */
    sns?: SnsClient;
    projects: () => ReadonlyArray<SesProject>;
    /** Whether the instance has ever served more than one project (B149b r2, D165). */
    servedSeveral: () => boolean;
    /** The instance's log: a notice no single project claims is named there. */
    logger: ErrorLogger;
  },
) {
  const { clock, settings, page, logger } = deps;
  const sns = deps.sns ?? createSnsClient({ clock });

  /** Upstream has no route at all without `bounce.webhooks_enabled`. */
  const webhooksEnabled: Middleware = (c, next) =>
    settings().webhooksEnabled ? next() : publicNotFound(c.app.i18n, c.request.method, page());

  /** cmd/bounce.go's `ses` branch. Every refusal is upstream's 400 and changes nothing. */
  const ses: Handler = async (c) => {
    const raw = await readSns(c.request);
    const type = c.request.headers.get("X-Amz-Sns-Message-Type");
    if (
      type !== "SubscriptionConfirmation" &&
      type !== "UnsubscribeConfirmation" &&
      type !== "Notification"
    ) {
      throw invalidData(c);
    }
    const message = parseSns(raw);
    // The header is not signed: it must agree with the signed type.
    if (!message || message.Type !== type || !(await sns.verify(message))) {
      throw invalidData(c);
    }
    // Anyone with an AWS account can sign a message: only the operator's topics are believed.
    if (!topicAllowed(message.TopicArn, settings().sesTopics)) {
      throw invalidData(c);
    }
    // The instance's one subscription: confirmed once, for every project.
    if (type === "SubscriptionConfirmation") {
      if (!(await sns.confirm(message))) {
        throw invalidData(c);
      }
      return ok(true);
    }
    // An unsubscription is acknowledged: the link it carries would end the subscription.
    if (type === "UnsubscribeConfirmation") {
      return ok(true);
    }
    const id = message.MessageId ?? "";
    if (!id || id.length > MAX_RECEIPT_ID) {
      throw invalidData(c);
    }
    const now = clock.now();
    const events = sesEvents(message.Message ?? "", now);
    if (!events) {
      throw invalidData(c);
    }
    const projects = deps.projects();
    const several = projects.length > 1 || deps.servedSeveral();
    const project = routeOf(projects, events, several);
    if (!project) {
      // Accepted, so SNS does not retry a notice that would match nothing again.
      logger.attention(`${UNMATCHED_NOTICE}: SNS message ${id}`, UNMATCHED_NOTICE);
      return ok(true);
    }
    // The receipt outlasts the last moment the message verifies (its Timestamp plus the age
    // limit), even when it is dated ahead.
    const sent = Math.max(now.getTime(), Date.parse(message.Timestamp ?? ""));
    project.receive({
      key: `sns:${id}`,
      expiresAt: new Date(sent + SNS_MAX_AGE_MS + 1000),
      events,
      ownRecord: several,
    });
    return ok(true);
  };
  const service: Handler = (c) => {
    if (!settings().enabled) {
      throw new HttpError(503, c.app.i18n.T("globals.messages.internalError"));
    }
    if (settings().ses) {
      return ses(c);
    }
    throw new HttpError(400, c.app.i18n.T("bounces.unknownService"));
  };
  router.route("POST", SES_PATH, service, webhooksEnabled, deps.limit);
}
