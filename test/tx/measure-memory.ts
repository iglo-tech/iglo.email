// Serial in-process measurement for docs/perf/B26-tx-memory.md: peak RSS growth of one
// `POST /api/tx` multipart send per counted attachment byte. One scenario per process.
// Usage: bun test/tx/measure-memory.ts <attachmentMiB> <recipients> sync|async [requests] [gated|serial]
// Requests run one after another unless <requests> > 1, when they run together. Opt-in, not a
// CI threshold; hold the measurement lock and record host load.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { createRealClock } from "@/clock";
import { txFixture } from "@/test/tx/fixture";

const repository = resolve(import.meta.dir, "../..");
const output = join(repository, "docs/perf/B26-results.jsonl");
const [mibArg, recipientsArg, mode, requestsArg, gating] = process.argv.slice(2);
const gated = gating === "gated" || gating === "serial";
const attachmentMiB = Number(mibArg ?? 4);
const recipients = Number(recipientsArg ?? 1);
const requests = Number(requestsArg ?? 1);
if (mode !== "sync" && mode !== "async") throw new Error("Usage: <MiB> <recipients> sync|async");
const git = (...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd: repository })
    .stdout.toString()
    .trim();
const mib = (bytes: number) => +(bytes / 1048576).toFixed(1);
/** The kernel's peak resident size, which a timer cannot miss while the thread is busy. */
const highWater = () =>
  Number(/VmHWM:\s+(\d+) kB/.exec(readFileSync("/proc/self/status", "utf8"))![1]) * 1024;
const resetHighWater = () => writeFileSync("/proc/self/clear_refs", "5");

const f = await txFixture({
  clock: createRealClock(),
  discardData: true,
  // Hold the real dispatch long enough for the sampler to see the held copies.
  beforeDispatch: () => Bun.sleep(100),
  ...(gated ? {} : { limits: { maxBytes: 2 ** 40, maxSends: 1_000_000 } }),
});
const template = await f.template("<p>x</p>");
const post = async (i: number) => {
  const form = new FormData();
  form.set(
    "data",
    JSON.stringify({
      subscriber_emails: Array.from({ length: recipients }, (_, r) => `m-${i}-${r}@example.test`),
      template_id: template,
      async: mode === "async",
    }),
  );
  const bytes = new Uint8Array(attachmentMiB * 1048576);
  crypto.getRandomValues(bytes.subarray(0, 65536));
  form.append("file", new File([bytes], "a.bin"));
  const encoded = await new Response(form).blob();
  return () =>
    f
      .request("/api/tx", {
        method: "POST",
        headers: {
          ...f.sessionHeaders,
          "content-type": encoded.type,
          "content-length": String(encoded.size),
        },
        body: encoded,
      })
      .then((response) => response.status);
};
// A small first send, so one-time costs (compiled code, statements, pools) are not growth.
{
  const warm = new FormData();
  warm.set(
    "data",
    JSON.stringify({
      subscriber_emails: ["warm@example.test"],
      template_id: template,
    }),
  );
  warm.append("file", new File([new Uint8Array(1024)], "w.bin"));
  const response = await f.request("/api/tx", {
    method: "POST",
    headers: f.sessionHeaders,
    body: warm,
  });
  if (response.status !== 200) throw new Error("warm-up failed");
}
const sends = await Promise.all(Array.from({ length: requests }, (_, i) => post(i)));
Bun.gc(true);
await Bun.sleep(200);
const baseline = process.memoryUsage().rss;
resetHighWater();
const load = loadavg()[0]!;
const begin = performance.now();
// "serial" sends the requests one after another, to see garbage pile up without concurrency.
const statuses: number[] = [];
if (gating === "serial") for (const send of sends) statuses.push(await send());
else statuses.push(...(await Promise.all(sends.map((send) => send()))));
const seconds = (performance.now() - begin) / 1000;
const peak = highWater();
const attachmentBytes = attachmentMiB * 1048576;
const entry = {
  scenario: "tx memory",
  attachmentMiB,
  recipients,
  mode,
  requests,
  gated,
  statuses: [...new Set(statuses)],
  status200: statuses.filter((s) => s === 200).length,
  status429: statuses.filter((s) => s === 429).length,
  baselineMiB: mib(baseline),
  growthMiB: mib(peak - baseline),
  growthPerAttachment: +((peak - baseline) / attachmentBytes / requests).toFixed(2),
  seconds: +seconds.toFixed(2),
  hostLoad1m: +load.toFixed(2),
};
console.log(JSON.stringify(entry));
appendFileSync(
  output,
  `${JSON.stringify({
    at: new Date().toISOString(),
    head: git("rev-parse", "--short", "HEAD"),
    dirty: git("status", "--porcelain", "src") !== "",
    ...entry,
  })}\n`,
);
await f.close();
