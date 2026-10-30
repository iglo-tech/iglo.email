// Frequency-cap lookup cost against per-subscriber history length (docs/perf/M6.1-performance.md).
// Production journal (src/messaging/sends.ts), marketing policy and campaign runner store over a
// generated database: for each history length N, one subscriber has N old marketing journal rows
// and N old campaign deliveries, all outside the cap window, so the cap admits and every lookup
// has to rule out the whole history. Usage: bun test/perf/m61/cap.ts [iterations].
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { writeTransaction } from "@/db/transaction";
import { createListReferences } from "@/lists/references";
import { createSubscriberStore } from "@/subscribers/store";
import { createSends } from "@/messaging/sends";
import { createEnrollments } from "@/sequences/enrollments";
import { createRunnerStore } from "@/campaigns/runner/store";
import { createMarketingPolicy } from "@/unsubscribe/policy";
import { measurementBase, memAvailable, record, stats } from "@/test/perf/m61/record";

const iterations = Number(process.argv[2] ?? 2_000);
const lengths = [0, 100, 1_000, 10_000];
const clock = createRealClock();
const dir = mkdtempSync(join(measurementBase(), "m61-cap-"));
try {
  const db = openDatabase(dir);
  runMigrations(db, dir, clock, productionMigrations);
  const lists = createListReferences(db);
  const enrollments = createEnrollments(db, clock);
  const subscribers = createSubscriberStore(db, clock, lists, enrollments.subscriberEffects);
  const runnerStore = createRunnerStore(db);
  const sends = createSends({
    db,
    clock,
    subscribers,
    rootUrl: () => "http://cap.test",
    marketingPolicy: createMarketingPolicy({
      subscribers,
      lists,
      campaignDeliveries: runnerStore,
      settings: () => ({
        rootUrl: "http://cap.test",
        siteName: "Cap",
        minInterval: "P7D",
        unsubscribeHeader: true,
        allowBlocklist: false,
        individualTracking: false,
        disableTracking: false,
      }),
    }),
  });

  // Generated history, arranged in SQL: older than the 7-day window by at least a day.
  const old = (i: number) => new Date(Date.now() - (8 + i / 1000) * 86_400_000).toISOString();
  const { list, ids } = writeTransaction(db, () => {
    const list = db
      .query<{ id: bigint }, [string]>(
        "INSERT INTO lists(uuid, name, type, optin) VALUES (?, 'news', 'public', 'single') RETURNING id",
      )
      .get(crypto.randomUUID())!.id;
    const subscriber = db.query<{ id: bigint }, [string, string]>(
      "INSERT INTO subscribers(uuid, email, name) VALUES (?, ?, 'Cap') RETURNING id",
    );
    const member = db.query(
      "INSERT INTO subscriber_lists(subscriber_id, list_id, status) VALUES (?, ?, 'confirmed')",
    );
    const send = db.query(
      `INSERT INTO sends(uuid, source, kind, subscriber_id, to_email, list_id, status, attempts, created_at, attempted_at, sent_at)
       VALUES (?, 'sequence', 'marketing', ?, ?, ?, ?, 1, ?, ?, ?)`,
    );
    const campaign = db.query<{ id: bigint }, [string, string]>(
      "INSERT INTO campaigns(uuid, name, subject, from_email, body, status, messenger) VALUES (?, ?, 's', 'a@cap.test', 'b', 'finished', 'email') RETURNING id",
    );
    const delivery = db.query(
      "INSERT INTO campaign_deliveries(campaign_id, subscriber_id, status, at) VALUES (?, ?, ?, ?)",
    );
    const campaigns: bigint[] = [];
    for (let i = 0; i < Math.max(...lengths); i++)
      campaigns.push(campaign.get(crypto.randomUUID(), `c${i}`)!.id);
    const ids = new Map<number, bigint>();
    for (const n of lengths) {
      const email = `cap${n}@cap.test`;
      const id = subscriber.get(crypto.randomUUID(), email)!.id;
      member.run(id, list);
      for (let i = 0; i < n; i++) {
        const at = old(i);
        // Mostly sent, some unknown and failed, as a long history would hold.
        const status = i % 50 === 0 ? "unknown" : i % 25 === 0 ? "failed" : "sent";
        send.run(
          crypto.randomUUID(),
          id,
          email,
          list,
          status,
          at,
          at,
          status === "sent" ? at : null,
        );
        delivery.run(campaigns[i]!, id, i % 40 === 0 ? "unknown" : "sent", at);
      }
      ids.set(n, id);
    }
    return { list, ids };
  });
  db.run("ANALYZE");

  const time = (fn: () => unknown) => {
    for (let i = 0; i < 50; i++) fn();
    const ms: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const t = performance.now();
      fn();
      ms.push(performance.now() - t);
    }
    return stats(ms);
  };
  const results = lengths.map((n) => {
    const id = ids.get(n)!;
    const admission = sends.marketingReason(id, list);
    if (admission !== null) throw new Error(`unexpected admission ${admission} at ${n}`);
    return {
      history: n,
      admission,
      admissionMs: time(() => sends.marketingReason(id, list)),
      capFreeAtMs: time(() => sends.capFreeAt(id, new Date())),
      lastCampaignDeliveryMs: time(() => runnerStore.lastDelivery(id)),
      capFreeAt: sends.capFreeAt(id, new Date(0)).toISOString(),
    };
  });
  sends.close();
  runnerStore.close();
  subscribers.close();
  enrollments.close();
  lists.close();
  db.close(true);
  record(
    {
      scenario: "cap-lookup",
      label: process.env.M61_LABEL ?? "unlabelled",
      iterations,
      results,
      memAvailableMiB: memAvailable(),
      peakRssMiB: Math.round(process.memoryUsage().rss / 1048576),
    },
    false,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
