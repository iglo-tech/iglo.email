// Batched-claim crash fixture: the production outbox (test/scheduler/runtime.ts) on a data
// directory, killed by the parent with SIGKILL. Test-only; run by test/sends/batch-crash.ts.
//   BATCH_CRASH_MODE=seed  queue BATCH_CRASH_COUNT transactional sequence sends with the
//                          outbox stopped, then exit
//   BATCH_CRASH_MODE=run   start the outbox alone and print "ready"
import { createRealClock } from "@/clock";
import { seed, startRuntime } from "@/test/scheduler/runtime";

const dataDir = process.env.BATCH_CRASH_DIR!;
const smtpPort = Number(process.env.BATCH_CRASH_SMTP_PORT);
const count = Number(process.env.BATCH_CRASH_COUNT ?? 25);
const clock = createRealClock();
if (process.env.BATCH_CRASH_MODE === "seed") {
  const live = startRuntime({ dataDir, smtpPort, clock, outbox: false });
  seed(live.db, live.enrollments, count, [{ wait: "PT0S", kind: "transactional" }]);
  const queued = () =>
    live.db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM sends WHERE status = 'queued'")
      .get()!.n;
  const deadline = Date.now() + 30_000;
  while (queued() < count) {
    if (Date.now() > deadline) throw new Error("seed: sends were not queued");
    await Bun.sleep(20);
  }
  await live.close();
  process.exit(0);
}
const live = startRuntime({ dataDir, smtpPort, clock, scheduler: false });
process.stdout.write("ready\n");
const stop = () => void live.close().then(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
