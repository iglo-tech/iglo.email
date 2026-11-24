// Settings storage adapted from listmonk internal/core/settings.go and cmd/init.go at 6fcd95f.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import { defaults } from "@/settings/defaults";
import { HttpError } from "@/server/response";
import { normalizeProject, projectRaw } from "@/settings/validate";
import type { InstanceSettingsReader } from "@/settings/instance";
import { pickSide, projectKeys, sideKeys } from "@/settings/keys";
import type { Settings } from "@/settings/validate";
import { parseStoredJson } from "@/settings/json";
import sql from "@/settings/queries.sql" with { type: "text" };

// Inspect the final persisted graph, not raw/ignored/overwritten input.
/** A settings table's rows, from its `all` query. */
export function settingsRows(statement: {
  all(): Array<unknown>;
}): Array<{ key: string; value: string }> {
  return statement.all() as Array<{ key: string; value: string }>;
}

export function containsNul(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") {
      if (item.includes("\0")) {
        return true;
      }
    } else if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (key.includes("\0")) {
          return true;
        }
        pending.push(child);
      }
    }
  }
  return false;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * A project's settings (B139, D154): its project keys, stored in its own database, read together with
 * the instance keys from the one instance reader. `update` writes project keys only; the instance keys
 * change only through the instance store, and a change there reaches this store's listener too.
 */
export function createSettings(
  db: Database,
  clock: Clock,
  rootUrl: string,
  instance: InstanceSettingsReader,
) {
  const queries = prepareNamedQueries(db, [{ name: "settings", sql }]);
  writeTransaction(db, () => {
    for (const key of sideKeys("project")) {
      queries.get("seed").run(key, JSON.stringify(defaults[key]));
    }
  });
  function project(rows: Array<{ key: string; value: string }>): Settings {
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      if (projectKeys.has(row.key)) {
        out[row.key] = parseStoredJson(row.value);
      }
    }
    const value = pickSide(projectRaw(out, rootUrl), "project");
    value["app.root_url"] = rootUrl;
    return value;
  }
  // B32 (D88): the projection of the stored rows, reused while every stored row is byte-identical
  // and the instance keys are the same object. The rows are re-read on each call, so a write by any
  // path (update, writeStoredValue, restore, another connection) is seen at once; only parsing and
  // projecting are skipped. The cached value is frozen because callers share it.
  let cached: { rows: string; instance: Settings; value: Settings } | null = null;
  let onUpdateListener: ((next: Settings, current: Settings) => void) | undefined;
  function read(): Settings {
    const rows = queries.get("all").all() as Array<{ key: string; value: string }>;
    let signature = "";
    for (const row of rows) {
      signature += `${row.key.length}:${row.key}${row.value.length}:${row.value}`;
    }
    const shared = instance.read();
    if (cached?.rows === signature && cached.instance === shared) {
      return cached.value;
    }
    const value = deepFreeze({ ...project(rows), ...shared });
    cached = { rows: signature, instance: shared, value };
    return value;
  }
  // An instance change is a settings change for this project's listener too (the send-rate wake).
  const unsubscribe = instance.subscribe((next, current) => {
    if (onUpdateListener) {
      const own = project(queries.get("all").all() as Array<{ key: string; value: string }>);
      onUpdateListener({ ...own, ...next }, { ...own, ...current });
    }
  });
  return {
    read,
    /** The project keys only, as the project settings API serves them. */
    readProject(): Settings {
      const value = pickSide(read(), "project");
      value["app.root_url"] = rootUrl;
      return value;
    },
    /**
     * Writes the project keys `build` returns from the current settings. Instance keys in its result
     * are ignored: the routes refuse them before this is called.
     */
    update(build: (current: Settings) => Settings): void {
      let before: Settings | undefined;
      let after: Settings | undefined;
      writeTransaction(db, () => {
        const shared = instance.read();
        const current = project(queries.get("all").all() as Array<{ key: string; value: string }>);
        const proposed = pickSide(build({ ...current, ...shared }), "project");
        const candidate = normalizeProject(proposed, current, clock.now().getTime());
        const writable = pickSide(candidate, "project");
        if (containsNul(writable)) {
          throw new HttpError(400, "Invalid data.");
        }
        const now = clock.now().toISOString();
        for (const key of sideKeys("project")) {
          queries.get("update").run(JSON.stringify(writable[key]), now, key);
        }
        before = { ...current, ...shared };
        after = { ...candidate, "app.root_url": rootUrl, ...shared };
      });
      if (before && after) {
        onUpdateListener?.(after, before);
      }
    },
    /**
     * One listener per store, called after each committed update of this project's keys or of the
     * instance keys. A second registration throws: a silent replacement would drop the first
     * listener (compose.ts wires the send-rate limiter here).
     */
    onUpdate(fn: (next: Settings, current: Settings) => void): void {
      if (onUpdateListener) {
        throw new Error("A settings update listener is already registered");
      }
      onUpdateListener = fn;
    },
    close: () => {
      unsubscribe();
      queries.close();
    },
  };
}
export type SettingsStore = ReturnType<typeof createSettings>;
