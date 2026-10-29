// M1.7 evidence: Worker.terminate() does not stop a running bun:sqlite step.
// A Worker starts an endless recursive query; after terminate() the process keeps burning
// one CPU. Usage: bun test/subscribers/worker-terminate.ts
import { readFileSync } from "node:fs";

const cpu = () => {
  const fields = readFileSync("/proc/self/stat", "utf8").split(") ")[1]!.split(" ");
  return (Number(fields[11]) + Number(fields[12])) / 100;
};
const source = `
import { Database } from "bun:sqlite";
const db = new Database(":memory:");
self.onmessage = () => {
  postMessage("started");
  db.query("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c").get();
};`;
const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
const worker = new Worker(url);
await new Promise<void>((resolve) => {
  worker.onmessage = () => resolve();
  worker.postMessage(0);
});
await Bun.sleep(300);
worker.terminate();
const before = cpu();
await Bun.sleep(1500);
const burned = Math.round((cpu() - before) * 100) / 100;
process.stdout.write(
  `${JSON.stringify({ name: "worker-terminate", cpuSecondsIn1500msAfterTerminate: burned })}\n`,
);
process.exit(0);
