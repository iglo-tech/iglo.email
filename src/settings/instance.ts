// The instance settings (14-projects section 4, B139, D154). Native: listmonk has one settings table
// per install. The instance keys are stored once, in instance.db's `settings` table, and every project
// reads them through the one reader this store hands out: no project holds a copy (invariant 5).
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import { defaults } from "@/settings/defaults";
import { instanceKeys, pickSide, sideKeys } from "@/settings/keys";
import { parseStoredJson } from "@/settings/json";
import { containsNul, deepFreeze, settingsRows } from "@/settings/store";
import { normalizeInstance, projectRaw } from "@/settings/validate";
import type { Settings } from "@/settings/validate";
import { HttpError } from "@/server/response";
import { instanceAttention } from "@/projects/logger";
import sql from "@/settings/queries.sql" with { type: "text" };

/** Instance migration 5's mark of an upgrade the sources switch is not settled for (D188). */
const SOURCES_UPGRADE = "sources.enabled_upgrade";

/** What a project sees of the instance settings: the current instance keys and their changes. */
export interface InstanceSettingsReader {
  /** The instance keys, frozen and shared. */
  read(): Settings;
  /**
   * Called after each committed change with the instance keys after and before it. Returns the
   * function that stops the calls (a project removed at runtime).
   */
  subscribe(listener: (next: Settings, current: Settings) => void): () => void;
}

/** The instance keys the instance's own login reads (B139): its session duration and proxies. */
export function instanceLoginSettings(settings: Settings) {
  const duration: unknown = settings["security.session_duration"];
  const proxies: unknown = settings["security.trusted_proxies"];
  return {
    sessionDuration: typeof duration === "string" ? duration : "",
    trustedProxies: Array.isArray(proxies)
      ? proxies.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

export function createInstanceSettings(db: Database, clock: Clock) {
  const queries = prepareNamedQueries(db, [{ name: "settings", sql }]);
  writeTransaction(db, () => {
    for (const key of sideKeys("instance")) {
      queries.get("seed").run(key, JSON.stringify(defaults[key]));
    }
  });
  function fresh(rows = settingsRows(queries.get("all"))): Settings {
    const out: Settings = {};
    for (const row of rows) {
      if (instanceKeys.has(row.key)) {
        out[row.key] = parseStoredJson(row.value);
      }
    }
    out["app.check_updates"] = false;
    return pickSide(projectRaw(out, ""), "instance");
  }
  // As a project's store (B32, D88): the rows are read on each call and the projection is reused
  // while they are byte-identical, so a write by any connection is seen at once.
  let cached: { rows: string; value: Settings } | undefined;
  const listeners = new Set<(next: Settings, current: Settings) => void>();
  function read(): Settings {
    const rows = settingsRows(queries.get("all"));
    let signature = "";
    for (const row of rows) {
      signature += `${row.key.length}:${row.key}${row.value.length}:${row.value}`;
    }
    if (cached?.rows !== signature) {
      cached = { rows: signature, value: deepFreeze(fresh(rows)) };
    }
    return cached.value;
  }
  const reader: InstanceSettingsReader = {
    read,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    read,
    reader,
    /** Writes the instance keys `build` returns from the current ones, checked as one save. */
    update(build: (current: Settings) => Settings): void {
      let before: Settings | undefined;
      let after: Settings | undefined;
      writeTransaction(db, () => {
        const current = fresh();
        const candidate = pickSide(
          normalizeInstance(build(current), current, clock.now().getTime()),
          "instance",
        );
        if (containsNul(candidate)) {
          throw new HttpError(400, "Invalid data.");
        }
        const now = clock.now().toISOString();
        for (const key of sideKeys("instance")) {
          queries.get("update").run(JSON.stringify(candidate[key]), now, key);
        }
        before = current;
        after = candidate;
      });
      if (before && after) {
        // Every project hears of the change: one failing notification is logged and does not stop
        // the others or change the save's result, which is already committed.
        const next = read();
        for (const listener of listeners) {
          try {
            listener(next, before);
          } catch (error) {
            instanceAttention(
              `Instance settings change notification failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    },
    /**
     * B162a (D188): an upgrade from a build without the sources module. Instance migration 5 marks
     * an instance that already served projects; once every project is open and migrated, the switch
     * is turned on when `anySource()` (a project names a source URL), so a running source keeps
     * working, and the mark goes. Written directly with no change notification: the projects have
     * not started, and each reads the instance keys afresh.
     */
    settleSourcesUpgrade(anySource: () => boolean): void {
      if (!queries.get("get").get(SOURCES_UPGRADE)) {
        return;
      }
      const on = anySource();
      writeTransaction(db, () => {
        if (on) {
          queries.get("update").run("true", clock.now().toISOString(), "sources.enabled");
        }
        queries.get("delete").run(SOURCES_UPGRADE);
      });
    },
    close: () => queries.close(),
  };
}
export type InstanceSettingsStore = ReturnType<typeof createInstanceSettings>;
