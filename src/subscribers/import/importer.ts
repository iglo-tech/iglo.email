// Adapted from listmonk internal/subimporter/importer.go at 6fcd95f. The upload stays on disk and
// is read twice in small chunks. The first pass validates the file, logs bad rows, counts lines
// and admits the webhook budget, so a bad file or one over budget writes nothing. The second pass
// writes short batches, each its own transaction, and gives way between them. An import is not
// durable: status and log live in memory as upstream's do, and nothing resumes after a restart.
import { lstat, mkdir, open, readdir, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { ErrorLogger } from "@/app";
import type { Clock } from "@/clock";
import type { Translation } from "@/i18n/i18n";
import { trimSpace } from "@/lists/store";
import { HttpError } from "@/server/response";
import { allowedDomain, sanitizeEmail } from "@/subscribers/email";
import {
  createCsvReader,
  CsvError,
  validDelimiter,
  type CsvRecord,
} from "@/subscribers/import/csv";
import { parseAttributes } from "@/subscribers/input";
import {
  EVENT_ATTRIBS_BYTES,
  nameFromEmail,
  type ImportRow,
  type SubscriberStore,
} from "@/subscribers/store";

/** Short enough that a pixel or a send waits a few milliseconds (docs/perf/M1.9-import.md). */
export const BATCH_ROWS = 100;
const CHUNK_BYTES = 64 * 1024;
/** upstream's commitBatchSize, the rows between two progress lines. */
const PROGRESS_ROWS = 10_000;
/** The log keeps its newest lines. Half of this is always there, so the outcome never goes. */
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_LOG_LINE = 1000;
/** Upstream has no limit on a name; this is the one an API update has. */
const MAX_NAME_BYTES = 2000;
const TEMPORARY = ".iglo-email-import";
const temporaryFile = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.upload$/;
const knownHeaders = new Set(["email", "name", "attributes"]);

export interface ImportOptions {
  name: string;
  mode: "subscribe" | "blocklist";
  status: string;
  overwriteUserInfo: boolean;
  overwriteStatus: boolean;
  /** One byte. */
  delimiter: number;
  listIds: bigint[];
}
export interface ImportStatus {
  name: string;
  total: number;
  imported: number;
  status: "none" | "importing" | "stopping" | "finished" | "failed";
}
/** The temporary file of one upload, removed by `release` unless an import took it. */
export interface UploadSlot {
  path: string;
  signal: AbortSignal;
  release(): Promise<void>;
}
const idle = (): ImportStatus => ({ name: "", total: 0, imported: 0, status: "none" });

function createLog(clock: Clock) {
  let older: string[] = [];
  let newer: string[] = [];
  let size = 0;
  return {
    add(message: string) {
      const stamp = clock
        .now()
        .toISOString()
        .replace("T", " ")
        .replace("Z", "")
        .replaceAll("-", "/");
      const line = `${stamp} ${message}`.slice(0, MAX_LOG_LINE);
      newer.push(line);
      size += Buffer.byteLength(line) + 1;
      if (size > MAX_LOG_BYTES / 2) {
        older = newer;
        newer = [];
        size = 0;
      }
    },
    text: () => (older.length || newer.length ? `${[...older, ...newer].join("\n")}\n` : ""),
  };
}

export function createImporter(deps: {
  dataDir: string;
  clock: Clock;
  logger: ErrorLogger;
  i18n: Translation;
  store: Pick<
    SubscriberStore,
    "importSubscribe" | "importBlocklist" | "importUnsubscribing" | "admitImport"
  >;
  touchLists(ids: bigint[]): void;
  domainPolicy(): { allow: string[]; block: string[] };
}) {
  const { clock, logger, i18n, store } = deps;
  const directory = join(deps.dataDir, TEMPORARY);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let status = idle();
  let log = createLog(clock);
  let uploading = false;
  let stopRequested = false;
  const closing = new AbortController();
  let session: Promise<void> | undefined;
  /** The upload the running or last import took over. */
  let taken: string | undefined;
  const busy = () => status.status === "importing" || status.status === "stopping";

  /** Every row of the file, in chunks. `each` decides whether to go on. */
  async function read(
    file: FileHandle,
    options: ImportOptions,
    policy: ReturnType<typeof deps.domainPolicy>,
    logged: boolean,
    each: (rows: ImportRow[], final: boolean) => Promise<boolean>,
  ) {
    // The log outlives a wipe and reaches accounts of other lists, so it holds no cell of a file:
    // a first row with no header above it is someone's address, not a column name.
    const say = (message: string) => {
      if (logged) log.add(message);
    };
    const rows: ImportRow[] = [];
    let columns: Map<string, number> | undefined;
    let width = 0;
    let line = 0;
    const text = (bytes: Buffer) => {
      try {
        const value = decoder.decode(bytes);
        return value.includes("\0") ? undefined : value;
      } catch {
        return undefined;
      }
    };
    const header = (record: CsvRecord) => {
      columns = new Map();
      width = record.count;
      for (let i = 0; i < width; i++) {
        const name = trimSpace(record.field(i).toString("utf8")).replace(/[^\0-\x7f]/g, "");
        if (knownHeaders.has(name)) columns.set(name, i);
        else say(`ignoring unknown header in column ${i + 1}`);
      }
      if (!columns.has("email")) throw new CsvError("'email' column not found");
    };
    const accept = (record: CsvRecord) => {
      if (!columns) return header(record);
      line++;
      if (record.count !== width) {
        say(`skipping line ${line}. wrong number of fields`);
        return;
      }
      const cell = (key: string) => {
        const index = columns!.get(key);
        return index === undefined ? "" : text(record.field(index));
      };
      const rawEmail = cell("email"),
        rawName = cell("name"),
        rawAttributes = cell("attributes");
      if (rawEmail === undefined || rawName === undefined || rawAttributes === undefined) {
        const reason = i18n.Ts("globals.messages.invalidFields", "name", "non-UTF8 encoding");
        say(`skipping line ${line}: ${reason}`);
        return;
      }
      const email = Buffer.byteLength(rawEmail) > 1000 ? undefined : sanitizeEmail(rawEmail);
      if (email === undefined) {
        say(`skipping line ${line}: ${i18n.T("globals.messages.invalidEmail")}`);
        return;
      }
      if (!allowedDomain(email, policy.allow, policy.block)) {
        say(`skipping line ${line}: ${i18n.T("subscribers.domainBlocklisted")}`);
        return;
      }
      const name = trimSpace(rawName);
      if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
        say(`skipping line ${line}: Invalid name`);
        return;
      }
      let attribs = "{}";
      if (rawAttributes)
        try {
          const stored = JSON.stringify(parseAttributes(rawAttributes) ?? {});
          if (Buffer.byteLength(stored) > EVENT_ATTRIBS_BYTES) throw new Error("too large");
          attribs = stored;
        } catch {
          // A parser's message quotes the text it failed on.
          say(`skipping invalid attributes JSON on line ${line}`);
        }
      rows.push({ email, name: name || nameFromEmail(email), attribs });
    };
    const csv = createCsvReader(options.delimiter, accept);
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    for (let position = 0; ;) {
      const { bytesRead } = await file.read(chunk, 0, CHUNK_BYTES, position);
      if (!bytesRead) break;
      position += bytesRead;
      csv.push(chunk.subarray(0, bytesRead));
      if (!(await each(rows, false))) return csv.lines();
    }
    csv.end();
    if (!columns) throw new CsvError("empty file");
    await each(rows, true);
    return csv.lines();
  }

  /** The first pass. False when the import ends here, its outcome already set. */
  async function validate(
    file: FileHandle,
    options: ImportOptions,
    policy: { allow: string[]; block: string[] },
  ) {
    if (!validDelimiter(options.delimiter))
      throw new CsvError("invalid field or comment delimiter");
    let selected = 0;
    const lines = await read(file, options, policy, true, async (rows) => {
      if (stopRequested) return false;
      if (options.mode === "blocklist") selected += rows.length;
      else if (options.overwriteStatus)
        selected += store.importUnsubscribing(
          rows.map((row) => row.email),
          options,
        );
      rows.length = 0;
      return true;
    });
    status.total = Math.max(lines - 1, 0);
    if (stopRequested) return false;
    if (options.mode === "blocklist") store.admitImport("blocklist", selected);
    else if (options.overwriteStatus) store.admitImport("unsubscribe", selected);
    return true;
  }

  /** The second pass. */
  async function write(
    file: FileHandle,
    options: ImportOptions,
    policy: { allow: string[]; block: string[] },
  ) {
    let sinceProgress = 0;
    const commit = (rows: ImportRow[]) => {
      if (options.mode === "blocklist") store.importBlocklist(rows);
      else store.importSubscribe(rows, options);
      status.imported += rows.length;
      sinceProgress += rows.length;
      if (sinceProgress >= PROGRESS_ROWS) {
        sinceProgress = 0;
        log.add(`imported ${status.imported}`);
      }
    };
    await read(file, options, policy, false, async (rows, final) => {
      while (rows.length >= BATCH_ROWS || (final && rows.length)) {
        if (stopRequested) return false;
        const started = clock.now().getTime();
        commit(rows.splice(0, BATCH_ROWS));
        // As long as the batch took, so other work keeps at least half of the thread.
        await clock.sleep(Math.max(1, clock.now().getTime() - started));
      }
      return !stopRequested;
    });
  }

  async function run(path: string, options: ImportOptions) {
    let file: FileHandle | undefined;
    const failed = (message: string) => {
      log.add(message);
      status.status = "failed";
    };
    try {
      const domains = deps.domainPolicy();
      file = await open(path, "r");
      if (await validate(file, options, domains)) await write(file, options, domains);
      if (stopRequested) log.add("stop request received");
      try {
        if (options.listIds.length) deps.touchLists(options.listIds);
      } catch (error) {
        log.add(`error updating lists date: ${(error as Error).message}`);
      }
      log.add("imported finished");
      status.status = "finished";
    } catch (error) {
      // A batch rolls back whole, so what is stored is the batches counted in `imported`.
      if (error instanceof CsvError) failed(`error reading CSV: ${error.message}`);
      else if (error instanceof HttpError) failed(error.message);
      else failed(`error importing: ${(error as Error).message}`);
    } finally {
      await file?.close().catch(() => {});
      await rm(path, { force: true }).catch((error) => logger.error(error));
    }
  }

  return {
    status: () => ({ ...status }),
    logs: () => log.text(),
    /** Remove what a process that died left. Only our own names, whatever else is here. */
    async sweep() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(directory)).isDirectory()) return;
      for (const name of await readdir(directory))
        if (temporaryFile.test(name)) await rm(join(directory, name), { force: true });
    },
    /** A place for one upload, or undefined while an upload or an import holds it. */
    reserve(): UploadSlot | undefined {
      if (uploading || busy() || closing.signal.aborted) return undefined;
      uploading = true;
      const path = join(directory, `${crypto.randomUUID()}.upload`);
      return {
        path,
        signal: closing.signal,
        async release() {
          uploading = false;
          if (taken !== path) await rm(path, { force: true }).catch(() => {});
        },
      };
    },
    /** Upstream's NewSession and LoadCSV. The file is the import's from here. */
    start(slot: UploadSlot, options: ImportOptions) {
      if (closing.signal.aborted) throw new HttpError(503, "The server is shutting down.");
      uploading = false;
      taken = slot.path;
      stopRequested = false;
      log = createLog(clock);
      status = { ...idle(), name: options.name, status: "importing" };
      log.add(`processing '${options.name}'`);
      session = run(slot.path, options);
    },
    /** A running import stops at the next batch; otherwise the last status is cleared. */
    stop() {
      if (status.status === "importing") {
        stopRequested = true;
        status.status = "stopping";
      } else if (status.status !== "stopping") {
        status = idle();
        log = createLog(clock);
      }
    },
    /** Shutdown: refuse uploads, stop at the next batch and wait for it. */
    async close() {
      closing.abort(new Error("Shutting down"));
      stopRequested = true;
      await session;
    },
  };
}
export type Importer = ReturnType<typeof createImporter>;
