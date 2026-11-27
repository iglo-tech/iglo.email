// Native (15-external-sources section 1, D172, D188): a project's current source. The connector
// keeps its service-account token, so one source serves every reader of the project until the
// `source.*` settings change; a changed configuration builds a new one, and no source (the module
// off, no connector or an empty URL) is null.
import type { Clock } from "@/clock";
import type { Settings } from "@/settings/validate";
import type { Guard, SourceTransport } from "@/sources/connect";
import { connectors } from "@/sources/connectors";
import { sourceSetup } from "@/sources/settings";
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
    const setup = sourceSetup(options.settings());
    if (!setup) {
      key = "";
      current = null;
      return null;
    }
    const next = JSON.stringify(setup);
    if (next !== key || !current) {
      key = next;
      current = connectors[setup.connector].create({
        config: setup.config,
        clock: options.clock,
        guard: options.guard,
        transport: options.transport,
      });
    }
    return current;
  };
}
