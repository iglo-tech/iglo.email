// Native (15-external-sources sections 1 and 9, D169, D170): the PocketBase adapter of
// `ExternalSource`. It signs in to the configured auth collection with the service account, reads
// the events collection and the recipients view over PocketBase's REST API, and classifies every
// failure as transient or permanent. Each request goes through the private-address guard
// (src/sources/connect.ts) and has its own time limit on the injected clock; a response body is
// read up to a fixed size. B150b adds the realtime stream beside this file.
import type { Clock } from "@/clock";
import { guardedFetch, refusedMessage } from "@/sources/connect";
import type { Guard, SourceTransport } from "@/sources/connect";
import {
  dateLiteral,
  fieldName,
  jsonPath,
  parseSourceDate,
  scalarLiteral,
  textLiteral,
} from "@/sources/filter";
import { isSourceList, isSourceObject, member, sourceJson } from "@/sources/json";
import type { SourceJson, SourceObject } from "@/sources/json";
import {
  DEFAULT_TIMEOUT_MS,
  isSourceError,
  PAGE_LIMIT,
  SCAN_LIMIT,
  SourceError,
} from "@/sources/source";
import { streamReads } from "@/sources/stream-reads";
import type {
  CallOptions,
  EventQuery,
  ExternalSource,
  ScanField,
  ScannedEvent,
  SourceEvent,
  SourceRecipient,
} from "@/sources/source";

/** The source settings the adapter reads (src/sources/settings.ts builds it from `source.*`). */
export interface PocketBaseConfig {
  /** The base URL, without a trailing slash. */
  url: string;
  authCollection: string;
  identity: string;
  password: string;
  events: {
    collection: string;
    user: string;
    name: string;
    data: string;
    occurredAt: string;
    /** "" when the collection has no idempotency key field. */
    key: string;
  };
  recipients: {
    collection: string;
    email: string;
    /** "" when the view has no name field. */
    name: string;
    /** "" when the view has no opt-out field. */
    optOut: string;
  };
  users: {
    /** "" when no users collection is watched for leaving. */
    collection: string;
    leavingFilter: string;
  };
}

export interface PocketBaseOptions {
  config: PocketBaseConfig;
  clock: Clock;
  guard: Guard;
  transport?: SourceTransport;
  /** The largest response body read, in bytes (default 32 MiB). */
  maxResponseBytes?: number;
}

/** A record ID or user ID the adapter puts into a path or a filter. */
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Without an expiry the source states, a token is renewed after this long. */
const FALLBACK_TOKEN_MS = 60_000;
/** The most names one query compares with. */
const MAX_NAMES = 100;

/** One answer: its status and JSON body, or `tooLarge` for a body over the size limit. */
interface Answer {
  status: number;
  body: SourceJson | undefined;
  date: string | null;
  tooLarge: boolean;
}
type Page = { items: ReadonlyArray<SourceObject> } | { tooLarge: true };
/** A read's result and the token it was sent with: an absent result is checked against that token. */
interface Read<T> {
  value: T;
  used: string;
}

/**
 * B166 (D194): a permanent failure that is the record's own, not the settings': an answer over the
 * response limit, a body the adapter cannot read (not JSON, not a record), or a mapped field of the
 * record that is not of its type. Every other permanent failure of a read (a refused address, a
 * redirect, a `401` after signing in again, a record with no `id`) is the configuration's.
 */
export class RecordUnreadable extends SourceError {
  readonly recordUnreadable = true;
}
export const isRecordUnreadable = (error: unknown): error is RecordUnreadable =>
  isSourceError(error) && "recordUnreadable" in error && error.recordUnreadable === true;

const tooLargeError = () =>
  new RecordUnreadable("permanent", "A source response is larger than the response limit");

/** Whether a recipients-view value means "opted out": set, and not false, 0, "", "0" or "false". */
export function optedOut(value: SourceJson | undefined): boolean {
  return !(
    value === null ||
    value === undefined ||
    value === false ||
    value === 0 ||
    value === "" ||
    value === "0" ||
    value === "false"
  );
}

/** The seconds-since-epoch expiry of a JWT, or undefined. */
function tokenExpiry(token: string): number | undefined {
  try {
    const payload = Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf-8");
    const expiry = member(sourceJson(JSON.parse(payload)), "exp");
    return typeof expiry === "number" && Number.isFinite(expiry) ? expiry : undefined;
  } catch {
    return undefined;
  }
}

/**
 * B155d (D179): an ID PocketBase cannot have, refused before any request. It is permanent like any
 * malformed read, and marked so a caller can tell "no such user can exist in the source" (an
 * `external_id` set by pushed events before the project moved to a source) from a failed read.
 */
export class NotSourceId extends SourceError {
  readonly notSourceId = true;
  constructor(id: string, what: string) {
    super("permanent", `Not a source ${what} ID: ${JSON.stringify(id)}`);
  }
}
export const isNotSourceId = (error: unknown): error is NotSourceId =>
  isSourceError(error) && "notSourceId" in error && error.notSourceId === true;

function checkedId(id: string, what: string): string {
  if (!idPattern.test(id)) {
    throw new NotSourceId(id, what);
  }
  return id;
}

/** The message PocketBase gave, kept short. */
function reason(answer: Answer): string {
  const message = member(answer.body, "message");
  return typeof message === "string" ? message.slice(0, 200) : "";
}

/** A non-2xx answer as an error: 429 and 5xx are transient, the rest permanent. */
function failure(answer: Answer, what: string): SourceError {
  if (answer.tooLarge) {
    return tooLargeError();
  }
  const kind = answer.status === 429 || answer.status >= 500 ? "transient" : "permanent";
  const detail = reason(answer);
  return new SourceError(
    kind,
    `The source refused ${what}: ${answer.status}${detail ? ` ${detail}` : ""}`,
    answer.status,
  );
}

/** A field of a record; a missing one is a permanent failure (a renamed or removed field). */
function has(record: SourceObject, field: string, collection: string): SourceJson {
  const value = member(record, field);
  if (value === undefined) {
    throw new SourceError(
      "permanent",
      `The source's ${collection} records have no field ${JSON.stringify(field)}`,
    );
  }
  return value;
}

function idOf(record: SourceObject): string {
  const id = member(record, "id");
  if (typeof id !== "string") {
    throw new SourceError("permanent", "A source record has no id");
  }
  return id;
}

/** The records of a page, or the permanent failure of a page too large to read. */
function itemsOf(page: Page): ReadonlyArray<SourceObject> {
  if ("tooLarge" in page) {
    throw tooLargeError();
  }
  return page.items;
}

const textOf = (value: SourceJson) => (typeof value === "string" ? value : "");

/** Reads a body up to `limit` bytes; `undefined` past it. */
async function readBody(response: Response, limit: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** A rejection once `signal` aborts, with its reason. */
function abortion(signal: AbortSignal): Promise<never> {
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  aborted.catch(() => {});
  return aborted;
}

export function createPocketBaseSource(options: PocketBaseOptions) {
  const { config, clock, guard } = options;
  const transport = options.transport ?? {};
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const base = new URL(config.url.endsWith("/") ? config.url : `${config.url}/`);
  const authCollection = fieldName(config.authCollection);
  const ev = {
    collection: fieldName(config.events.collection),
    user: fieldName(config.events.user),
    name: fieldName(config.events.name),
    data: fieldName(config.events.data),
    occurredAt: fieldName(config.events.occurredAt),
    key: config.events.key ? fieldName(config.events.key) : "",
  };
  const rc = {
    collection: fieldName(config.recipients.collection),
    email: fieldName(config.recipients.email),
    name: config.recipients.name ? fieldName(config.recipients.name) : "",
    optOut: config.recipients.optOut ? fieldName(config.recipients.optOut) : "",
  };

  let token = "";
  let renewAt = 0;
  let signingIn: Promise<string> | undefined;

  /**
   * One HTTP request under the guard and the time limit. A refused address and a body that is
   * not JSON are permanent; network failures and the time limit are transient; a caller's abort
   * rejects with its reason.
   */
  async function send(
    method: "GET" | "POST",
    path: string,
    authorization: string,
    body: string | undefined,
    call: CallOptions,
  ): Promise<Answer> {
    call.signal?.throwIfAborted();
    const timer = new AbortController();
    let timedOut = false;
    void clock.sleep(call.timeoutMs ?? DEFAULT_TIMEOUT_MS, timer.signal).then(
      () => {
        timedOut = true;
        timer.abort(new Error("timeout"));
      },
      () => {},
    );
    const signal = call.signal ? AbortSignal.any([call.signal, timer.signal]) : timer.signal;
    const headers = new Headers({ Accept: "application/json", "User-Agent": "iglo.email" });
    if (authorization) {
      headers.set("Authorization", authorization);
    }
    const init: RequestInit = { method, signal, headers };
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = body;
    }
    /** A failure on the way: the caller's abort as it is, else transient. */
    const lost = (error: unknown): SourceError => {
      call.signal?.throwIfAborted();
      return new SourceError(
        "transient",
        timedOut
          ? "The source did not answer in time"
          : `The source is unreachable: ${String(error)}`,
      );
    };
    // A resolver cannot be cancelled, so each wait races the signal.
    const aborted = abortion(signal);
    let text: string | undefined;
    let status: number;
    let date: string | null;
    try {
      let outcome: Response | { refused: string };
      try {
        outcome = await Promise.race([
          guardedFetch(new URL(path, base), init, guard, transport),
          aborted,
        ]);
      } catch (error) {
        throw lost(error);
      }
      if (!("status" in outcome)) {
        throw new SourceError("permanent", refusedMessage(outcome.refused));
      }
      status = outcome.status;
      date = outcome.headers.get("date");
      try {
        text = await Promise.race([readBody(outcome, maxBytes), aborted]);
      } catch (error) {
        throw lost(error);
      }
    } finally {
      timer.abort();
    }
    if (text === undefined) {
      return { status, body: undefined, date, tooLarge: true };
    }
    let parsed: SourceJson | undefined;
    if (text) {
      try {
        parsed = sourceJson(JSON.parse(text));
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined && status >= 200 && status < 300) {
        throw new RecordUnreadable(
          "permanent",
          `The source answered ${path.split("?", 1)[0]} with a body that is not JSON`,
          status,
        );
      }
    }
    return { status, body: parsed ?? null, date, tooLarge: false };
  }

  /** Keeps a token and when to renew it: half way to the expiry the source states. */
  function accept(next: string, date: string | null) {
    token = next;
    const expiry = tokenExpiry(next);
    const serverNow = date ? Date.parse(date) : Number.NaN;
    const left =
      expiry !== undefined && Number.isFinite(serverNow) ? expiry * 1000 - serverNow : Number.NaN;
    renewAt = clock.now().getTime() + (left > 0 ? left / 2 : FALLBACK_TOKEN_MS);
  }

  /**
   * B163 (D191): waits for work shared by concurrent callers on this caller's own signal and time
   * limit. The shared work runs on the adapter's own time limit and no caller's signal, so one
   * caller's abort or timeout rejects only that caller: an abort with its reason, a timeout as the
   * transient failure `send` gives. The shared work's own failure reaches every caller as it is.
   */
  async function joined<T>(shared: Promise<T>, call: CallOptions): Promise<T> {
    call.signal?.throwIfAborted();
    const timer = new AbortController();
    const timeout = new Error("timeout");
    void clock.sleep(call.timeoutMs ?? DEFAULT_TIMEOUT_MS, timer.signal).then(
      () => timer.abort(timeout),
      () => {},
    );
    const signal = call.signal ? AbortSignal.any([call.signal, timer.signal]) : timer.signal;
    try {
      return await Promise.race([shared, abortion(signal)]);
    } catch (error) {
      if (error === timeout) {
        throw new SourceError("transient", "The source did not answer in time");
      }
      throw error;
    } finally {
      timer.abort();
    }
  }

  /**
   * Signs in with the service account; one sign-in runs at a time, shared by every caller that
   * needs one meanwhile, and each caller waits for it on its own signal and time limit.
   */
  function signIn(call: CallOptions): Promise<string> {
    // An aborted caller starts nothing.
    call.signal?.throwIfAborted();
    if (!signingIn) {
      signingIn = (async () => {
        try {
          const answer = await send(
            "POST",
            `api/collections/${authCollection}/auth-with-password`,
            "",
            JSON.stringify({ identity: config.identity, password: config.password }),
            {},
          );
          const next = member(answer.body, "token");
          if (answer.status !== 200 || typeof next !== "string") {
            throw failure(answer, "the service account's sign-in");
          }
          accept(next, answer.date);
          return token;
        } finally {
          signingIn = undefined;
        }
      })();
      // Callers get its failure through `joined`; with none left waiting it must not go unhandled.
      signingIn.catch(() => {});
    }
    return joined(signingIn, call);
  }

  async function currentToken(call: CallOptions): Promise<string> {
    if (token && clock.now().getTime() < renewAt) {
      return token;
    }
    return signIn(call);
  }

  /** Drops `used` as the held token, unless another caller has replaced it already. */
  function drop(used: string) {
    if (token === used) {
      token = "";
    }
  }

  /**
   * Whether the token `used` is still accepted. PocketBase reads an invalid token as a guest, so
   * an empty answer proves nothing until this succeeds (401 means the token was not valid). A
   * token superseded by a newer one is still valid and passes. Each check sends its own request
   * on the caller's signal and time limit and is never shared: a `200` proves only reads that had
   * finished before the check was sent (D170, D191).
   */
  async function confirm(used: string, call: CallOptions): Promise<boolean> {
    if (!used) {
      return false;
    }
    const answer = await send(
      "POST",
      `api/collections/${authCollection}/auth-refresh`,
      used,
      undefined,
      call,
    );
    if (answer.status === 401 || answer.status === 403 || answer.status === 404) {
      drop(used);
      return false;
    }
    const next = member(answer.body, "token");
    if (answer.status !== 200 || typeof next !== "string") {
      throw failure(answer, "the token check");
    }
    // A token another caller got meanwhile is as good, so it is kept.
    if (token === used) {
      accept(next, answer.date);
    }
    return true;
  }

  /** An authenticated GET and the token it used; a 401 or 403 signs in again and repeats it once. */
  async function get(path: string, call: CallOptions): Promise<Read<Answer>> {
    const first = await currentToken(call);
    const answer = await send("GET", path, first, undefined, call);
    if (answer.status !== 401 && answer.status !== 403) {
      return { value: answer, used: first };
    }
    drop(first);
    const used = await currentToken(call);
    return { value: await send("GET", path, used, undefined, call), used };
  }

  /**
   * Runs `read`; an absent answer counts only once the token that read was sent with passes the
   * check, whether or not it is still the held token (a token superseded by a renewal is still
   * valid; a revoked one gets 401). When it does not pass, it reads once more with the current
   * token and checks that answer the same way. A second unconfirmed absent answer is transient.
   */
  async function confirmed<T>(
    read: () => Promise<Read<T>>,
    absent: (value: T) => boolean,
    call: CallOptions,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const { value, used } = await read();
      if (!absent(value) || (await confirm(used, call))) {
        return value;
      }
      if (attempt > 0) {
        throw new SourceError(
          "transient",
          "The source did not confirm the service account's token for an empty answer",
        );
      }
    }
  }

  /** One page of a collection's records, or `tooLarge`. */
  async function list(
    collection: string,
    params: { filter: string; sort: string; perPage: number; fields?: Array<string> },
    call: CallOptions,
  ): Promise<Read<Page>> {
    const search = new URLSearchParams({
      page: "1",
      perPage: String(params.perPage),
      skipTotal: "1",
      sort: params.sort,
      filter: params.filter,
    });
    if (params.fields) {
      search.set("fields", params.fields.join(","));
    }
    const { value: answer, used } = await get(
      `api/collections/${collection}/records?${search}`,
      call,
    );
    if (answer.tooLarge) {
      return { value: { tooLarge: true }, used };
    }
    if (answer.status !== 200) {
      throw failure(answer, `a read of ${collection}`);
    }
    const items = member(answer.body, "items");
    if (!isSourceList(items) || !items.every(isSourceObject)) {
      throw new SourceError("permanent", `The source's ${collection} list has no items`);
    }
    return { value: { items }, used };
  }

  /** The filter of a query, or `null` for a query that matches nothing. */
  function compile(query: EventQuery): string | null {
    const parts = [`${ev.occurredAt} != ''`];
    if (query.user !== undefined) {
      parts.push(`${ev.user} = ${textLiteral(checkedId(query.user, "user"))}`);
    }
    if (query.names !== undefined) {
      if (!query.names.length) {
        return null;
      }
      if (query.names.length > MAX_NAMES) {
        throw new SourceError("permanent", `A source query compares at most ${MAX_NAMES} names`);
      }
      parts.push(
        `(${query.names.map((name) => `${ev.name} = ${textLiteral(name)}`).join(" || ")})`,
      );
    }
    if (query.after) {
      parts.push(`${ev.occurredAt} > ${dateLiteral(query.after)}`);
    }
    if (query.through) {
      parts.push(`${ev.occurredAt} <= ${dateLiteral(query.through)}`);
    }
    for (const [path, value] of Object.entries(query.data ?? {})) {
      parts.push(`${jsonPath(ev.data, path)} = ${scalarLiteral(value)}`);
    }
    return parts.join(" && ");
  }

  function userOf(record: SourceObject): string {
    const value = has(record, ev.user, ev.collection);
    const user = isSourceList(value) ? value[0] : value;
    if (typeof user !== "string") {
      throw new SourceError("permanent", `The source's ${ev.user} field is not a relation`);
    }
    return user;
  }

  function occurredOf(record: SourceObject): Date {
    const date = parseSourceDate(has(record, ev.occurredAt, ev.collection));
    if (!date) {
      throw new SourceError(
        "permanent",
        `The source's events record ${idOf(record)} has no ${ev.occurredAt}`,
      );
    }
    return date;
  }

  function eventOf(record: SourceObject): SourceEvent {
    const created = parseSourceDate(has(record, "created", ev.collection));
    if (!created) {
      throw new SourceError("permanent", "The source's events records have no created date");
    }
    return {
      id: idOf(record),
      user: userOf(record),
      name: textOf(has(record, ev.name, ev.collection)),
      data: has(record, ev.data, ev.collection),
      occurredAt: occurredOf(record),
      key: ev.key ? textOf(has(record, ev.key, ev.collection)) : "",
      created,
    };
  }

  function scannedOf(record: SourceObject, fields: ReadonlyArray<ScanField>): ScannedEvent {
    const out: ScannedEvent = { id: idOf(record), occurredAt: occurredOf(record) };
    if (fields.includes("user")) {
      out.user = userOf(record);
    }
    if (fields.includes("name")) {
      out.name = textOf(has(record, ev.name, ev.collection));
    }
    if (fields.includes("data")) {
      out.data = has(record, ev.data, ev.collection);
    }
    if (fields.includes("key")) {
      out.key = ev.key ? textOf(has(record, ev.key, ev.collection)) : "";
    }
    return out;
  }

  const mappedField: Record<ScanField, () => string> = {
    user: () => ev.user,
    name: () => ev.name,
    data: () => ev.data,
    key: () => ev.key,
  };

  async function* scan(
    query: EventQuery,
    fields: ReadonlyArray<ScanField>,
    limit: number,
    call: CallOptions = {},
  ): AsyncGenerator<ReadonlyArray<ScannedEvent>, void, void> {
    const cap = Math.min(Math.max(0, Math.floor(limit)), SCAN_LIMIT);
    const filter = compile(query);
    if (!cap || filter === null) {
      return;
    }
    const wanted = [
      "id",
      ev.occurredAt,
      ...fields.flatMap((field) => {
        const name = mappedField[field]();
        return name ? [name] : [];
      }),
    ];
    let last: { at: string; id: string } | undefined;
    let read = 0;
    let size = PAGE_LIMIT;
    while (read < cap) {
      const perPage = Math.min(size, cap - read);
      const keyset = last
        ? ` && (${ev.occurredAt} > ${textLiteral(last.at)} || (${ev.occurredAt} = ${textLiteral(last.at)} && id > ${textLiteral(last.id)}))`
        : "";
      const page = await confirmed(
        () =>
          list(
            ev.collection,
            { filter: `${filter}${keyset}`, sort: `${ev.occurredAt},id`, perPage, fields: wanted },
            call,
          ),
        (answer) => !("tooLarge" in answer) && answer.items.length < perPage,
        call,
      );
      // A page too large to hold is read again in smaller pages, down to one record. B166 (D194):
      // smaller than the page just sent, so a short last page (an `exists`) is not sent again as is.
      if ("tooLarge" in page && perPage > 1) {
        size = Math.max(1, Math.floor(perPage / 4));
        continue;
      }
      const items = itemsOf(page);
      const rows = items.map((item) => scannedOf(item, fields));
      if (rows.length) {
        yield rows;
      }
      read += rows.length;
      const tail = items.at(-1);
      if (rows.length < perPage || !tail) {
        return;
      }
      last = { at: textOf(has(tail, ev.occurredAt, ev.collection)), id: idOf(tail) };
    }
  }

  /**
   * One record by ID, or `null`. A 404 is confirmed twice: the token is checked (a guest reads a
   * 404 too), and the collection is listed, since a missing collection is a 404 as well.
   */
  async function one(collection: string, id: string, call: CallOptions) {
    const what = `a read of ${collection}`;
    const row = await confirmed(
      async () => {
        const { value: answer, used } = await get(
          `api/collections/${collection}/records/${id}`,
          call,
        );
        if (answer.status === 404 && !answer.tooLarge) {
          return { value: null, used };
        }
        if (answer.status === 200 && !answer.tooLarge && !isSourceObject(answer.body)) {
          throw new RecordUnreadable(
            "permanent",
            `The source answered ${what} with no record`,
            200,
          );
        }
        if (answer.status !== 200 || !isSourceObject(answer.body)) {
          throw failure(answer, what);
        }
        return { value: answer.body, used };
      },
      (value) => value === null,
      call,
    );
    if (row === null) {
      const search = new URLSearchParams({ page: "1", perPage: "1", skipTotal: "1", fields: "id" });
      const { value: answer } = await get(`api/collections/${collection}/records?${search}`, call);
      if (answer.status !== 200) {
        throw failure(answer, what);
      }
    }
    return row;
  }

  const source = {
    async recipient(externalId: string, call: CallOptions = {}): Promise<SourceRecipient | null> {
      const row = await one(rc.collection, checkedId(externalId, "user"), call);
      if (!row) {
        return null;
      }
      const email = has(row, rc.email, rc.collection);
      if (typeof email !== "string") {
        throw new RecordUnreadable("permanent", `The source's ${rc.email} field is not text`);
      }
      return {
        id: idOf(row),
        email,
        name: rc.name ? textOf(has(row, rc.name, rc.collection)) : "",
        optOut: rc.optOut ? optedOut(has(row, rc.optOut, rc.collection)) : false,
        fields: row,
      };
    },
    async record(id: string, call: CallOptions = {}): Promise<SourceEvent | null> {
      const row = await one(ev.collection, checkedId(id, "record"), call);
      return row ? eventOf(row) : null;
    },
    async latest(query: EventQuery, call: CallOptions = {}): Promise<SourceEvent | null> {
      const filter = compile(query);
      if (filter === null) {
        return null;
      }
      const items = itemsOf(
        await confirmed(
          () => list(ev.collection, { filter, sort: `-${ev.occurredAt},-id`, perPage: 1 }, call),
          (page) => !("tooLarge" in page) && page.items.length === 0,
          call,
        ),
      );
      const [first] = items;
      return first ? eventOf(first) : null;
    },
    async count(query: EventQuery, upTo: number, call: CallOptions = {}): Promise<number> {
      let total = 0;
      for await (const page of scan(query, [], upTo, call)) {
        total += page.length;
      }
      return total;
    },
    async exists(query: EventQuery, call: CallOptions = {}): Promise<boolean> {
      return (await source.count(query, 1, call)) > 0;
    },
    scan,
    /** Signs in now (the settings check). */
    async authenticate(call: CallOptions = {}): Promise<void> {
      call.signal?.throwIfAborted();
      token = "";
      await signIn(call);
    },
    /**
     * One page of a collection read with a filter, for the settings check: the status, the number
     * of rows and PocketBase's message.
     */
    async probe(
      collection: string,
      filter: string,
      call: CallOptions = {},
    ): Promise<{ status: number; rows: number; message: string }> {
      const search = new URLSearchParams({ page: "1", perPage: "1", skipTotal: "1", filter });
      const { value: answer } = await get(
        `api/collections/${fieldName(collection)}/records?${search}`,
        call,
      );
      const items = member(answer.body, "items");
      return {
        status: answer.status,
        rows: isSourceList(items) ? items.length : 0,
        message: reason(answer),
      };
    },
    /**
     * D172: one page of a collection read as a guest (no token), for the settings check: the
     * status and the number of rows. The events and recipients collections must not be readable by
     * guests, because a revoked token reads as a guest and only short answers are confirmed.
     */
    async guestProbe(
      collection: string,
      call: CallOptions = {},
    ): Promise<{ status: number; rows: number }> {
      const search = new URLSearchParams({ page: "1", perPage: "1", skipTotal: "1", fields: "id" });
      const answer = await send(
        "GET",
        `api/collections/${fieldName(collection)}/records?${search}`,
        "",
        undefined,
        call,
      );
      const items = member(answer.body, "items");
      return { status: answer.status, rows: isSourceList(items) ? items.length : 0 };
    },
    /** The realtime stream's reads and subscription (src/sources/stream-reads.ts, B150b). */
    stream: streamReads({
      events: ev,
      users: config.users,
      eventOf,
      async page(collection, params, call) {
        const page = await confirmed(
          () => list(collection, params, call),
          (answer) => !("tooLarge" in answer) && answer.items.length < params.perPage,
          call,
        );
        return "tooLarge" in page ? null : page.items;
      },
      // A subscription sent with a revoked token is a guest's, which PocketBase accepts and then
      // sends nothing the rules hide: the token is confirmed after every accepted subscription.
      async realtime(body, call) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const used = await currentToken(call);
          const answer = await send("POST", "api/realtime", used, body, call);
          if (answer.status === 204 || answer.status === 200) {
            if (await confirm(used, call)) {
              return;
            }
          } else if (answer.status === 404) {
            throw new SourceError("transient", "The realtime connection is gone", 404);
          } else if (answer.status === 401 || (answer.status === 403 && attempt === 0)) {
            drop(used);
          } else {
            throw failure(answer, "the realtime subscription");
          }
        }
        throw new SourceError(
          "transient",
          "The source did not confirm the service account's token for the subscription",
        );
      },
    }),
  } satisfies ExternalSource & {
    authenticate: unknown;
    probe: unknown;
    guestProbe: unknown;
    stream: unknown;
  };
  return source;
}
export type PocketBaseSource = ReturnType<typeof createPocketBaseSource>;
