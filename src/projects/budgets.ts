// Process-wide budgets (14-projects section 9, invariant 7; D151). Native. The instance builds each
// one once and every project's wiring takes it from here, so N projects share one budget instead of
// building N. Each project keeps its own state inside the one budget: its peers in the rate-limit
// tables are keyed by its slug, and its queries keep their own database and staging directory.
import type { Clock } from "@/clock";
import { must } from "@/invariant";
import { createAnalyticsReader, createEgressBudget, ReaderError } from "@/analytics/reader";
import type { AnalyticsReader, ReaderOptions } from "@/analytics/reader";
import { createCaptcha } from "@/captcha/captcha";
import type { Captcha, CaptchaOptions } from "@/captcha/captcha";
import type { PageSite } from "@/public/layout";
import { rateLimited } from "@/public/rate-limit";
import type { Middleware, RequestContext } from "@/server/context";
import { createQueryRunner, RunnerError } from "@/subscribers/query-runner";
import type { QueryRunner, RunnerOptions } from "@/subscribers/query-runner";
import type { ByteGate } from "@/tx/gate";
import { createAttachmentGate } from "@/tx/routes";

/** The public limits a project applies (07: public rate limits), plus the bounce webhooks' own. */
export type LimitKind = "subscribe" | "optin" | "privacy" | "unsubscribe" | "bounce";

/** One project's side of a shared limit: its own limit, its 429 page and its client address. */
/**
 * The project a shared budget is serving in this synchronous call: set right before the shared
 * object runs, and read by it before it awaits anything.
 */
interface CurrentProject<T> {
  current?: T;
}

export interface LimitHooks {
  readonly slug: string;
  limit(): number;
  page(): PageSite;
  clientAddress(context: RequestContext): string;
}

/** Peers each limit table tracks at once, across every project (07: public rate limits). */
const MAX_PEERS = 10_000;
const WINDOW_MS = 60_000;
/** Children of the subscriber query runner at once, and how long a query waits for one (D62). */
const QUERY_CHILDREN = 2;
const QUERY_ADMISSION_MS = 1000;
/** Analytics children at once, reads waiting for one and how long they wait (D62, B44). */
const ANALYTICS_CHILDREN = 2;
const ANALYTICS_QUEUE = 32;
const ANALYTICS_ADMISSION_MS = 30_000;

export interface Slots {
  /** Children running now, across every project. */
  readonly active: number;
  /**
   * Takes a slot, waiting in arrival order at most the admission time; returns its idempotent
   * release. Refused at once when the queue is full, and when `signal` aborts while waiting.
   */
  acquire(signal?: AbortSignal): Promise<() => void>;
}

export function createSlots(options: {
  concurrency: number;
  admissionMs: number;
  maxQueued: number;
  busy: () => Error;
  cancelled: () => Error;
}): Slots {
  let active = 0;
  const waiting: Array<(admitted: boolean) => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) {
      next(true);
    } else {
      active--;
    }
  };
  return {
    get active() {
      return active;
    },
    async acquire(signal) {
      if (signal?.aborted) {
        throw options.cancelled();
      }
      if (active < options.concurrency) {
        active++;
      } else {
        if (waiting.length >= options.maxQueued) {
          throw options.busy();
        }
        const admitted = await new Promise<boolean>((resolve) => {
          const settle = (value: boolean) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            resolve(value);
          };
          const leave = () => {
            const index = waiting.indexOf(settle);
            if (index !== -1) {
              waiting.splice(index, 1);
            }
            settle(false);
          };
          const abort = () => leave();
          const timer = setTimeout(leave, options.admissionMs);
          signal?.addEventListener("abort", abort, { once: true });
          waiting.push(settle);
        });
        if (!admitted) {
          throw signal?.aborted ? options.cancelled() : options.busy();
        }
      }
      let held = true;
      return () => {
        if (held) {
          held = false;
          release();
        }
      };
    },
  };
}

export type InstanceBudgets = Awaited<ReturnType<typeof createInstanceBudgets>>;

export async function createInstanceBudgets(clock: Clock) {
  /**
   * One rate-limit table per kind for the process. The table's middleware reads its limit, its page
   * and the peer through the project being checked: a project's middleware names itself, then calls
   * the shared one, which reads all three synchronously within that call (src/public/rate-limit.ts).
   */
  const tables = new Map<LimitKind, (hooks: LimitHooks) => Middleware>();
  const table = (kind: LimitKind) => {
    const found = tables.get(kind);
    if (found) {
      return found;
    }
    const state: CurrentProject<LimitHooks> = {};
    const hooks = () => must(state.current, "rate limit project");
    const shared = rateLimited(
      clock,
      {
        get limit() {
          return hooks().limit();
        },
        windowMs: WINDOW_MS,
        maxPeers: MAX_PEERS,
      },
      () => hooks().page(),
      (context) => `${hooks().slug}\n${hooks().clientAddress(context)}`,
    );
    const made = (project: LimitHooks): Middleware => {
      return (context, next) => {
        state.current = project;
        return shared(context, next);
      };
    };
    tables.set(kind, made);
    return made;
  };

  /**
   * One ALTCHA key and one replay table for the process (maxUsed bounds it across projects). The
   * hCaptcha secret is the verifying project's, read synchronously when verify starts.
   */
  const captchaState: CurrentProject<() => CaptchaOptions> = {};
  const sharedCaptcha = await createCaptcha({
    clock,
    options: () => must(captchaState.current, "captcha project")(),
  });

  const querySlots = createSlots({
    concurrency: QUERY_CHILDREN,
    admissionMs: QUERY_ADMISSION_MS,
    maxQueued: Number.POSITIVE_INFINITY,
    busy: () => new RunnerError("busy", "too many queries in progress"),
    cancelled: () => new RunnerError("busy", "too many queries in progress"),
  });
  const analyticsSlots = createSlots({
    concurrency: ANALYTICS_CHILDREN,
    admissionMs: ANALYTICS_ADMISSION_MS,
    maxQueued: ANALYTICS_QUEUE,
    busy: () => new ReaderError("busy", "too many analytics reads in progress"),
    cancelled: () => new ReaderError("cancelled", "analytics read cancelled"),
  });
  /** Bytes of finished analytics responses waiting to be written, across every project. */
  const analyticsEgress = createEgressBudget();
  const attachments: ByteGate = createAttachmentGate(clock);

  return {
    /** Bounces a minute from providers, the floor of their own budget. */
    bounceWebhookPerMinute: 6000,
    /** The tx attachment memory budget (D74, D87). */
    attachments,
    querySlots,
    analyticsSlots,
    limit(kind: LimitKind, hooks: LimitHooks): Middleware {
      return table(kind)(hooks);
    },
    captcha(options: () => CaptchaOptions): Captcha {
      return {
        challenge: (complexity) => sharedCaptcha.challenge(complexity),
        verify: (provider, value) => {
          captchaState.current = options;
          return sharedCaptcha.verify(provider, value);
        },
      };
    },
    /**
     * A project's query runner whose children also take the process's slots. The runner frees a
     * child's slot when the child exits, however slowly its output is read (D62). The project's
     * own runner keeps its database, its staging directory and its per-child limits.
     */
    queries(options: Omit<RunnerOptions, "slots">): QueryRunner {
      return createQueryRunner({ ...options, slots: querySlots });
    },
    /**
     * A project's analytics reader whose children count against the process's slots, and whose
     * finished responses count against the process's one egress budget.
     */
    analytics(options: Omit<ReaderOptions, "egress" | "egressBytes">): AnalyticsReader {
      const inner = createAnalyticsReader({ ...options, egress: analyticsEgress });
      return {
        ...inner,
        async read(method, args, signal, counted) {
          const release = await analyticsSlots.acquire(signal);
          try {
            return await inner.read(method, args, signal, counted);
          } finally {
            release();
          }
        },
        async respond(method, args, signal) {
          const release = await analyticsSlots.acquire(signal);
          try {
            return await inner.respond(method, args, signal);
          } finally {
            release();
          }
        },
      };
    },
  };
}
