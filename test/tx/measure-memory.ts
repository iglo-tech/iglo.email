// Serial in-process measurement for docs/perf/B26-tx-memory.md: peak RSS growth of one
// `POST /api/tx` multipart send per counted attachment byte. One scenario per process.
// Usage: bun test/tx/measure-memory.ts <attachmentMiB> <recipients> sync|async [requests] [gated|serial]
// Requests run one after another unless <requests> > 1, when they run together. Every run builds
// each body inside its own request task (B28), so no body exists before the baseline. Opt-in, not a
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
// Request i's multipart body, streamed: the client side holds only one 64 KiB chunk at a time, so
// the in-process harness does not add the copies a real client keeps in its own process (B28).
const chunk = crypto.getRandomValues(new Uint8Array(65536));
const encoder = new TextEncoder();
const build = (i: number) => {
  const boundary = `----b28-${i}`;
  const data = JSON.stringify({
    subscriber_emails: Array.from({ length: recipients }, (_, r) => `m-${i}-${r}@example.test`),
    template_id: template,
    async: mode === "async",
  });
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${data}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const fileBytes = attachmentMiB * 1048576;
  let sent = 0;
  let stage = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === 0) {
        controller.enqueue(head);
        stage = 1;
      } else if (sent < fileBytes) {
        const n = Math.min(chunk.length, fileBytes - sent);
        controller.enqueue(n === chunk.length ? chunk : chunk.subarray(0, n));
        sent += n;
      } else {
        controller.enqueue(tail);
        controller.close();
      }
    },
  });
  return {
    body,
    type: `multipart/form-data; boundary=${boundary}`,
    size: head.length + fileBytes + tail.length,
  };
};
const send = (encoded: ReturnType<typeof build>) =>
  f
    .request("/api/tx", {
      method: "POST",
      headers: {
        ...f.sessionHeaders,
        "content-type": encoded.type,
        "content-length": String(encoded.size),
      },
      body: encoded.body,
    })
    .then((response) => response.status);
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
Bun.gc(true);
await Bun.sleep(200);
const baseline = process.memoryUsage().rss;
resetHighWater();
const load = loadavg()[0]!;
const begin = performance.now();
// "serial" sends the requests one after another, to see garbage pile up without concurrency; each
// body is built when it is sent, so its build time is in `seconds`.
const statuses: number[] = [];
if (gating === "serial") for (let i = 0; i < requests; i++) statuses.push(await send(build(i)));
else
  statuses.push(...(await Promise.all(Array.from({ length: requests }, (_, i) => send(build(i))))));
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
