// B150c (D172): helpers for condition and aggregate tests against the PocketBase harness. Records
// are created through the binary's own batch API, so a window at AGGREGATE_LIMIT takes seconds.
import { createRealClock } from "@/clock";
import type { Guard } from "@/sources/connect";
import { createPocketBaseSource } from "@/sources/pocketbase";
import { sourceConfig } from "@/test/sources/pocketbase";
import type { PocketBase } from "@/test/sources/pocketbase";

export const open: Guard = { blockPrivate: () => false, privateHosts: () => [] };

/** An adapter on the harness instance with the fixture schema. */
export const adapter = (pb: PocketBase) =>
  createPocketBaseSource({
    config: sourceConfig(pb.url, pb.service),
    clock: createRealClock(),
    guard: open,
  });

/** Enables PocketBase's batch API (off by default). */
export async function enableBatch(pb: PocketBase) {
  await pb.api("PATCH", "/api/settings", {
    batch: { enabled: true, maxRequests: 1000, timeout: 60, maxBodySize: 0 },
  });
}

/** Creates `count` events records for `user` in batches; `at(i)` is each record's `occurredAt`. */
export async function manyEvents(
  pb: PocketBase,
  user: string,
  name: string,
  count: number,
  record: (i: number) => { at: Date; data?: Record<string, unknown> },
) {
  for (let start = 0; start < count; start += 1000) {
    const requests = [];
    for (let i = start; i < Math.min(count, start + 1000); i++) {
      const { at, data } = record(i);
      requests.push({
        method: "POST",
        url: "/api/collections/events/records",
        body: { user, name, data: data ?? {}, occurredAt: at.toISOString() },
      });
    }
    await pb.api("POST", "/api/batch", { requests });
  }
}

/** PocketBase's date text for an instant, as the harness stores `occurredAt`. */
export const iso = (ms: number) => new Date(ms);
