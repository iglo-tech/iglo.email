// B162c (D190): the connector contract suite (connector-contract.ts) for the `iglo.base` connector
// against the real iglo.base 1.3.0 binary. The D189 differences that reach the connector each have
// their own test there, met on this binary: a revoked token is answered `401` on reads and on the
// realtime subscription, and a realtime connection whose reader falls 8 MiB behind is closed. (The
// third, a stalled server, is the "paused server times out as transient" test.)
import { setDefaultTimeout } from "bun:test";
import { connectorContract } from "@/test/sources/connector-contract";
import { startIgloBase } from "@/test/sources/iglo-base";

setDefaultTimeout(120_000);

connectorContract({
  connector: "iglo.base",
  displayName: "iglo.base",
  exampleUrl: "http://iglo-base:8090",
  start: startIgloBase,
  revokedToken: 401,
  closesWhenBehind: true,
});
