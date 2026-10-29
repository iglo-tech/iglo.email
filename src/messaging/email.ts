// SMTP messenger adapted from listmonk internal/messenger/email/email.go and models/messages.go at 6fcd95f.
import nodemailer from "nodemailer";
import { createConnection, isIP, type Socket } from "node:net";
import addressParser from "nodemailer/lib/addressparser";
import type { Clock } from "@/clock";
import { goDuration } from "@/settings/duration";

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
  email_headers: Array<Record<string, string>> | null;
  from_addresses: string[] | null;
  dkim?: { domain_name: string; key_selector: string; private_key: string } | null;
}
export interface Message {
  from: string;
  to: string[];
  subject: string;
  contentType: "plain" | "html";
  body: Uint8Array;
  altBody?: Uint8Array;
  headers?: Record<string, string | string[]>;
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
  stage: "local" | "setup" | "recipients" | "smtp-complete" | "unknown";
  accepted: string[];
  rejected: string[];
};
export interface Dispatch {
  messageId: string;
  result: Promise<Outcome>;
}

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
  return Number.isFinite(ms) && ms >= 1000 && ms <= 300000 ? ms : fallback;
}
export function validServer(s: SMTPServer): boolean {
  return (
    typeof s.host === "string" &&
    !!s.host.trim() &&
    !/[\s\x00-\x1f\x7f]/.test(s.host) &&
    Number.isInteger(s.port) &&
    s.port >= 1 &&
    s.port <= 65535 &&
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
          if (!pending) return;
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
          if (pending) fail(new Error("Connection closed"));
          socketState.waiting.shift()?.();
          socketState.onClose();
        });
        socket.setTimeout(wait, () => fail(new Error("Connection timed out")));
        socket.once("connect", () => {
          if (!pending) return;
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
      ? { auth: { user: s.username, pass: s.password ?? "" }, authMethod: method }
      : {}),
    maxConnections: test ? 1 : s.max_conns,
    maxMessages: 100,
    maxRequeues: 0,
    idleTimeout: test ? 2000 : duration(s.idle_timeout, 15000),
    connectionTimeout: wait,
    greetingTimeout: wait,
    socketTimeout: test ? 5000 : 30000,
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
  const parsed = addressParser(value, { flatten: true });
  return parsed.length === 1 && "address" in parsed[0]! ? parsed[0]!.address.toLowerCase() : "";
}
function build(s: SMTPServer, input: Message, id: string, now: Date) {
  const headers = new Map<string, { name: string; value: string }>();
  const add = (name: string, raw: string | string[]) => {
    const value = Array.isArray(raw) ? (raw[0] ?? "") : raw;
    if (!headerName.test(name) || typeof value !== "string" || !safeValue(value))
      throw new Error("Invalid header");
    const lower = name.toLowerCase();
    headers.set(lower, { name, value });
  };
  for (const group of s.email_headers ?? []) for (const [k, v] of Object.entries(group)) add(k, v);
  for (const [k, v] of Object.entries(input.headers ?? {})) add(k, v);
  if (!safeValue(input.from) || !safeValue(input.subject) || input.to.some((v) => !safeValue(v)))
    throw new Error("Invalid address or subject");
  const returnPath = headers.get("return-path")?.value;
  headers.delete("return-path");
  const cc = headers.get("cc")?.value;
  headers.delete("cc");
  const bcc = headers.get("bcc")?.value;
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
  ])
    headers.delete(field);
  if (s.dkim && headers.has("dkim-signature")) throw new Error("Duplicate signature");
  const attachments = (input.attachments ?? []).map((a) => {
    if (![a.name, a.cid ?? "", a.contentType ?? ""].every(safeValue))
      throw new Error("Invalid attachment");
    return {
      filename: a.name,
      content: Buffer.from(a.content),
      ...(a.cid ? { cid: a.cid } : {}),
      ...(a.contentType ? { contentType: a.contentType } : {}),
      contentDisposition:
        a.disposition ?? (a.inline ? ("inline" as const) : ("attachment" as const)),
    };
  });
  const customHeaders = Array.from(headers.values(), ({ name: key, value }) => ({ key, value }));
  return {
    from,
    to,
    subject,
    messageId: id,
    date,
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    envelope: {
      from: returnPath || input.from,
      to: [...input.to, ...(cc ? [cc] : []), ...(bcc ? [bcc] : [])],
    },
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
function suppliedId(s: SMTPServer | undefined, m: Message): string | undefined {
  let result: string | undefined;
  for (const group of s?.email_headers ?? [])
    for (const [k, v] of Object.entries(group)) if (k.toLowerCase() === "message-id") result = v;
  for (const [k, v] of Object.entries(m.headers ?? {}))
    if (k.toLowerCase() === "message-id") result = Array.isArray(v) ? v[0] : v;
  return m.messageId || result || undefined;
}
export function createEmailer(options: {
  settings: () => { smtp: SMTPServer[]; rootUrl: string };
  clock: Clock;
  select?: (count: number) => number;
  id?: () => string;
}) {
  const pools = new Map<string, Pool>();
  const retired = new Set<Pool>();
  const selection = options.select ?? ((n: number) => Math.floor(Math.random() * n));
  const id = options.id ?? (() => crypto.randomUUID());
  let closed = false;
  let closing: Promise<void> | undefined;
  function finishPool(pool: Pool) {
    if (!pool.retired || pool.operations.size !== 0) return;
    if (!pool.stopped) {
      pool.stopped = true;
      pool.socketState.stopped = true;
      for (const resume of pool.socketState.waiting.splice(0)) resume();
      pool.transport.close();
    }
    if (pool.sockets.size === 0) {
      retired.delete(pool);
      pool.resolve();
    }
  }
  function retire(pool: Pool) {
    if (pool.retired) return;
    pool.retired = true;
    retired.add(pool);
    finishPool(pool);
  }
  function cancelPool(pool: Pool) {
    if (!pool.retired) retire(pool);
    if (pools.get(pool.key) === pool) pools.delete(pool.key);
    // Stop the library queue before destroying sockets; no work is resubmitted.
    pool.stopped = true;
    pool.socketState.stopped = true;
    for (const resume of pool.socketState.waiting.splice(0)) resume();
    pool.transport.close();
    for (const socket of pool.sockets) socket.destroy();
    for (const operation of [...pool.operations]) operation.cancel();
    retired.delete(pool);
    pool.resolve();
  }
  function pump(pool: Pool) {
    if (pool.stopped) return;
    for (const operation of pool.operations) {
      if (pool.active >= pool.limit) break;
      if (!operation.started) operation.start();
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
  function reconcile(servers: SMTPServer[]) {
    const keys = new Set(servers.map((s) => JSON.stringify(s)));
    for (const [key, pool] of pools)
      if (!keys.has(key)) {
        pools.delete(key);
        retire(pool);
      }
  }
  function dispatch(
    server: SMTPServer | undefined,
    message: Message,
    rootUrl: string,
    temporary = false,
  ): Dispatch {
    const serverId = suppliedId(server, message);
    let domain = "localhost";
    try {
      domain = new URL(rootUrl).hostname || domain;
    } catch {
      /* local fallback */
    }
    const messageId = serverId ?? `<${id()}@${domain}>`;
    const localOutcome = (): Outcome => ({
      messageId,
      status: "proven-not-accepted",
      stage: "local",
      accepted: [],
      rejected: [],
    });
    const local = (): Dispatch => ({ messageId, result: Promise.resolve(localOutcome()) });
    if (closed || !server || !validServer(server) || !/^<[^<>\s@]+@[^<>\s@]+>$/.test(messageId))
      return local();
    let data: ReturnType<typeof build>;
    try {
      data = build(server, message, messageId, options.clock.now());
    } catch {
      return local();
    }
    let pool: Pool;
    if (temporary) pool = createPool("", server, true);
    else {
      const key = JSON.stringify(server);
      pool = pools.get(key) ?? createPool(key, server);
      pools.set(key, pool);
    }
    if (temporary) {
      pool.retired = true;
      retired.add(pool);
    }
    const timer = new AbortController();
    let resolve!: (outcome: Outcome) => void;
    const result = new Promise<Outcome>((finish) => {
      resolve = finish;
    });
    let settled = false;
    const complete = (outcome: Outcome) => {
      if (settled) return;
      settled = true;
      timer.abort();
      pool.operations.delete(operation);
      if (operation.started) pool.active--;
      resolve(outcome);
      finishPool(pool);
      pump(pool);
    };
    const operation: Operation = {
      started: false,
      cancel() {
        complete(
          operation.started
            ? { messageId, status: "ambiguous", stage: "unknown", accepted: [], rejected: [] }
            : localOutcome(),
        );
      },
      start() {
        operation.started = true;
        pool.active++;
        void pool.transport
          .sendMail(data)
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
              ownerConnectRefused?: boolean;
              response?: string;
              responseCode?: number;
              rejected?: unknown[];
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
    pool.operations.add(operation);
    void options.clock.sleep(temporary ? 10000 : 60000, timer.signal).then(
      () => {
        if (settled) return;
        if (operation.started) cancelPool(pool);
        else operation.cancel();
      },
      () => {},
    );
    pump(pool);
    return { messageId, result };
  }
  function push(message: Message): Dispatch {
    if (closed) return dispatch(undefined, message, "");
    const current = options.settings();
    const servers = structuredClone(current.smtp).filter((s) => s.enabled);
    reconcile(servers);
    let bucket =
      message.messenger && message.messenger !== "email"
        ? servers.filter((s) => s.name === message.messenger)
        : servers.filter((s) => !s.exclude_from_default);
    if (!message.messenger || message.messenger === "email") {
      const from = bareAddress(message.from);
      const exact = bucket.filter((s) => (s.from_addresses ?? []).includes(from));
      const domain = from.split("@").at(-1);
      const domains = bucket.filter((s) => domain && (s.from_addresses ?? []).includes(domain));
      bucket = exact.length ? exact : domains.length ? domains : bucket;
    }
    const index = bucket.length ? selection(bucket.length) : -1;
    return dispatch(bucket[index], message, current.rootUrl);
  }
  return {
    push,
    test: (server: SMTPServer, message: Message, rootUrl: string) =>
      dispatch(structuredClone(server), message, rootUrl, true),
    close() {
      if (closing) return closing;
      closed = true;
      for (const pool of pools.values()) retire(pool);
      pools.clear();
      const draining = [...retired];
      const timer = new AbortController();
      closing = (async () => {
        const timeout = options.clock.sleep(5000, timer.signal).then(
          () => {
            for (const pool of draining) if (retired.has(pool)) cancelPool(pool);
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
