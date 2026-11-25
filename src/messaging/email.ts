// SMTP messenger adapted from listmonk internal/messenger/email/email.go and models/messages.go at 6fcd95f.
import nodemailer from "nodemailer";
import { createConnection, isIP } from "node:net";
import type { Socket } from "node:net";
import type { Clock } from "@/clock";
import { goDuration } from "@/settings/duration";
import { requiredAuth } from "@/messaging/auth";
import { parseAddress } from "@/settings/mail";
import { simpleLower } from "@/subscribers/unicode-lower";
import { trimSpace } from "@/lists/store";

export interface SMTPServer {
  uuid?: string;
  name: string;
  enabled: boolean;
  exclude_from_default: boolean;
  host: string;
  port: number;
  hello_hostname: string;
  max_conns: number;
  idle_timeout: string;
  wait_timeout: string;
  auth_protocol: string;
  username: string;
  password?: string;
  tls_type: string;
  tls_skip_verify: boolean;
  email_headers: Array<Record<string, string> | null> | null;
  from_addresses: Array<string> | null;
  dkim?: { domain_name: string; key_selector: string; private_key: string } | null;
}
/** Extra message headers by name; a repeated name carries several values. */
export type MessageHeaders = Record<string, string | Array<string>>;
export interface Message {
  from: string;
  to: Array<string>;
  subject: string;
  contentType: "plain" | "html";
  body: Uint8Array;
  altBody?: Uint8Array;
  headers?: MessageHeaders;
  attachments?: Array<{
    name: string;
    content: Uint8Array;
    inline?: boolean;
    cid?: string;
    contentType?: string;
    disposition?: "inline" | "attachment";
  }>;
  messageId?: string;
  messenger?: string;
}
export type Outcome = {
  messageId: string;
  status: "accepted" | "proven-not-accepted" | "ambiguous";
  stage: "local" | "setup" | "recipients" | "smtp-complete" | "unknown" | "not-started";
  accepted: Array<string>;
  rejected: Array<string>;
  retry?: "transient";
};
export interface Dispatch {
  messageId: string;
  result: Promise<Outcome>;
}
/**
 * What one push carries that differs between projects (14-projects section 7): its Message-ID
 * domain, its copy policy (that project's blocklist) and its hold check (its restore hold).
 */
export interface PushContext {
  /** The host a generated Message-ID is named with. */
  readonly domain: string;
  /** Delivery policy for Cc/Bcc mailboxes, applied to message and server headers. */
  copyAllowed(address: string): boolean;
  /** Throws to stop a message before it reaches a pool: the restore hold (D67). */
  refuse(): void;
}
/**
 * The wait before a push starts: the dispatcher's start slot. It rejects when the push will not
 * start (the wait was bounded or the sender stopped), and the push is then not-started.
 */
export type StartWait = () => Promise<void>;

type SocketState = { stopped: boolean; waiting: Array<() => void>; onClose: () => void };
type Transport = ReturnType<typeof makeTransport>;
type Pool = {
  key: string;
  transport: Transport;
  active: number;
  limit: number;
  operations: Set<Operation>;
  sockets: Set<Socket>;
  socketState: SocketState;
  retired: boolean;
  stopped: boolean;
  done: Promise<void>;
  resolve: () => void;
};

function duration(value: string, fallback: number): number {
  const ms = goDuration(value);
  return Number.isFinite(ms) && ms >= 1000 && ms <= 300_000 ? ms : fallback;
}
export function validServer(s: SMTPServer): boolean {
  return (
    typeof s.host === "string" &&
    !!s.host.trim() &&
    // A host with whitespace or control characters is refused on purpose.
    // oxlint-disable-next-line no-control-regex
    !/[\s\u0000-\u001f\u007f]/.test(s.host) &&
    Number.isInteger(s.port) &&
    s.port >= 1 &&
    s.port <= 65_535 &&
    Number.isSafeInteger(s.max_conns) &&
    s.max_conns >= 1 &&
    ["", "none", "plain", "login", "cram"].includes(s.auth_protocol) &&
    ["", "none", "STARTTLS", "TLS"].includes(s.tls_type) &&
    typeof s.username === "string" &&
    (!["plain", "login", "cram"].includes(s.auth_protocol) || !!s.username || !!s.password) &&
    typeof s.tls_skip_verify === "boolean" &&
    typeof s.hello_hostname === "string" &&
    !/[\r\n\0]/.test(s.hello_hostname)
  );
}
type Operation = {
  started: boolean;
  start(): void;
  cancel(): void;
};

function makeTransport(
  s: SMTPServer,
  test: boolean,
  sockets: Set<Socket>,
  socketState: SocketState,
) {
  const wait = test ? 2000 : duration(s.wait_timeout, 5000);
  const method = s.auth_protocol === "cram" ? "CRAM-MD5" : s.auth_protocol.toUpperCase();
  return nodemailer.createTransport({
    pool: true,
    // The public socket hook lets the owner terminate even a busy pooled connection.
    // Nodemailer upgrades this connected socket itself for implicit TLS and STARTTLS.
    getSocket(
      _options: unknown,
      callback: (error: Error | null, socket: false | { connection: Socket }) => void,
    ) {
      const connect = () => {
        if (socketState.stopped) {
          callback(new Error("Transport closed"), false);
          return;
        }
        // A pool resource may be replaced before its previous TCP socket has
        // completed closing. Count the sockets themselves, including teardown.
        if (sockets.size >= (test ? 1 : s.max_conns)) {
          socketState.waiting.push(connect);
          return;
        }
        const socket = createConnection({ host: s.host, port: s.port });
        sockets.add(socket);
        let pending = true;
        const fail = (error: NodeJS.ErrnoException) => {
          if (!pending) {
            return;
          }
          pending = false;
          socket.destroy();
          callback(
            Object.assign(error, {
              command: "CONN",
              originalCode: error.code,
              ownerConnectRefused: error.code === "ECONNREFUSED",
            }),
            false,
          );
        };
        socket.once("error", fail);
        socket.once("close", () => {
          sockets.delete(socket);
          if (pending) {
            fail(new Error("Connection closed"));
          }
          socketState.waiting.shift()?.();
          socketState.onClose();
        });
        socket.setTimeout(wait, () => fail(new Error("Connection timed out")));
        socket.once("connect", () => {
          if (!pending) {
            return;
          }
          pending = false;
          socket.setTimeout(0);
          socket.removeListener("error", fail);
          callback(null, { connection: socket });
        });
      };
      connect();
    },
    host: s.host,
    port: s.port,
    secure: s.tls_type === "TLS",
    ignoreTLS: s.tls_type === "none" || s.tls_type === "",
    requireTLS: s.tls_type === "STARTTLS",
    ...(s.hello_hostname ? { name: s.hello_hostname } : { name: "localhost" }),
    tls: {
      rejectUnauthorized: !s.tls_skip_verify,
      ...(isIP(s.host) ? {} : { servername: s.host }),
    },
    ...(["plain", "login", "cram"].includes(s.auth_protocol)
      ? {
          auth: { user: s.username, pass: s.password ?? "" },
          ...requiredAuth(
            method,
            s.tls_type === "TLS" ||
              s.tls_type === "STARTTLS" ||
              ["localhost", "127.0.0.1", "::1"].includes(s.host),
          ),
        }
      : {}),
    maxConnections: test ? 1 : s.max_conns,
    maxMessages: 100,
    maxRequeues: 0,
    idleTimeout: test ? 2000 : duration(s.idle_timeout, 15_000),
    connectionTimeout: wait,
    greetingTimeout: wait,
    socketTimeout: test ? 5000 : 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    ...(s.dkim
      ? {
          dkim: {
            domainName: s.dkim.domain_name,
            keySelector: s.dkim.key_selector,
            privateKey: s.dkim.private_key,
          },
        }
      : {}),
  });
}
const safeValue = (value: string) => !/[\r\n\0]/.test(value);
const headerName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function bareAddress(value: string): string {
  const parsed = parseAddress(trimSpace(value));
  return parsed === undefined ? "" : simpleLower(parsed);
}
const one = (value: string) => {
  const address = parseAddress(value);
  if (address === undefined) {
    throw new Error("Invalid mailbox");
  }
  return { address };
};
function build(
  s: SMTPServer,
  input: Message,
  id: string,
  now: Date,
  copyAllowed: (address: string) => boolean,
  copies: boolean,
) {
  const headers = new Map<string, { name: string; value: string }>();
  const add = (name: string, raw: string | Array<string>) => {
    const value = Array.isArray(raw) ? (raw[0] ?? "") : raw;
    if (!headerName.test(name) || typeof value !== "string" || !safeValue(value)) {
      throw new Error("Invalid header");
    }
    const lower = name.toLowerCase();
    headers.set(lower, { name, value });
  };
  for (const group of s.email_headers ?? []) {
    for (const [k, v] of Object.entries(group ?? {})) {
      add(k, v);
    }
  }
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    add(k, v);
  }
  if (!safeValue(input.from) || !safeValue(input.subject) || input.to.some((v) => !safeValue(v))) {
    throw new Error("Invalid address or subject");
  }
  const returnPath = headers.get("return-path")?.value;
  headers.delete("return-path");
  // Filter copies after merging server settings, so configured Cc/Bcc obey the same policy.
  // A message without copies (marketing) drops message and server Cc/Bcc entirely.
  const filtered = (value: string | undefined) =>
    copies
      ? value
          ?.split(",")
          .filter((part) => {
            const address = parseAddress(trimSpace(part));
            return address === undefined || copyAllowed(address);
          })
          .join(",")
      : undefined;
  const cc = filtered(headers.get("cc")?.value);
  headers.delete("cc");
  const bcc = filtered(headers.get("bcc")?.value);
  headers.delete("bcc");
  headers.delete("message-id");
  const from = headers.get("from")?.value ?? input.from;
  const to = headers.get("to")?.value ?? [...input.to];
  const subject = headers.get("subject")?.value ?? input.subject;
  const date = headers.get("date")?.value ?? now;
  for (const field of [
    "from",
    "to",
    "subject",
    "date",
    "content-type",
    "content-transfer-encoding",
  ]) {
    headers.delete(field);
  }
  if (s.dkim && headers.has("dkim-signature")) {
    throw new Error("Duplicate signature");
  }
  const attachments = (input.attachments ?? []).map((a) => {
    if (![a.name, a.cid ?? "", a.contentType ?? ""].every(safeValue)) {
      throw new Error("Invalid attachment");
    }
    return {
      filename: a.name,
      // A view: a campaign's messages share one buffer, which nothing here writes to.
      content: Buffer.from(a.content.buffer, a.content.byteOffset, a.content.byteLength),
      ...(a.cid ? { cid: a.cid } : {}),
      ...(a.contentType ? { contentType: a.contentType } : {}),
      contentDisposition:
        a.disposition ?? (a.inline ? ("inline" as const) : ("attachment" as const)),
    };
  });
  const customHeaders = Array.from(headers.values(), ({ name: key, value }) => ({ key, value }));
  // Nodemailer 10 supports explicit address objects here. The separately pinned
  // @types/nodemailer 8 envelope type omits them. Keep this adapter at the SDK
  // boundary so an already parsed mailbox cannot be expanded as an address list.
  const envelope = {
    from: one(returnPath || input.from),
    to: [
      ...input.to.map(one),
      ...(cc ? cc.split(",").map((value) => one(trimSpace(value))) : []),
      ...(bcc ? bcc.split(",").map((value) => one(trimSpace(value))) : []),
    ],
  } as unknown as { from: string; to: Array<string> };
  return {
    from,
    to,
    subject,
    messageId: id,
    date,
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    envelope,
    ...(input.contentType === "plain"
      ? { text: Buffer.from(input.body) }
      : {
          html: Buffer.from(input.body),
          ...(input.altBody ? { text: Buffer.from(input.altBody) } : {}),
        }),
    headers: customHeaders,
    attachments,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}
/** The host a generated Message-ID is named with: the root URL's host, else `localhost`. */
export function rootDomain(rootUrl: string): string {
  try {
    return new URL(rootUrl).hostname || "localhost";
  } catch {
    return "localhost";
  }
}
/**
 * A Message-ID chosen before a message is handed to the emailer, so a record of it can be written
 * first (B108). The emailer sends a message with the Message-ID the caller supplies.
 */
export function newMessageId(rootUrl: string): string {
  return `<${crypto.randomUUID()}@${rootDomain(rootUrl)}>`;
}
function suppliedId(s: SMTPServer | undefined, m: Message): string | undefined {
  let result: string | undefined;
  for (const group of s?.email_headers ?? []) {
    for (const [k, v] of Object.entries(group ?? {})) {
      if (k.toLowerCase() === "message-id") {
        result = v;
      }
    }
  }
  for (const [k, v] of Object.entries(m.headers ?? {})) {
    if (k.toLowerCase() === "message-id") {
      result = Array.isArray(v) ? v[0] : v;
    }
  }
  return m.messageId || result || undefined;
}
/** What a push is given besides its message: its context, and its wait for a start slot. */
export interface PushDelivery {
  readonly context: PushContext;
  /**
   * `false` sends to `message.to` only: Cc/Bcc from the message and from the server's
   * `email_headers` are dropped. Marketing sends use it (one admitted recipient).
   */
  readonly copies?: boolean;
  /** A test send's own pool (B101). */
  readonly testPool?: boolean;
  /** The start slot; none starts at once. The 60 s push deadline (D49) begins after it. */
  readonly wait?: StartWait;
}

/**
 * The instance's one SMTP sender (14-projects section 7): its pools are shared by every project, and
 * each push carries its project's context. Only the dispatcher builds one (src/messaging/dispatcher.ts).
 */
export function createEmailer(options: {
  smtp: () => Array<SMTPServer>;
  clock: Clock;
  select?: (count: number) => number;
  id?: () => string;
}) {
  const pools = new Map<string, Pool>();
  // Test sends (B101) use their own pools, keyed like real ones but apart from them, so a stalled
  // test cannot cut a real send that shares its server.
  const testPools = new Map<string, Pool>();
  const retired = new Set<Pool>();
  const selection = options.select ?? ((n: number) => Math.floor(Math.random() * n));
  const id = options.id ?? (() => crypto.randomUUID());
  let closed = false;
  let closing: Promise<void> | undefined;
  function finishPool(pool: Pool) {
    if (!pool.retired || pool.operations.size !== 0) {
      return;
    }
    if (!pool.stopped) {
      pool.stopped = true;
      pool.socketState.stopped = true;
      for (const resume of pool.socketState.waiting.splice(0)) {
        resume();
      }
      pool.transport.close();
    }
    if (pool.sockets.size === 0) {
      retired.delete(pool);
      pool.resolve();
    }
  }
  function retire(pool: Pool) {
    if (pool.retired) {
      return;
    }
    pool.retired = true;
    retired.add(pool);
    finishPool(pool);
  }
  function cancelPool(pool: Pool) {
    if (!pool.retired) {
      retire(pool);
    }
    if (pools.get(pool.key) === pool) {
      pools.delete(pool.key);
    }
    if (testPools.get(pool.key) === pool) {
      testPools.delete(pool.key);
    }
    // Stop the library queue before destroying sockets; no work is resubmitted.
    pool.stopped = true;
    pool.socketState.stopped = true;
    for (const resume of pool.socketState.waiting.splice(0)) {
      resume();
    }
    pool.transport.close();
    for (const socket of pool.sockets) {
      socket.destroy();
    }
    for (const operation of Array.from(pool.operations)) {
      operation.cancel();
    }
    retired.delete(pool);
    pool.resolve();
  }
  function pump(pool: Pool) {
    if (pool.stopped) {
      return;
    }
    for (const operation of pool.operations) {
      if (pool.active >= pool.limit) {
        break;
      }
      if (!operation.started) {
        operation.start();
      }
    }
  }
  function createPool(key: string, server: SMTPServer, temporary = false): Pool {
    let resolve!: () => void;
    const done = new Promise<void>((finish) => {
      resolve = finish;
    });
    const sockets = new Set<Socket>();
    const socketState: SocketState = { stopped: false, waiting: [], onClose: () => {} };
    const pool: Pool = {
      key,
      sockets,
      socketState,
      transport: makeTransport(server, temporary, sockets, socketState),
      active: 0,
      limit: temporary ? 1 : server.max_conns,
      operations: new Set(),
      retired: false,
      stopped: false,
      done,
      resolve,
    };
    socketState.onClose = () => finishPool(pool);
    return pool;
  }
  function reconcile(servers: Array<SMTPServer>) {
    const keys = new Set(servers.map((s) => JSON.stringify(s)));
    for (const table of [pools, testPools]) {
      for (const [key, pool] of table) {
        if (!keys.has(key)) {
          table.delete(key);
          retire(pool);
        }
      }
    }
  }
  function dispatch(
    server: SMTPServer | undefined,
    message: Message,
    delivery: PushDelivery,
    temporary = false,
    startedAt = options.clock.now().getTime(),
  ): Dispatch {
    const { context } = delivery;
    const copies = delivery.copies ?? true;
    const testPool = delivery.testPool ?? false;
    const serverId = suppliedId(server, message);
    const messageId = serverId ?? `<${id()}@${context.domain}>`;
    const localOutcome = (): Outcome => ({
      messageId,
      status: "proven-not-accepted",
      stage: "local",
      accepted: [],
      rejected: [],
    });
    const notStartedOutcome = (): Outcome => ({
      messageId,
      status: "proven-not-accepted",
      stage: "not-started",
      accepted: [],
      rejected: [],
    });
    const local = (): Dispatch => ({ messageId, result: Promise.resolve(localOutcome()) });
    // A closed emailer never starts a message: the work is handed back (not-started), not failed.
    if (closed) {
      return { messageId, result: Promise.resolve(notStartedOutcome()) };
    }
    if (!server || !validServer(server) || !/^<[^<>\s@]+@[^<>\s@]+>$/.test(messageId)) {
      return local();
    }
    let data: ReturnType<typeof build>;
    try {
      data = build(
        server,
        message,
        messageId,
        options.clock.now(),
        (address) => context.copyAllowed(address),
        copies,
      );
    } catch {
      return local();
    }
    if (options.clock.now().getTime() - startedAt >= (temporary ? 10_000 : 60_000)) {
      return local();
    }

    let timer: AbortController | undefined;
    let resolve!: (outcome: Outcome) => void;
    const result = new Promise<Outcome>((finish) => {
      resolve = finish;
    });
    let settled = false;
    let pool: Pool | undefined;
    let operation: Operation | undefined;

    const complete = (outcome: Outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      timer?.abort();
      if (pool && operation) {
        pool.operations.delete(operation);
        if (operation.started) {
          pool.active--;
        }
        finishPool(pool);
        pump(pool);
      }
      resolve(outcome);
    };

    void (async () => {
      if (delivery.wait) {
        // The start slot (14-projects section 7). A wait that rejects (bounded, or its sender
        // stopped) never started: the work is handed back.
        try {
          await delivery.wait();
        } catch {
          if (!settled) {
            complete(notStartedOutcome());
          }
          return;
        }
      }
      if (settled || closed) {
        if (!settled) {
          complete(notStartedOutcome());
        }
        return;
      }
      try {
        context.refuse();
      } catch {
        if (!settled) {
          complete(localOutcome());
        }
        return;
      }

      const remaining = temporary ? 10_000 : 60_000;
      const timeout = new AbortController();
      timer = timeout;
      void new Promise<void>((resolve) => {
        resolve(options.clock.sleep(remaining, timeout.signal));
      }).then(
        () => {
          if (settled) {
            return;
          }
          if (operation?.started) {
            if (pool) {
              cancelPool(pool);
            }
          } else if (operation) {
            operation.cancel();
          } else {
            complete(localOutcome());
          }
        },
        () => {},
      );

      if (temporary) {
        pool = createPool("", server, true);
      } else {
        const key = JSON.stringify(server);
        const table = testPool ? testPools : pools;
        pool = table.get(key) ?? createPool(key, server);
        table.set(key, pool);
      }
      if (temporary) {
        pool.retired = true;
        retired.add(pool);
      }

      // The queued operation's methods reach it by its own name, and the pool it runs on by a constant:
      // both are assigned once above, before any method can run.
      const queuedPool = pool;
      const queued: Operation = {
        started: false,
        cancel() {
          // A queued operation that never started has not touched SMTP. Once close() has begun,
          // it is handed back as not-started, so its row stays queued instead of failing (B92).
          complete(
            queued.started
              ? { messageId, status: "ambiguous", stage: "unknown", accepted: [], rejected: [] }
              : closed
                ? notStartedOutcome()
                : localOutcome(),
          );
        },
        start() {
          queued.started = true;
          queuedPool.active++;
          // The executor turns a synchronous throw from the transport into a rejection, so
          // nothing after the hand-off to a pool can throw out of `push`.
          void new Promise<{ accepted: Array<unknown>; rejected: Array<unknown> }>((resolve) => {
            resolve(queuedPool.transport.sendMail(data));
          })
            .then((info) =>
              complete({
                messageId,
                status: "accepted",
                stage: "smtp-complete",
                accepted: info.accepted.map(String),
                rejected: info.rejected.map(String),
              }),
            )
            .catch((error: unknown) => {
              const e = error as {
                command?: string;
                timeoutType?: string;
                ownerConnectRefused?: boolean;
                ownerAuthNotAccepted?: boolean;
                response?: string;
                responseCode?: number;
                rejected?: Array<unknown>;
                rejectedErrors?: Array<{
                  recipient?: string;
                  responseCode?: number;
                  command?: string;
                  response?: string;
                }>;
              };
              const rejected =
                e.rejected?.map(String) ??
                e.rejectedErrors?.flatMap((r) => (r.recipient ? [r.recipient] : [])) ??
                [];
              if (
                e.ownerConnectRefused ||
                e.ownerAuthNotAccepted ||
                (e.command?.startsWith("AUTH ") &&
                  e.responseCode &&
                  e.responseCode >= 400 &&
                  e.responseCode < 600 &&
                  /^\d{3}[ -]/.test(e.response ?? ""))
              ) {
                complete({
                  messageId,
                  status: "proven-not-accepted",
                  stage: "setup",
                  accepted: [],
                  rejected: [],
                  ...(e.ownerConnectRefused ||
                  (e.command?.startsWith("AUTH ") &&
                    e.responseCode &&
                    e.responseCode >= 400 &&
                    e.responseCode < 500 &&
                    /^4\d{2}[ -]/.test(e.response ?? ""))
                    ? { retry: "transient" as const }
                    : {}),
                });
              } else if (
                e.command === "RCPT TO" &&
                Array.isArray(e.rejected) &&
                e.rejected.length &&
                e.rejectedErrors?.length === e.rejected.length &&
                e.rejectedErrors.every(
                  (r) =>
                    r.recipient &&
                    r.command === "RCPT TO" &&
                    r.responseCode &&
                    r.responseCode >= 400 &&
                    r.responseCode < 600 &&
                    r.response?.startsWith(`${r.responseCode} `),
                )
              ) {
                complete({
                  messageId,
                  status: "proven-not-accepted",
                  stage: "recipients",
                  accepted: [],
                  rejected,
                  ...(e.rejectedErrors.some(
                    (r) => r.responseCode !== undefined && r.responseCode < 500,
                  )
                    ? { retry: "transient" as const }
                    : {}),
                });
              } else if (e.timeoutType === "GREETING_TIMEOUT") {
                // No greeting arrived, and a client writes nothing before the greeting, so nothing
                // reached the server and nothing was accepted (B118a). Like a refused connection, it
                // is proven not sent: a transactional send retries it, and no send is resent here.
                complete({
                  messageId,
                  status: "proven-not-accepted",
                  stage: "setup",
                  accepted: [],
                  rejected: [],
                  retry: "transient",
                });
              } else {
                complete({
                  messageId,
                  status: "ambiguous",
                  stage: rejected.length ? "recipients" : "unknown",
                  accepted: [],
                  rejected,
                });
              }
            });
        },
      };
      operation = queued;
      pool.operations.add(operation);
      pump(pool);
    })();

    return { messageId, result };
  }
  /**
   * Picks the message's server and sends it. The caller (the dispatcher's sender) runs the hold check
   * before it; the emailer runs it again at the start, after the wait.
   */
  function push(message: Message, delivery: PushDelivery): Dispatch {
    const startedAt = options.clock.now().getTime();
    if (closed) {
      return dispatch(undefined, message, delivery, false, startedAt);
    }
    const servers = structuredClone(options.smtp()).filter((s) => s.enabled);
    reconcile(servers);
    let bucket =
      message.messenger && message.messenger !== "email"
        ? servers.filter((s) => s.name === message.messenger)
        : servers.filter((s) => !s.exclude_from_default);
    if (!message.messenger || message.messenger === "email") {
      const from = bareAddress(message.from);
      const exact = bucket.filter((s) =>
        (s.from_addresses ?? []).some((value) => simpleLower(trimSpace(value)) === from),
      );
      const domain = from.split("@").at(-1);
      const domains = bucket.filter(
        (s) =>
          domain &&
          (s.from_addresses ?? []).some((value) => simpleLower(trimSpace(value)) === domain),
      );
      bucket = exact.length ? exact : domains.length ? domains : bucket;
    }
    const index = bucket.length ? selection(bucket.length) : -1;
    return dispatch(bucket[index], message, delivery, false, startedAt);
  }
  return {
    push,
    /** The SMTP settings test: a temporary pool for `server`, with Cc/Bcc kept. */
    test: (server: SMTPServer, message: Message, delivery: PushDelivery) => {
      const startedAt = options.clock.now().getTime();
      return dispatch(structuredClone(server), message, delivery, true, startedAt);
    },
    /** True once close() has begun: nothing new starts, and the loops claim nothing. */
    get closed() {
      return closed;
    },
    close() {
      if (closing) {
        return closing;
      }
      closed = true;
      for (const pool of [...pools.values(), ...testPools.values()]) {
        retire(pool);
      }
      pools.clear();
      testPools.clear();
      const draining = [...retired];
      const timer = new AbortController();
      closing = (async () => {
        const timeout = options.clock.sleep(5000, timer.signal).then(
          () => {
            for (const pool of draining) {
              if (retired.has(pool)) {
                cancelPool(pool);
              }
            }
          },
          () => {},
        );
        await Promise.all(draining.map((pool) => pool.done));
        timer.abort();
        await timeout;
      })();
      return closing;
    },
  };
}
