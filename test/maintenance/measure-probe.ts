// Child of test/maintenance/measure.ts: how long the write lock stays out of reach. A second
// connection tries BEGIN IMMEDIATE every few milliseconds and retries a refusal at once, so the
// longest wait is the longest hold, within a retry. It writes nothing. It stops when stdin closes.
import { Database } from "bun:sqlite";

const db = new Database(process.argv[2]!);
db.run("PRAGMA busy_timeout = 0");
let longest = 0;
let stopped = false;
(async () => {
  for await (const _ of Bun.stdin.stream());
  stopped = true;
})();
while (!stopped) {
  const started = performance.now();
  for (;;) {
    try {
      db.run("BEGIN IMMEDIATE");
      db.run("COMMIT");
      break;
    } catch {
      Bun.sleepSync(0.2);
    }
  }
  longest = Math.max(longest, performance.now() - started);
  await Bun.sleep(3);
}
process.stdout.write(`${longest.toFixed(1)}\n`);
db.close();
