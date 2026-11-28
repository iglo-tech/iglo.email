// Native (15-external-sources sections 1 and 9, D187, D189, D190): the iglo.base connector.
// iglo.base is an API-compatible Bun port of PocketBase 0.42.3, so this connector is the PocketBase
// connector's code (src/sources/pocketbase-connector.ts) run with iglo.base's name; nothing is
// copied. What differs from PocketBase 0.40.5 and reaches the connector (D189) is handled by that
// code's existing paths, each tested against the iglo.base binary (test/sources/connector-contract*):
//
// - a revoked or malformed token is answered `401` on a list, a view and a realtime subscription
//   (PocketBase reads it as a guest): the adapter drops the token, signs in again and repeats once;
//   a `401` is never shown;
// - the realtime connection is closed once 8 MiB are unsent: a routine reset, caught up from the
//   stream's markers with nothing lost or doubled;
// - a slow query elsewhere can stall every request: the adapter's own time limit reports it as
//   transient ("did not answer in time").
//
// The absent-answer check (`auth-refresh` with the token a short read used, D170, D191) stays,
// though iglo.base cannot answer a revoked token as a guest: a URL that in fact points at a
// PocketBase 0.40.5 still reads safely (D190).
import { pocketBaseConnector } from "@/sources/pocketbase-connector";

export const igloBase = pocketBaseConnector({
  displayName: "iglo.base",
  exampleUrl: "http://iglo-base:8090",
});
