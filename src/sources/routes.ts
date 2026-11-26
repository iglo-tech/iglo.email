// Native (15-external-sources section 2, D170): the source settings' own routes and rules.
// `POST /api/settings/source/test` checks a source (the saved one, or the form's unsaved `source.*`
// keys over it) and reports each step; `GET /api/settings/source/retries` lists the stream's retry
// queue (B155f, D181); `sourceListsCheck` refuses a save whose `grant_lists` name a list this
// project does not have.
import type { Clock } from "@/clock";
import type { ListReferences } from "@/lists/references";
import type { Router } from "@/server/router";
import { HttpError, ok } from "@/server/response";
import { decodeJsonBytes } from "@/settings/json";
import type { SettingsStore } from "@/settings/store";
import { bindKey } from "@/settings/validate";
import type { Settings } from "@/settings/validate";
import { cloneJson } from "@/settings/json";
import { checkSource } from "@/sources/check";
import { isSourceObject, sourceJson } from "@/sources/json";
import type { SourceJson, SourceObject } from "@/sources/json";
import type { Guard, SourceTransport } from "@/sources/connect";
import {
  grantedListIds,
  normalizeSource,
  privateHosts,
  sourceConfig,
  sourceDefaults,
} from "@/sources/settings";
import type { SourceStream } from "@/sources/stream";
import type { RetryRow } from "@/sources/stream-store";
import type { Authentication } from "@/users/auth";
import { readBodyBytes } from "@/users/input";

/** The private-address guard as a project's settings state it, read at every connection. */
export function sourceGuard(read: () => Settings): Guard {
  return {
    blockPrivate: () => read()["webhooks.block_private_addresses"] !== false,
    privateHosts: () => privateHosts(read()),
  };
}

/**
 * A settings check (inside the save's transaction): every list a grant rule newly names is this
 * project's. A list the stored rules already named is not checked again, so deleting a list does
 * not block saving anything else (the grant path refuses a missing list on its own).
 */
export function sourceListsCheck(lists: Pick<ListReferences, "name">) {
  return (next: Settings, current: Settings): void => {
    const stored = new Set(grantedListIds(current));
    const missing = grantedListIds(next).filter(
      (id) => !stored.has(id) && lists.name(BigInt(id)) === null,
    );
    if (missing.length) {
      throw new HttpError(
        400,
        `Invalid source.grant_lists: no list with ID ${missing.join(", ")} in this project.`,
      );
    }
  };
}

/** A Test connection body: a JSON object, or nothing. */
function parseBody(bytes: Buffer): SourceObject {
  if (!bytes.length) {
    return {};
  }
  let body: SourceJson | undefined;
  try {
    body = sourceJson(JSON.parse(decodeJsonBytes(bytes)));
  } catch {
    body = undefined;
  }
  if (!isSourceObject(body)) {
    throw new HttpError(400, "Invalid data.");
  }
  return body;
}

/** The most retry queue rows one read lists, oldest first (bounded memory). */
export const RETRIES_LIMIT = 1000;

/** How a retry queue row shows: retrying, waiting for the settings to be fixed, or failed for good. */
function retryStatus(row: RetryRow): "queued" | "waiting" | "terminal" {
  if (row.terminal === 1n) {
    return "terminal";
  }
  // B155b's `waiting` column (a settings mismatch); read structurally until every build has it.
  return "waiting" in row && row.waiting === 1n ? "waiting" : "queued";
}

/** A retry queue row as the API lists it (B155f, D181). */
function retryOut(row: RetryRow) {
  const status = retryStatus(row);
  return {
    id: Number(row.id),
    kind: row.kind,
    record_id: row.record_id,
    stamp: row.stamp,
    status,
    attempts: Number(row.attempts),
    first_failed_at: row.first_failed_at,
    next_attempt_at: status === "terminal" ? null : row.next_attempt_at,
    last_error: row.last_error,
  };
}

export function registerSourceRoutes(
  router: Router,
  deps: {
    settings: SettingsStore;
    auth: Authentication;
    clock: Clock;
    transport?: SourceTransport;
    /** The project's running source stream, or null without a source (the retry queue's reader). */
    stream?: () => Pick<SourceStream, "state" | "retries"> | null;
  },
): void {
  const { settings, auth, clock } = deps;
  // B155f (D181): the stream's retry queue, read-only. Its error text is the source's or the
  // handler's own (unlike the logs view's safe lines), so it needs what Test connection needs.
  router.route(
    "GET",
    "/api/settings/source/retries",
    () => {
      const stream = deps.stream?.() ?? null;
      const rows = stream ? stream.retries(RETRIES_LIMIT + 1) : [];
      return ok({
        stream: stream ? stream.state().state : null,
        more: rows.length > RETRIES_LIMIT,
        results: rows.slice(0, RETRIES_LIMIT).map(retryOut),
      });
    },
    auth.middleware("settings:manage"),
  );
  router.route(
    "POST",
    "/api/settings/source/test",
    async (context) => {
      const body = parseBody(await readBodyBytes(context.request));
      auth.revalidate(context, "settings:manage");
      const current = settings.read();
      let candidate: Settings = cloneJson(current);
      // A password counts only when the form sends one; else the stored one is kept for the same
      // URL and identity alone, as a save keeps it.
      candidate["source.password"] = "";
      for (const key of Object.keys(sourceDefaults)) {
        if (Object.hasOwn(body, key)) {
          candidate = bindKey(candidate, key, body[key]);
        }
      }
      normalizeSource(candidate, current);
      const config = sourceConfig(candidate);
      if (!config) {
        throw new HttpError(400, "Set source.url to test a source.");
      }
      return ok(await checkSource(config, clock, sourceGuard(settings.read), deps.transport));
    },
    auth.middleware("settings:manage"),
  );
}
