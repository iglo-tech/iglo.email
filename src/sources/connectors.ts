// Native (15-external-sources section 1, D187, D188, D190): the connector list. A project's
// `source.connector` names one of these keys; nothing else constructs a source. The list is closed,
// typed and statically imported: no runtime registration, and no lookup by a string outside the
// settings validation (`isConnectorName`), so it is a deliberate exception to "no generic
// registries" (D188). Adding a connector is one module exporting a `Connector` (src/sources/source.ts)
// plus one line here; see 15-external-sources "Adding a connector".
import { igloBase } from "@/sources/iglo-base";
import { pocketbase } from "@/sources/pocketbase-connector";
import type { Connector } from "@/sources/source";

/** Every connector, by the name `source.connector` stores. */
export const connectors = {
  pocketbase,
  "iglo.base": igloBase,
} as const satisfies Readonly<Record<string, Connector>>;

export type ConnectorName = keyof typeof connectors;

/** Whether a stored or posted value names a connector (the settings validation's one lookup). */
export const isConnectorName = (value: unknown): value is ConnectorName =>
  typeof value === "string" && Object.hasOwn(connectors, value);
