// Settings storage adapted from listmonk internal/core/settings.go and cmd/init.go at 6fcd95f.
import type { Database } from "bun:sqlite";
import type { Roles } from "@/roles/roles";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import { defaults } from "@/settings/defaults";
import { HttpError } from "@/server/response";
import { normalize, projectRaw, type Settings } from "@/settings/validate";
import { parseStoredJson } from "@/settings/json";
import sql from "@/settings/queries.sql" with { type: "text" };

// Inspect the final persisted graph, not raw/ignored/overwritten input.
function containsNul(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") {
      if (item.includes("\0")) return true;
    } else if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (key.includes("\0")) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createSettings(db: Database, clock: Clock, rootUrl: string, roles: Roles) {
  const queries = prepareNamedQueries(db, [{ name: "settings", sql }]);
  writeTransaction(db, () => {
    for (const [key, value] of Object.entries(defaults))
      queries.get("seed").run(key, JSON.stringify(value));
  });
  function fresh(rows: { key: string; value: string }[]): Settings {
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      if (Object.hasOwn(defaults, row.key)) out[row.key] = parseStoredJson(row.value);
    }
    out["app.root_url"] = rootUrl;
    out["app.check_updates"] = false;
    return projectRaw(out as Settings, rootUrl);
  }
  // B32 (D88): the projection of the stored rows, reused while every stored row is byte-identical.
  // The rows are re-read on each call, so a write by any path (update, writeStoredValue, restore,
  // another connection) is seen at once; only parsing and projecting are skipped. The cached value is
  // frozen because callers share it.
  let cached: { rows: string; value: Settings } | null = null;
  let onUpdateListener: ((next: Settings, current: Settings) => void) | undefined;
  function read(): Settings {
    const rows = queries.get("all").all() as { key: string; value: string }[];
    let signature = "";
    for (const row of rows)
      signature += `${row.key.length}:${row.key}${row.value.length}:${row.value}`;
    if (cached?.rows === signature) return cached.value;
    const value = deepFreeze(fresh(rows));
    cached = { rows: signature, value };
    return value;
  }
  return {
    read,
    update(build: (current: Settings) => Settings): void {
      let before: Settings | undefined;
      let after: Settings | undefined;
      writeTransaction(db, () => {
        const current = fresh(queries.get("all").all() as { key: string; value: string }[]);
        before = current;
        const proposed = build(current);
        const candidate = normalize(proposed, current, roles, clock.now().getTime());
        const writable = Object.fromEntries(
          Object.entries(candidate).filter(([key]) => key !== "app.root_url"),
        );
        if (containsNul(writable)) throw new HttpError(400, "Invalid data.");
        const now = clock.now().toISOString();
        for (const key of Object.keys(defaults))
          queries.get("update").run(JSON.stringify(candidate[key]), now, key);
        after = candidate;
      });
      if (before && after) onUpdateListener?.(after, before);
    },
    /**
     * One listener per store, called after each committed update. A second registration throws:
     * a silent replacement would drop the first listener (main.ts wires the send-rate limiter here).
     */
    onUpdate(fn: (next: Settings, current: Settings) => void): void {
      if (onUpdateListener) throw new Error("A settings update listener is already registered");
      onUpdateListener = fn;
    },
    close: () => queries.close(),
  };
}
export type SettingsStore = ReturnType<typeof createSettings>;
