// Native (15-external-sources section 1, D188, D190): a connector-list entry for a source that
// speaks PocketBase's REST and realtime API. The `pocketbase` connector is this with PocketBase's
// name and example URL; the `iglo.base` connector (src/sources/iglo-base.ts) is this with its own,
// so both run the same adapter, stream reads and Test connection.
import { checkSource } from "@/sources/pocketbase-check";
import { createPocketBaseSource } from "@/sources/pocketbase";
import type { PocketBaseOptions } from "@/sources/pocketbase";
import { LEAVING_TOO_LONG, leavingTopic } from "@/sources/pocketbase-stream";
import type { Connector } from "@/sources/source";

/** What tells two PocketBase-API connectors apart: what the settings page and messages show. */
export interface PocketBaseFlavor {
  displayName: string;
  exampleUrl: string;
}

export function pocketBaseConnector(flavor: PocketBaseFlavor): Connector {
  return {
    displayName: flavor.displayName,
    exampleUrl: flavor.exampleUrl,
    create(options) {
      const adapter: PocketBaseOptions = {
        config: options.config,
        clock: options.clock,
        guard: options.guard,
        displayName: flavor.displayName,
      };
      if (options.transport) {
        adapter.transport = options.transport;
      }
      return createPocketBaseSource(adapter);
    },
    check: (options) =>
      checkSource(options.config, options.clock, options.guard, options.transport),
    validate({ config, usersChanged }, fail) {
      // B171 (D199, D136 item 9): the stream subscribes to the leaving filter, whose encoded topic
      // must fit the realtime topic limit (2,500 characters on both PocketBase 0.40.5 and iglo.base
      // 1.3.0, measured, D190); checked only when the save changes it or turns the source on, so a
      // filter an older build stored blocks no other save.
      const { collection, leavingFilter } = config.users;
      if (collection && usersChanged && leavingTopic(collection, leavingFilter) === null) {
        fail(`Invalid source.users leaving_filter: ${LEAVING_TOO_LONG}.`);
      }
    },
  };
}

/** The PocketBase connector (D169, D188). */
export const pocketbase = pocketBaseConnector({
  displayName: "PocketBase",
  exampleUrl: "http://pocketbase:8090",
});
