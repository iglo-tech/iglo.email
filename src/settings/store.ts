// Settings storage adapted from listmonk internal/core/settings.go and cmd/init.go at 6fcd95f.
import type { Database } from "bun:sqlite";
import type { Roles } from "@/roles/roles";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import { defaults } from "@/settings/defaults";
import { HttpError } from "@/server/response";
import { normalize, projectRaw, type Settings } from "@/settings/validate";
import sql from "@/settings/queries.sql" with { type: "text" };

export function createSettings(db: Database, clock: Clock, rootUrl: string, roles: Roles) {
  const queries = prepareNamedQueries(db, [{ name: "settings", sql }]);
  writeTransaction(db, () => {
    for (const [key, value] of Object.entries(defaults))
      queries.get("seed").run(key, JSON.stringify(value));
  });
  function read(): Settings {
    const out: Record<string, unknown> = {};
    for (const row of queries.get("all").all() as { key: string; value: string }[]) {
      if (Object.hasOwn(defaults, row.key)) out[row.key] = JSON.parse(row.value);
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
        // Retained sessions currently have no durable per-session expiry. Refuse
        // changes until their owner supplies that seam, rather than report a
        // configuration change that the running authentication cannot honor.
        const candidate = normalize(proposed, current, roles);
        if (candidate["security.session_duration"] !== current["security.session_duration"])
          throw new HttpError(501, "Session duration changes are not implemented");
        const now = clock.now().toISOString();
        for (const key of Object.keys(defaults))
          queries.get("update").run(JSON.stringify(candidate[key]), now, key);
      });
    },
    close: () => queries.close(),
  };
}
export type SettingsStore = ReturnType<typeof createSettings>;
