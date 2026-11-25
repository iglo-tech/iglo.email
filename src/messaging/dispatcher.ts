// The dispatcher (14-projects section 7, D155). Native: listmonk paces each campaign by itself and
// sends other mail unpaced. One instance service owns the emailer, its SMTP pools and the start
// schedule, and decides whose message starts next. Projects never build their own emailer: each gets
// a sender, which passes its project's context with every push.
//
// The schedule is one sequence of starts, one every `1000 / rate` ms (unpaced at rate 0, D92).
//
// - A transactional push claims first, then waits for the next start, ahead of every other class.
// - Marketing and campaign work reserves before it claims: a loop requests up to N slots and is
//   granted only what fits the 2 s horizon (`2 × rate` reserved, not yet started, process-wide; a
//   fixed 200 at rate 0). It claims at most that many, pushes each with its grant, and returns the
//   rest. Slots are granted marketing first, then campaign, round-robin across projects, one slot per
//   project per turn, and no project holds more than its share of the horizon while others want it.
// - Starts are served transactional, then marketing, then campaign; within a class round-robin
//   across the projects with a granted push ready.
import type { Clock } from "@/clock";
import { createEmailer, rootDomain } from "@/messaging/email";
import type {
  Dispatch,
  Message,
  Outcome,
  PushContext,
  PushDelivery,
  SMTPServer,
  StartWait,
} from "@/messaging/email";
import { must } from "@/invariant";

/** The classes that reserve before they claim, in priority order. Transactional never reserves. */
export type GrantClass = "marketing" | "campaign";
/** Every class a start belongs to, in priority order. */
export type StartClass = "transactional" | GrantClass;
const CLASSES: ReadonlyArray<GrantClass> = ["marketing", "campaign"];
/** Slots are granted only this far ahead. */
export const HORIZON_MS = 2000;
/** Reserved-but-not-settled marketing and campaign messages at rate 0 (no cap), process-wide. */
export const UNPACED_BOUND = 200;
/** The SMTP settings test waits at most this long for a start (D92), then is not sent. */
const SMTP_TEST_WAIT_MS = 10_000;
/**
 * A sender's close waits at most this long for its pushes in SMTP flight: the shutdown's bound
 * (the emailer's close), so a project delete is bounded the same way (D157).
 */
export const SENDER_CLOSE_MS = 5000;

/** Granted slots. A push with the grant uses one; `keep` and `release` return slots at once. */
export interface Grant {
  /** Slots not yet used by a push. */
  readonly count: number;
  /** Keeps the first `count` unused slots and returns the rest. */
  keep(count: number): void;
  /**
   * Returns every slot not started: the unused ones, and those whose push still waits for its start,
   * which then ends not-started (its claim is handed back). A started push is not affected.
   */
  release(): void;
}

/** One project's per-push context (14-projects section 7): its domain, blocklist and hold. */
export interface SenderContext {
  /** The project's root URL; its host names generated Message-IDs. */
  rootUrl(): string;
  /** Whether a Cc/Bcc mailbox may receive a copy: that project's blocklist. */
  copyAllowed(address: string): boolean;
  /** Throws while the project (or the instance) holds sending: its restore hold (D67). */
  refuse(): void;
}

export interface SenderDelivery {
  /** `false`: `message.to` only, no Cc/Bcc (a marketing message has one admitted recipient). */
  readonly copies?: boolean;
  /** A test send's own pool (B101). */
  readonly testPool?: boolean;
  /** Marketing and campaign messages start in a slot of their grant; without one, transactional. */
  readonly grant?: Grant;
}

/** What a project sends through: its side of the instance's one emailer. */
export interface Sender {
  /**
   * Sends `message`. With a grant it uses one of its slots (and throws when none is left); without,
   * it is transactional and takes the next start. Throws only from the hold check otherwise.
   */
  push(message: Message, delivery?: SenderDelivery): Dispatch;
  /** The SMTP settings test: a transactional start, waited for at most 10 s. */
  test(server: SMTPServer, message: Message, rootUrl: string): Dispatch;
  /**
   * Asks for up to `count` slots of `cls`. Resolves with at least one; rejects when `signal`
   * aborts or the sender stops. The caller holds no transaction while it waits.
   */
  request(cls: GrantClass, count: number, signal?: AbortSignal): Promise<Grant>;
  /** True once this sender or the dispatcher stopped: nothing new starts, loops claim nothing. */
  readonly closed: boolean;
  /**
   * Stops this project's sending: requests and unused slots go back, pushes waiting for a start
   * end not-started, and it resolves once the pushes already started have settled, or after
   * `SENDER_CLOSE_MS`. A push still in flight then settles `ambiguous` for this project (never
   * retried), as a push the shutdown cuts does; its SMTP connection is left alone, since the pools
   * are every project's. Calling it again returns the same promise.
   */
  close(): Promise<void>;
}

export interface DispatcherOptions {
  clock: Clock;
  /** The instance's SMTP servers (invariant 5). */
  smtp: () => Array<SMTPServer>;
  /**
   * The effective rate in messages per second; 0 is no cap: the lower of `messaging.max_send_rate`
   * and SES's `MaxSendRate` (B145b). Re-read on `wake`.
   */
  rate: () => number;
  /**
   * True while no marketing or campaign slot may be granted (B145b's quota guard). Transactional
   * starts are never held. Call `wake` when it turns false.
   */
  held?: () => boolean;
  /** Called at each start with its class, before the push reaches a pool: measurements count them. */
  onStart?: (cls: StartClass) => void;
  select?: (count: number) => number;
  id?: () => string;
}

interface Member {
  closed: boolean;
  /** Open requests per class, oldest first. */
  readonly requests: Record<GrantClass, Array<Request>>;
  /** Reserved slots per class: granted (to a request or a grant) and not yet started. */
  readonly slots: Record<GrantClass, Array<Slot>>;
  /** Transactional starts waiting. */
  readonly waiting: Set<Start>;
  /** Pushes not yet settled. */
  readonly inflight: Set<Promise<void>>;
  /** Settles each unsettled push `ambiguous` for this project: the close deadline. */
  readonly cut: Set<() => void>;
}
interface Start {
  readonly member: Member;
  resolve(): void;
  reject(error: Error): void;
}
interface Slot {
  readonly member: Member;
  readonly cls: GrantClass;
  /** The push waiting in this slot, once one is attached. */
  start?: Start | undefined;
}
interface Request {
  readonly member: Member;
  readonly cls: GrantClass;
  readonly want: number;
  readonly slots: Array<Slot>;
  resolve(grant: Grant): void;
  reject(error: Error): void;
  cleanup(): void;
}

const stoppedError = () => new Error("Sending stopped");

/** The slots the horizon holds at `rate`: two seconds of starts, or the fixed bound unpaced. */
export function horizonSlots(rate: number): number {
  return rate > 0 ? Math.max(1, Math.floor((rate * HORIZON_MS) / 1000)) : UNPACED_BOUND;
}

/** The spacing of starts at `rate` per second; a rate of 0 has none. */
const intervalOf = (rate: number) => (rate > 0 ? 1000 / rate : 0);

function remove<T>(list: Array<T>, item: T): boolean {
  const index = list.indexOf(item);
  if (index === -1) {
    return false;
  }
  list.splice(index, 1);
  return true;
}
/** Moves `item` to the back: its turn is taken. */
function rotate<T>(list: Array<T>, item: T) {
  if (remove(list, item)) {
    list.push(item);
  }
}

export function createDispatcher(options: DispatcherOptions) {
  const { clock } = options;
  const emailerOptions: Parameters<typeof createEmailer>[0] = { smtp: options.smtp, clock };
  if (options.select) {
    emailerOptions.select = options.select;
  }
  if (options.id) {
    emailerOptions.id = options.id;
  }
  const emailer = createEmailer(emailerOptions);
  const members: Array<Member> = [];
  /** Transactional starts waiting, in arrival order. */
  const tx: Array<Start> = [];
  /** Turn order per class: whose request is granted next, and whose ready push starts next. */
  const grantTurn: Record<GrantClass, Array<Member>> = { marketing: [], campaign: [] };
  const startTurn: Record<GrantClass, Array<Member>> = { marketing: [], campaign: [] };
  /** Granted pushes started at rate 0 and not yet settled: they count against the 200 bound. */
  const running = new Set<Slot>();
  /** Reserved slots not yet started, all members and classes. */
  let reserved = 0;
  /** The state behind each grant handed out: its unused slots and the slots its pushes took. */
  const grants = new WeakMap<Grant, { member: Member; slots: Array<Slot>; used: Array<Slot> }>();
  let stopped = false;
  let rate = options.rate();
  // The start stands in for the last start: a process has no record of the sends before it (a
  // restart), so its first send waits one interval after the start (B118a). Rate 0 waits for none.
  let lastStart = clock.now().getTime();
  let nextAt = lastStart + intervalOf(rate);
  let timer: AbortController | undefined;
  let pumping = false;

  function arm(delay: number) {
    if (timer || stopped) {
      return;
    }
    const controller = new AbortController();
    timer = controller;
    void clock.sleep(Math.max(1, Math.ceil(delay)), controller.signal).then(
      () => {
        if (timer === controller) {
          timer = undefined;
          pump();
        }
      },
      () => {
        if (timer === controller) {
          timer = undefined;
        }
      },
    );
  }

  /** The next push to start: transactional first, then marketing, then campaign, round-robin. */
  function next(): { start: Start; slot?: Slot } | undefined {
    const first = tx[0];
    if (first) {
      return { start: first };
    }
    for (const cls of CLASSES) {
      for (const member of startTurn[cls]) {
        const slot = member.slots[cls].find((item) => item.start);
        if (slot?.start) {
          rotate(startTurn[cls], member);
          return { start: slot.start, slot };
        }
      }
    }
    return undefined;
  }

  /** Starts every push whose time has come, then arms one timer for the next. No work, no timer. */
  function pump() {
    if (pumping || stopped) {
      return;
    }
    pumping = true;
    try {
      for (;;) {
        if (rate > 0) {
          const now = clock.now().getTime();
          if (nextAt < now) {
            nextAt = now;
          }
          if (nextAt > now) {
            if (tx.length || hasReadySlot()) {
              arm(nextAt - now);
            }
            break;
          }
        }
        const chosen = next();
        if (!chosen) {
          break;
        }
        if (rate > 0) {
          lastStart = clock.now().getTime();
          nextAt += 1000 / rate;
        }
        const { start, slot } = chosen;
        options.onStart?.(slot ? slot.cls : "transactional");
        if (slot) {
          take(slot);
          slot.start = undefined;
          if (rate <= 0) {
            running.add(slot);
          }
        } else {
          remove(tx, start);
          start.member.waiting.delete(start);
        }
        start.resolve();
      }
    } finally {
      pumping = false;
    }
    assign();
  }

  function hasReadySlot(): boolean {
    return CLASSES.some((cls) =>
      startTurn[cls].some((member) => member.slots[cls].some((slot) => slot.start)),
    );
  }

  /** Removes a reserved slot from its member's reservations. */
  function take(slot: Slot): boolean {
    if (!remove(slot.member.slots[slot.cls], slot)) {
      return false;
    }
    reserved--;
    if (slot.member.slots[slot.cls].length === 0) {
      remove(startTurn[slot.cls], slot.member);
    }
    return true;
  }

  function reserve(member: Member, cls: GrantClass): Slot {
    const slot: Slot = { member, cls };
    member.slots[cls].push(slot);
    reserved++;
    if (!startTurn[cls].includes(member)) {
      startTurn[cls].push(member);
    }
    return slot;
  }

  /**
   * Grants free horizon room in class order, one slot per member per turn, each member at most its
   * share of the horizon among the members of that class with a request or a reservation. Every
   * request then holding a slot is answered: it never waits for more.
   */
  function assign() {
    if (stopped) {
      return;
    }
    const bound = horizonSlots(rate);
    let free = bound - reserved - tx.length - running.size;
    if (free > 0 && !(options.held?.() ?? false)) {
      for (const cls of CLASSES) {
        const active = members.filter(
          (member) => member.requests[cls].length > 0 || member.slots[cls].length > 0,
        ).length;
        const share = Math.ceil(bound / Math.max(1, active));
        while (free > 0) {
          const member = grantTurn[cls].find(
            (item) => item.requests[cls].length > 0 && item.slots[cls].length < share,
          );
          if (!member) {
            break;
          }
          const request = must(member.requests[cls][0], "open request");
          request.slots.push(reserve(member, cls));
          free--;
          rotate(grantTurn[cls], member);
          if (request.slots.length >= request.want) {
            answer(request);
          }
        }
      }
    }
    for (const cls of CLASSES) {
      for (const member of grantTurn[cls].slice()) {
        for (const request of member.requests[cls].slice()) {
          if (request.slots.length > 0) {
            answer(request);
          }
        }
      }
    }
  }

  function close(request: Request) {
    const { member, cls } = request;
    remove(member.requests[cls], request);
    if (member.requests[cls].length === 0) {
      remove(grantTurn[cls], member);
    }
    request.cleanup();
  }

  function answer(request: Request) {
    close(request);
    const state = { member: request.member, slots: request.slots, used: [] as Array<Slot> };
    const grant: Grant = {
      get count() {
        return state.slots.length;
      },
      keep(count: number) {
        drop(state.slots.splice(Math.max(0, Math.floor(count))));
      },
      release() {
        drop([...state.slots.splice(0), ...state.used.splice(0)]);
      },
    };
    grants.set(grant, state);
    request.resolve(grant);
  }

  function cancel(request: Request, error: Error) {
    close(request);
    drop(request.slots.splice(0));
    request.reject(error);
  }

  /** Returns slots to the horizon; a push waiting in one ends not-started. Freed room is regranted. */
  function drop(slots: Array<Slot>) {
    let freed = false;
    for (const slot of slots) {
      freed = take(slot) || freed;
      const start = slot.start;
      slot.start = undefined;
      start?.reject(stoppedError());
    }
    if (freed) {
      assign();
    }
  }

  /**
   * Starts a push now when nothing has to wait: unpaced (rate 0), or a transactional push with no
   * transactional push ahead of it and its tick come. It then enters a pool in the same turn, as it
   * did before the dispatcher. Otherwise the push waits for its turn.
   */
  function startNow(member: Member, slot?: Slot): boolean {
    if (stopped || member.closed) {
      return false;
    }
    if (rate > 0) {
      const now = clock.now().getTime();
      if (slot || tx.length || nextAt > now) {
        return false;
      }
      lastStart = now;
      nextAt = now + 1000 / rate;
    }
    options.onStart?.(slot ? slot.cls : "transactional");
    if (slot) {
      take(slot);
      running.add(slot);
      assign();
    }
    return true;
  }

  /** A transactional start: the next start, ahead of every granted one. Bounded when given. */
  function transactionalWait(member: Member, bound?: number): StartWait {
    return () =>
      new Promise<void>((resolve, reject) => {
        if (stopped || member.closed) {
          reject(stoppedError());
          return;
        }
        let limit: AbortController | undefined;
        const start: Start = {
          member,
          resolve: () => {
            limit?.abort();
            resolve();
          },
          reject: (error) => {
            limit?.abort();
            reject(error);
          },
        };
        if (bound !== undefined) {
          const controller = new AbortController();
          limit = controller;
          void clock.sleep(bound, controller.signal).then(
            () => {
              if (remove(tx, start)) {
                member.waiting.delete(start);
                reject(new Error("Send-rate wait bound reached"));
                assign();
              }
            },
            () => {},
          );
        }
        tx.push(start);
        member.waiting.add(start);
        pump();
      });
  }

  /** A granted start: the slot is reserved already; the push only waits for its turn. */
  function grantedWait(slot: Slot): StartWait {
    return () =>
      new Promise<void>((resolve, reject) => {
        if (stopped || slot.member.closed || !slot.member.slots[slot.cls].includes(slot)) {
          take(slot);
          reject(stoppedError());
          return;
        }
        slot.start = { member: slot.member, resolve, reject };
        pump();
      });
  }

  function stopMember(member: Member) {
    member.closed = true;
    for (const cls of CLASSES) {
      for (const request of member.requests[cls].slice()) {
        cancel(request, stoppedError());
      }
      drop(member.slots[cls].slice());
    }
    for (const start of Array.from(member.waiting)) {
      member.waiting.delete(start);
      remove(tx, start);
      start.reject(stoppedError());
    }
    assign();
    pump();
  }

  function sender(context: SenderContext): Sender {
    const member: Member = {
      closed: false,
      requests: { marketing: [], campaign: [] },
      slots: { marketing: [], campaign: [] },
      waiting: new Set(),
      inflight: new Set(),
      cut: new Set(),
    };
    members.push(member);
    let closing: Promise<void> | undefined;
    const pushContext = (rootUrl: string): PushContext => ({
      domain: rootDomain(rootUrl),
      copyAllowed: (address) => context.copyAllowed(address),
      refuse: () => context.refuse(),
    });
    const track = (dispatch: Dispatch, slot?: Slot): Dispatch => {
      // The project sees the push's own outcome, or `ambiguous` once its close deadline passes.
      // The slot stays running until the push itself settles, so the horizon's bound holds.
      let expire!: () => void;
      const result = new Promise<Outcome>((resolve, reject) => {
        expire = () =>
          resolve({
            messageId: dispatch.messageId,
            status: "ambiguous",
            stage: "unknown",
            accepted: [],
            rejected: [],
          });
        dispatch.result.then(resolve, reject);
      });
      member.cut.add(expire);
      const settled = result.then(
        () => {},
        () => {},
      );
      member.inflight.add(settled);
      void settled.then(() => {
        member.inflight.delete(settled);
        member.cut.delete(expire);
      });
      const ran = () => {
        if (slot && running.delete(slot)) {
          assign();
        }
      };
      void dispatch.result.then(ran, ran);
      // A push that settled before it waited (a local failure, or a closed emailer) never used its
      // slot: the wait is attached synchronously by the push, so an unattached slot goes back now.
      if (slot && !slot.start && slot.member.slots[slot.cls].includes(slot)) {
        drop([slot]);
      }
      return { messageId: dispatch.messageId, result };
    };
    const closed = () => member.closed || stopped || emailer.closed;
    return {
      push(message, delivery = {}) {
        context.refuse();
        let slot: Slot | undefined;
        if (delivery.grant) {
          const state = grants.get(delivery.grant);
          slot = state?.member === member ? state.slots.shift() : undefined;
          if (!state || !slot) {
            throw new Error("No slot left in the grant");
          }
          state.used.push(slot);
        }
        const immediate = startNow(member, slot);
        const push: PushDelivery = {
          context: pushContext(context.rootUrl()),
          ...delivery,
          ...(immediate
            ? undefined
            : { wait: slot ? grantedWait(slot) : transactionalWait(member) }),
        };
        const dispatch = emailer.push(message, push);
        return track(dispatch, slot);
      },
      test(server, message, rootUrl) {
        context.refuse();
        return track(
          emailer.test(server, message, {
            context: pushContext(rootUrl),
            wait: transactionalWait(member, SMTP_TEST_WAIT_MS),
          }),
        );
      },
      request(cls, count, signal) {
        if (closed() || signal?.aborted) {
          return Promise.reject(signal?.aborted ? signal.reason : stoppedError());
        }
        return new Promise<Grant>((resolve, reject) => {
          const onAbort = () => {
            if (member.requests[cls].includes(request)) {
              cancel(request, stoppedError());
            }
          };
          const request: Request = {
            member,
            cls,
            want: Math.max(1, Math.floor(count)),
            slots: [],
            resolve,
            reject,
            cleanup: () => signal?.removeEventListener("abort", onAbort),
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          member.requests[cls].push(request);
          if (!grantTurn[cls].includes(member)) {
            grantTurn[cls].push(member);
          }
          assign();
        });
      },
      get closed() {
        return closed();
      },
      close() {
        if (!member.closed) {
          stopMember(member);
          remove(members, member);
        }
        closing ??= (async () => {
          if (member.inflight.size === 0) {
            return;
          }
          const timer = new AbortController();
          const deadline = clock.sleep(SENDER_CLOSE_MS, timer.signal).then(
            () => {
              for (const expire of Array.from(member.cut)) {
                expire();
              }
            },
            () => {},
          );
          await Promise.allSettled(member.inflight);
          timer.abort();
          await deadline;
        })();
        return closing;
      },
    };
  }

  return {
    /** A project's sender, with its per-push context. */
    sender,
    /**
     * The rate or the hold changed: the next start is one interval of the new rate after the last
     * start, whether the rate went up or down, and freed horizon room is granted.
     */
    wake() {
      timer?.abort();
      timer = undefined;
      rate = options.rate();
      nextAt = rate > 0 ? lastStart + 1000 / rate : 0;
      pump();
    },
    /** True once close() has begun. */
    get closed() {
      return stopped || emailer.closed;
    },
    /**
     * Last in the shutdown order: every project stops (waiting work ends not-started), in-flight
     * sends drain under the emailer's deadlines, and the pools close.
     */
    close(): Promise<void> {
      for (const member of members.slice()) {
        stopMember(member);
      }
      stopped = true;
      timer?.abort();
      timer = undefined;
      return emailer.close();
    },
  };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
