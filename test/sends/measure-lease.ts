// B18: outbox throughput with an instant in-process emailer, so only the journal and the loop's
// claim/finish commits are measured. Run: bun test/sends/measure-lease.ts (prints JSON lines).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openDatabase } from "@/db/connection";
import { productionMigrations, runMigrations } from "@/db/migrations";
import { createListReferences } from "@/lists/references";
import { createSubscriberStore } from "@/subscribers/store";
import { createSends } from "@/messaging/sends";
import { startOutbox } from "@/messaging/outbox";

const rows = 2000;
for (let repetition = 1; repetition <= 3; repetition++) {
  const directory = await mkdtemp(join(tmpdir(), "iglo-lease-measure-"));
  const clock = createRealClock();
  const db = openDatabase(directory);
  runMigrations(db, directory, clock, productionMigrations);
  const lists = createListReferences(db);
  const subscribers = createSubscriberStore(db, clock, lists);
  const sends = createSends({
    db,
    clock,
    subscribers,
    rootUrl: () => "http://measure.test",
  });
  for (let i = 0; i < rows; i++)
    sends.enqueue({
      source: "tx",
      kind: "transactional",
      message: {
        from: "sender@example.test",
        to: [`r${i}@example.test`],
        subject: "measure",
        contentType: "plain",
        body: Buffer.from("measure"),
        headers: {},
      },
    });
  const emailer = {
    push: () => ({
      messageId: "<m@example.test>",
      result: Promise.resolve({
        messageId: "<m@example.test>",
        status: "accepted" as const,
        stage: "smtp-complete" as const,
        accepted: ["x@example.test"],
        rejected: [],
      }),
    }),
  };
  const start = performance.now();
  const outbox = startOutbox({
    db,
    clock,
    logger: { error() {} },
    sends,
    emailer: emailer as never,
  });
  const count = () =>
    db.query<{ n: number }, []>("SELECT count(*) AS n FROM sends WHERE status='sent'").get()!.n;
  while (count() < rows) await new Promise((resolve) => setTimeout(resolve, 5));
  const ms = performance.now() - start;
  await outbox.stop();
  console.log(
    JSON.stringify({
      repetition,
      rows,
      ms: Math.round(ms),
      perSecond: Math.round((rows * 1000) / ms),
    }),
  );
  sends.close();
  subscribers.close();
  lists.close();
  db.close(true);
  await rm(directory, { recursive: true, force: true });
}
