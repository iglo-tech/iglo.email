// B168 (15-external-sources section 2, D196): the source request guard's pinning, as a unit of
// src/sources/connect.ts with an injected resolver and a recording transport. A host listed in
// `sources.private_hosts` that resolves to a zoned IPv6 address is refused with nothing sent: a
// WHATWG URL cannot carry the zone, so the request could not be pinned to the checked address.
import { expect, test } from "bun:test";
import { guardedFetch } from "@/sources/connect";
import type { Guard } from "@/sources/connect";

const listed: Guard = { blockPrivate: () => true, privateHosts: () => ["pb.internal"] };

function recording(addresses: Array<string>) {
  const sent: Array<{ url: string; host: string | null }> = [];
  return {
    sent,
    transport: {
      lookup: async () => addresses,
      fetch: async (input: URL, init: RequestInit) => {
        sent.push({ url: input.href, host: new Headers(init.headers).get("host") });
        return new Response("ok");
      },
    },
  };
}

test("B168: a listed host resolving to a zoned IPv6 address is refused, with no request sent", async () => {
  const { sent, transport } = recording(["fe80::1%eth0"]);
  const outcome = await guardedFetch(
    new URL("http://pb.internal:8090/api/health"),
    { method: "GET" },
    listed,
    transport,
  );
  expect(outcome).toMatchObject({ refused: "pb.internal" });
  expect("message" in outcome ? outcome.message : "").toContain("zone");
  expect(sent).toEqual([]);
});

test("B168: the same host resolving to an unzoned link-local address is pinned to it", async () => {
  const { sent, transport } = recording(["fe80::1"]);
  const outcome = await guardedFetch(
    new URL("http://pb.internal:8090/api/health"),
    { method: "GET" },
    listed,
    transport,
  );
  expect(outcome).toBeInstanceOf(Response);
  expect(sent).toEqual([{ url: "http://[fe80::1]:8090/api/health", host: "pb.internal:8090" }]);
});
