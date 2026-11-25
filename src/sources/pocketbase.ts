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
import { DEFAULT_TIMEOUT_MS, PAGE_LIMIT, SCAN_LIMIT, SourceError } from "@/sources/source";
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

const tooLargeError = () =>
  new SourceError("permanent", "A source response is larger than the response limit");

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

function checkedId(id: string, what: string): string {
  if (!idPattern.test(id)) {
    throw new SourceError("permanent", `Not a source ${what} ID: ${JSON.stringify(id)}`);
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
        throw new SourceError(
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

  /** Signs in with the service account; one sign-in runs at a time. */
  function signIn(call: CallOptions): Promise<string> {
    signingIn ??= (async () => {
      try {
        const answer = await send(
          "POST",
          `api/collections/${authCollection}/auth-with-password`,
          "",
          JSON.stringify({ identity: config.identity, password: config.password }),
          call,
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
    return signingIn;
  }

  async function currentToken(call: CallOptions): Promise<string> {
    if (token && clock.now().getTime() < renewAt) {
      return token;
    }
    return signIn(call);
  }

  /**
   * Whether the current token is still accepted. PocketBase reads an invalid token as a guest, so
   * an empty answer proves nothing until this succeeds (401 means the token was not valid).
   */
  async function confirm(call: CallOptions): Promise<boolean> {
    if (!token) {
      return false;
    }
    const answer = await send(
      "POST",
      `api/collections/${authCollection}/auth-refresh`,
      token,
      undefined,
      call,
    );
    if (answer.status === 401 || answer.status === 403 || answer.status === 404) {
      token = "";
      return false;
    }
    const next = member(answer.body, "token");
    if (answer.status !== 200 || typeof next !== "string") {
      throw failure(answer, "the token check");
    }
    accept(next, answer.date);
    return true;
  }

  /** An authenticated GET; a 401 or 403 signs in again and repeats it once. */
  async function get(path: string, call: CallOptions): Promise<Answer> {
    const first = await send("GET", path, await currentToken(call), undefined, call);
    if (first.status !== 401 && first.status !== 403) {
      return first;
    }
    token = "";
    return send("GET", path, await currentToken(call), undefined, call);
  }

  /**
   * Runs `read`; an absent answer is confirmed with the token check, and read once more after a
   * new sign-in when the token was no longer valid.
   */
  async function confirmed<T>(
    read: () => Promise<T>,
    absent: (value: T) => boolean,
    call: CallOptions,
  ): Promise<T> {
    const value = await read();
    if (!absent(value) || (await confirm(call))) {
      return value;
    }
    await signIn(call);
    return read();
  }

  /** One page of a collection's records, or `tooLarge`. */
  async function list(
    collection: string,
    params: { filter: string; sort: string; perPage: number; fields?: Array<string> },
    call: CallOptions,
  ): Promise<Page> {
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
    const answer = await get(`api/collections/${collection}/records?${search}`, call);
    if (answer.tooLarge) {
      return { tooLarge: true };
    }
    if (answer.status !== 200) {
      throw failure(answer, `a read of ${collection}`);
    }
    const items = member(answer.body, "items");
    if (!isSourceList(items) || !items.every(isSourceObject)) {
      throw new SourceError("permanent", `The source's ${collection} list has no items`);
    }
    return { items };
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
      // A page too large to hold is read again in smaller pages, down to one record.
      if ("tooLarge" in page && size > 1) {
        size = Math.max(1, Math.floor(size / 4));
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
        const answer = await get(`api/collections/${collection}/records/${id}`, call);
        if (answer.status === 404 && !answer.tooLarge) {
          return null;
        }
        if (answer.status !== 200 || !isSourceObject(answer.body)) {
          throw failure(answer, what);
        }
        return answer.body;
      },
      (value) => value === null,
      call,
    );
    if (row === null) {
      const search = new URLSearchParams({ page: "1", perPage: "1", skipTotal: "1", fields: "id" });
      const answer = await get(`api/collections/${collection}/records?${search}`, call);
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
        throw new SourceError("permanent", `The source's ${rc.email} field is not text`);
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
      const answer = await get(`api/collections/${fieldName(collection)}/records?${search}`, call);
      const items = member(answer.body, "items");
      return {
        status: answer.status,
        rows: isSourceList(items) ? items.length : 0,
        message: reason(answer),
      };
    },
  } satisfies ExternalSource & { authenticate: unknown; probe: unknown };
  return source;
}
export type PocketBaseSource = ReturnType<typeof createPocketBaseSource>;
