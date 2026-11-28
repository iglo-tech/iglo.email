// Native (15-external-sources section 1, D187, D188): the connector list. A project's
// `source.connector` names one of these keys; nothing else constructs a source. The list is closed,
// typed and statically imported: no runtime registration, and no lookup by a string outside the
// settings validation (`isConnectorName`), so it is a deliberate exception to "no generic
// registries" (D188). Adding a connector is one module implementing `ConnectorSource` plus one
// line here.
import { checkSource } from "@/sources/pocketbase-check";
import { createPocketBaseSource } from "@/sources/pocketbase";
import { LEAVING_TOO_LONG, leavingTopic } from "@/sources/pocketbase-stream";
import type {
  CheckReport,
  ConnectorOptions,
  ConnectorSource,
  SourceConfig,
} from "@/sources/source";

/** What a connector's settings validator is told of a save. */
export interface ConnectorSave {
  /** The normalized settings. */
  config: SourceConfig;
  /** The save changes `source.users`, or turns the source on (B171, D199: check the topic then). */
  usersChanged: boolean;
}

export interface Connector {
  /** The name the settings page and the validation messages show. */
  readonly displayName: string;
  /** An example of the source URL, for the URL's validation message. */
  readonly exampleUrl: string;
  /** The connector's reader, stream part and schema probe on these settings. */
  create(options: ConnectorOptions): ConnectorSource;
  /** Test connection (section 2): signs in and checks each collection, reporting each step. */
  check(options: ConnectorOptions): Promise<CheckReport>;
  /** The connector's own rules on a save, after the shared ones; throws a 400 to refuse it. */
  validate(save: ConnectorSave, fail: (message: string) => never): void;
}

const pocketbase: Connector = {
  displayName: "PocketBase",
  exampleUrl: "http://pocketbase:8090",
  create: (options) =>
    createPocketBaseSource(
      options.transport
        ? {
            config: options.config,
            clock: options.clock,
            guard: options.guard,
            transport: options.transport,
          }
        : { config: options.config, clock: options.clock, guard: options.guard },
    ),
  check: (options) => checkSource(options.config, options.clock, options.guard, options.transport),
  validate({ config, usersChanged }, fail) {
    // B171 (D199, D136 item 9): the stream subscribes to the leaving filter, whose encoded topic
    // must fit PocketBase's limit; checked only when the save changes it or turns the source on,
    // so a filter an older build stored blocks no other save.
    const { collection, leavingFilter } = config.users;
    if (collection && usersChanged && leavingTopic(collection, leavingFilter) === null) {
      fail(`Invalid source.users leaving_filter: ${LEAVING_TOO_LONG}.`);
    }
  },
};

/** Every connector, by the name `source.connector` stores. */
export const connectors = {
  pocketbase,
} as const satisfies Readonly<Record<string, Connector>>;

export type ConnectorName = keyof typeof connectors;

/** Whether a stored or posted value names a connector (the settings validation's one lookup). */
export const isConnectorName = (value: unknown): value is ConnectorName =>
  typeof value === "string" && Object.hasOwn(connectors, value);
