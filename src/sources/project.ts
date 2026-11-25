// Native (15-external-sources section 1, D172): a project's current source. The adapter keeps its
// service-account token, so one adapter serves every reader of the project until the `source.*`
// settings change; a changed configuration builds a new one, and an empty URL is no source.
import type { Clock } from "@/clock";
import type { Settings } from "@/settings/validate";
import type { Guard, SourceTransport } from "@/sources/connect";
import { createPocketBaseSource } from "@/sources/pocketbase";
import { sourceConfig } from "@/sources/settings";
import type { ExternalSource } from "@/sources/source";

/** The project's source, or null when it has none configured. */
export type SourceProvider = () => ExternalSource | null;

export function createSourceProvider(options: {
  settings: () => Settings;
  clock: Clock;
  guard: Guard;
  transport?: SourceTransport;
}): SourceProvider {
  let key = "";
  let current: ExternalSource | null = null;
  return () => {
    const config = sourceConfig(options.settings());
    if (!config) {
      key = "";
      current = null;
      return null;
    }
    const next = JSON.stringify(config);
    if (next !== key || !current) {
      key = next;
      const adapter: Parameters<typeof createPocketBaseSource>[0] = {
        config,
        clock: options.clock,
        guard: options.guard,
      };
      if (options.transport) {
        adapter.transport = options.transport;
      }
      current = createPocketBaseSource(adapter);
    }
    return current;
  };
}
