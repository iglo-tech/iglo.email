// B162c (D190): the connector contract suite (connector-contract.ts) for the `pocketbase` connector
// against the real PocketBase 0.40.5 binary. PocketBase reads a revoked token as a guest and keeps
// a slow reader's unsent realtime messages (D189).
import { setDefaultTimeout } from "bun:test";
import { connectorContract } from "@/test/sources/connector-contract";
import { startPocketBase } from "@/test/sources/pocketbase";

setDefaultTimeout(120_000);

connectorContract({
  connector: "pocketbase",
  displayName: "PocketBase",
  exampleUrl: "http://pocketbase:8090",
  start: startPocketBase,
  revokedToken: "guest",
  closesWhenBehind: false,
});
