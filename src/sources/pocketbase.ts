// Native (15-external-sources sections 1 and 9, D169, D170): the PocketBase adapter of
// `ExternalSource`. It signs in to the configured auth collection with the service account, reads
// the events collection and the recipients view over PocketBase's REST API, and classifies every
// failure as transient or permanent. Each request goes through the private-address guard
// (src/sources/connect.ts) and has its own time limit on the injected clock; a response body is
// read up to a fixed size. B150b adds the realtime stream beside this file.
import type { Clock } from "@/clock";
import { guardedFetch } from "@/sources/connect";
import type { Guard, SourceTransport } from "@/sources/connect";
import {
  dateLiteral,
  fieldName,
  jsonPath,
  parseSourceDate,
  scalarLiteral,
  textLiteral,
  UnfitQuery,
} from "@/sources/filter";
import { isSourceList, isSourceObject, member, sourceJson } from "@/sources/json";
import type { SourceJson, SourceObject } from "@/sources/json";
import {
  DEFAULT_TIMEOUT_MS,
  isRecordUnreadable,
  isSourceError,
  PAGE_LIMIT,
  RecordUnreadable,
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
/**
 * B166 (D194): PocketBase 0.40.5 refuses a filter longer than 3,500 bytes with a `400` (measured:
 * 3,034 bytes read, 3,534 refused). `data` parts are written only while the filter stays within
 * this, which leaves room for `scan`'s keyset condition (three field names of up to 100 characters,
 * two dates and an ID of up to 100 characters).
 */
const DATA_FILTER_LIMIT = 3500 - 600;

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

const TOO_LARGE = "A source response is larger than the response limit";
const recordTooLarge = () => new RecordUnreadable("permanent", TOO_LARGE);

/**
 * B166 (D194): runs a request that reads no record (a sign-in, a token check, a collection probe,
 * a realtime subscription): JSON nested too deep there is the configuration's failure, never one
 * unreadable record. (A body that is not JSON is the configuration's on every path already.)
 */
async function notRecord<T>(request: Promise<T>, what: string): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (isRecordUnreadable(error)) {
      throw new SourceError("permanent", `The source answered ${what} with JSON nested too deep`);
    }
    throw error;
  }
}

/**
 * B166 (D194): the service account's sign-in or token check refused for good (a wrong or rotated
 * password, a removed account or auth collection, a page that is not JSON). PocketBase 0.40.5
 * answers a refused sign-in with a `400` ("Failed to authenticate."), the status a refused filter
 * also has, so the mark, not the status, tells a caller the settings are at fault.
 */
export class AuthRefused extends SourceError {
  readonly authRefused = true;
}
export const isAuthRefused = (error: unknown): error is AuthRefused =>
  isSourceError(error) && "authRefused" in error && error.authRefused === true;

/** Throws a permanent failure of the sign-in or token check as `AuthRefused`, anything else as is. */
function refuseAuth(error: unknown): never {
  if (isSourceError(error) && error.kind === "permanent" && !isAuthRefused(error)) {
    throw new AuthRefused("permanent", error.message, error.status);
  }
  throw error;
}

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

/**
 * An answer that is not the one wanted as an error: a 2xx too large to read is permanent; else 429
 * and 5xx are transient, the rest permanent. B166 (D194): only a 2xx can be too large to read, so a
 * large error page (a proxy's 502, 429 or 403) is that status's failure.
 */
function failure(answer: Answer, what: string): SourceError {
  if (answer.tooLarge && answer.status >= 200 && answer.status < 300) {
    return new SourceError("permanent", `${TOO_LARGE} (${what})`);
  }
  const kind = answer.status === 429 || answer.status >= 500 ? "transient" : "permanent";
  const detail = reason(answer);
  return new SourceError(
    kind,
    `The source refused ${what}: ${answer.status}${detail ? ` ${detail}` : ""}`,
    answer.status,
  );
}

/**
 * B169 (D197): the rows of a settings-check probe's answer (an `id` read of no record). A `200`
 * too large to read, or one that is no PocketBase list (a proxy's `{}` or empty body), is not the
 * source answering: a permanent failure, as `list()` and `eventsSchema()` treat it. Any other
 * status has no rows; the caller reports it.
 */
function probeRows(answer: Answer, collection: string, what: string): number {
  if (answer.status !== 200) {
    return 0;
  }
  if (answer.tooLarge) {
    throw failure(answer, what);
  }
  const items = member(answer.body, "items");
  if (!isSourceList(items) || !items.every(isSourceObject)) {
    throw new SourceError("permanent", `The source's ${collection} list has no items`);
  }
  return items.length;
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

/**
 * The records of a page, or the permanent failure of a page too large to read. Every caller has
 * narrowed the page to one record first (`latest`, `scan` down to `perPage=1`), so it is that
 * record's own failure.
 */
function itemsOf(page: Page): ReadonlyArray<SourceObject> {
  if ("tooLarge" in page) {
    throw recordTooLarge();
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

/**
 * The parsed text (`json` undefined when it nests deeper than the JSON limit), or `undefined` when
 * it is not JSON.
 */
function parseText(text: string): { json: SourceJson | undefined } | undefined {
  try {
    return { json: sourceJson(JSON.parse(text)) };
  } catch {
    return undefined;
  }
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
      let outcome: Response | { refused: string; message: string };
      try {
        outcome = await Promise.race([
          guardedFetch(new URL(path, base), init, guard, transport),
          aborted,
        ]);
      } catch (error) {
        throw lost(error);
      }
      if (!("status" in outcome)) {
        throw new SourceError("permanent", outcome.message);
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
      const ok = status >= 200 && status < 300;
      const where = path.split("?", 1)[0];
      const json = parseText(text);
      if (!json && ok) {
        // B166 (D194): PocketBase answers JSON on every path, so a 2xx page that is not JSON (a
        // proxy's, maintenance or sign-in page) is the configuration's on every read, never a
        // record's.
        throw new SourceError(
          "permanent",
          `The source answered ${where} with a body that is not JSON`,
        );
      }
      parsed = json ? json.json : null;
      if (parsed === undefined && ok) {
        // Valid JSON nested too deep comes from a record's own data: a read of no record strips
        // the mark (`notRecord`), and the stream narrows a page to the record (D177).
        throw new RecordUnreadable(
          "permanent",
          `The source answered ${where} with JSON nested deeper than 64 levels`,
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
          const answer = await notRecord(
            send(
              "POST",
              `api/collections/${authCollection}/auth-with-password`,
              "",
              JSON.stringify({ identity: config.identity, password: config.password }),
              {},
            ),
            "the service account's sign-in",
          );
          const next = member(answer.body, "token");
          if (answer.status !== 200 || typeof next !== "string") {
            throw failure(answer, "the service account's sign-in");
          }
          accept(next, answer.date);
          return token;
        } catch (error) {
          refuseAuth(error);
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
    const answer = await notRecord(
      send("POST", `api/collections/${authCollection}/auth-refresh`, used, undefined, call),
      "the token check",
    ).catch(refuseAuth);
    if (answer.status === 401 || answer.status === 403 || answer.status === 404) {
      drop(used);
      return false;
    }
    const next = member(answer.body, "token");
    if (answer.status !== 200 || typeof next !== "string") {
      refuseAuth(failure(answer, "the token check"));
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
    // B166 (D194): only a `200` page can be too large to read; a large error page (a proxy's 403,
    // 404 or 502) is that status's failure (`failure`).
    if (answer.status !== 200) {
      throw failure(answer, `a read of ${collection}`);
    }
    if (answer.tooLarge) {
      return { value: { tooLarge: true }, used };
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
        throw new UnfitQuery(`A source query compares at most ${MAX_NAMES} names`);
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
    // B166 (D194): `data` is a narrowing the caller checks again on the rows, so a part that would
    // take the filter past PocketBase's limit is left out rather than sent to be refused.
    let length = Buffer.byteLength(parts.join(" && "));
    for (const [path, value] of Object.entries(query.data ?? {})) {
      const part = `${jsonPath(ev.data, path)} = ${scalarLiteral(value)}`;
      const next = length + 4 + Buffer.byteLength(part);
      if (next <= DATA_FILTER_LIMIT) {
        parts.push(part);
        length = next;
      }
    }
    return parts.join(" && ");
  }

  function userOf(record: SourceObject): string {
    const value = has(record, ev.user, ev.collection);
    const user = isSourceList(value) ? value[0] : value;
    if (typeof user !== "string") {
      throw new RecordUnreadable("permanent", `The source's ${ev.user} field is not a relation`);
    }
    return user;
  }

  function occurredOf(record: SourceObject): Date {
    const date = parseSourceDate(has(record, ev.occurredAt, ev.collection));
    if (!date) {
      throw new RecordUnreadable(
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
        // B166 (D194): JSON nested too deep is this record's own (`RecordUnreadable` from `send`;
        // a sign-in strips the mark); a body that is not JSON, or JSON that is no record, is the
        // configuration's (a proxy's page, another service at the URL).
        const { value: answer, used } = await get(
          `api/collections/${collection}/records/${id}`,
          call,
        );
        if (answer.status === 404 && !answer.tooLarge) {
          return { value: null, used };
        }
        if (answer.status === 200 && answer.tooLarge) {
          throw recordTooLarge();
        }
        if (answer.status === 200 && !isSourceObject(answer.body)) {
          throw new SourceError("permanent", `The source answered ${what} with no record`);
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
      // The collection probe: any failure of it, a page nested too deep or too large included,
      // is the configuration's (B166, D194).
      const search = new URLSearchParams({ page: "1", perPage: "1", skipTotal: "1", fields: "id" });
      const { value: answer } = await notRecord(
        get(`api/collections/${collection}/records?${search}`, call),
        what,
      );
      if (answer.status !== 200 || answer.tooLarge) {
        throw failure(answer, what);
      }
      // B168 (D196): a `200` that is no PocketBase list (a proxy's `{}` or empty body) does not
      // show the collection exists, so the `404` is not shown to be this record's: as `list()`
      // and `eventsSchema()`, a permanent failure (the settings'), never an absent record.
      const items = member(answer.body, "items");
      if (!isSourceList(items) || !items.every(isSourceObject)) {
        throw new SourceError("permanent", `The source's ${collection} list has no items`);
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
    /**
     * B166 (D194): the events collection's schema probe, for a trigger condition's `400`: one
     * `id` read with a filter naming every mapped field (`f = f`, as the settings check), so a
     * renamed field or a broken list rule fails it whatever rows the collection holds, and no
     * record is read (JSON nested too deep, a page too large or one that is not JSON is the
     * configuration's). Resolves when the source answers.
     */
    async eventsSchema(call: CallOptions = {}): Promise<void> {
      const what = `a read of ${ev.collection}`;
      const filter = [ev.user, ev.name, ev.data, ev.occurredAt, ev.key]
        .flatMap((field) => (field ? [`${field} = ${field}`] : []))
        .join(" && ");
      const search = new URLSearchParams({
        page: "1",
        perPage: "1",
        skipTotal: "1",
        fields: "id",
        filter,
      });
      const { value: answer } = await notRecord(
        get(`api/collections/${ev.collection}/records?${search}`, call),
        what,
      );
      if (answer.status !== 200 || answer.tooLarge) {
        throw failure(answer, what);
      }
      // B166 round 4 (D194): a `200` that is no PocketBase list (a proxy's `{}` or empty body) is
      // not the source answering, so the condition's `400` is not shown to be its own.
      // B171 (D199): and items that are not records, as every other list check.
      const items = member(answer.body, "items");
      if (!isSourceList(items) || !items.every(isSourceObject)) {
        throw new SourceError("permanent", `The source's ${ev.collection} list has no items`);
      }
    },
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
      // B169 (D197): IDs only, so a first record nested too deep or too large is not read.
      const search = new URLSearchParams({
        page: "1",
        perPage: "1",
        skipTotal: "1",
        fields: "id",
        filter,
      });
      const what = `a read of ${collection}`;
      const { value: answer } = await notRecord(
        get(`api/collections/${fieldName(collection)}/records?${search}`, call),
        what,
      );
      return {
        status: answer.status,
        rows: probeRows(answer, collection, what),
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
    ): Promise<{ status: number; rows: number; message: string }> {
      const search = new URLSearchParams({ page: "1", perPage: "1", skipTotal: "1", fields: "id" });
      const what = `a guest's read of ${collection}`;
      const answer = await notRecord(
        send(
          "GET",
          `api/collections/${fieldName(collection)}/records?${search}`,
          "",
          undefined,
          call,
        ),
        what,
      );
      return {
        status: answer.status,
        rows: probeRows(answer, collection, what),
        message: reason(answer),
      };
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
          const answer = await notRecord(
            send("POST", "api/realtime", used, body, call),
            "the realtime subscription",
          );
          if ((answer.status === 204 || answer.status === 200) && !answer.tooLarge) {
            if (await confirm(used, call)) {
              return;
            }
          } else if (answer.status === 404) {
            throw new SourceError("transient", "The realtime connection is gone", 404);
          } else if ((answer.status === 401 || answer.status === 403) && attempt === 0) {
            // B171 (D199): retried once with a fresh sign-in; a second 401 or 403 is that
            // status's permanent refusal, not a token the source did not confirm.
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
    eventsSchema: unknown;
    probe: unknown;
    guestProbe: unknown;
    stream: unknown;
  };
  return source;
}
export type PocketBaseSource = ReturnType<typeof createPocketBaseSource>;
