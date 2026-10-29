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

export function createSettings(db: Database, clock: Clock, rootUrl: string, roles: Roles) {
  const queries = prepareNamedQueries(db, [{ name: "settings", sql }]);
  writeTransaction(db, () => {
    for (const [key, value] of Object.entries(defaults))
      queries.get("seed").run(key, JSON.stringify(value));
  });
  function read(): Settings {
    const out: Record<string, unknown> = {};
    for (const row of queries.get("all").all() as { key: string; value: string }[]) {
      if (Object.hasOwn(defaults, row.key)) out[row.key] = parseStoredJson(row.value);
    }
    out["app.root_url"] = rootUrl;
    out["app.check_updates"] = false;
    return projectRaw(out as Settings, rootUrl);
  }
  return {
    read,
    update(build: (current: Settings) => Settings): void {
      writeTransaction(db, () => {
        const current = read();
        const proposed = build(current);
        const candidate = normalize(proposed, current, roles, clock.now().getTime());
        const writable = Object.fromEntries(
          Object.entries(candidate).filter(([key]) => key !== "app.root_url"),
        );
        if (containsNul(writable)) throw new HttpError(400, "Invalid data.");
        const now = clock.now().toISOString();
        for (const key of Object.keys(defaults))
          queries.get("update").run(JSON.stringify(candidate[key]), now, key);
      });
    },
    close: () => queries.close(),
  };
}
export type SettingsStore = ReturnType<typeof createSettings>;
