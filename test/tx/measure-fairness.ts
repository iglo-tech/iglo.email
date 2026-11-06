// Peak memory of the B12 fairness scenario for docs/perf/B12-backlog.md: a held 3.5 MiB upload, a
// second upload waiting for room, and a stream of embedded-image JSON sends (each to several
// recipients) arriving meanwhile. "before" lets every send that fits pass the waiter (the pre-B12
// rule); "after" is the shipped limit of 8 overtakes, then a 429. Opt-in, not a CI threshold.
// Usage: bun test/tx/measure-fairness.ts <sends> before|after
import { readFileSync } from "node:fs";
import { txFixture } from "@/test/tx/fixture";

const sends = Number(process.argv[2] ?? 60);
const variant = process.argv[3] === "before" ? "before" : "after";
const peakKiB = () => Number(/VmHWM:\s+(\d+)/.exec(readFileSync("/proc/self/status", "utf8"))![1]);
const mib = (kib: number) => +(kib / 1024).toFixed(1);

let release = () => {};
const stalled = new Promise<void>((resolve) => (release = resolve));
const f = await txFixture({
  beforeDispatch: () => stalled,
  limits: {
    maxBytes: 20 * 1024 * 1024,
    waitMs: 60_000,
    ...(variant === "before" ? { maxOvertakes: 1_000_000 } : {}),
  },
});
const media = new FormData();
media.append("file", new File([new Uint8Array(256 * 1024)], "logo.png", { type: "image/png" }));
await f.request("/api/media", { method: "POST", headers: f.sessionHeaders, body: media });
const embedded = await f.template(`<img src="logo.png" data-embed="true">`);
const plain = await f.template("<p>x</p>");
const upload = async (email: string, size: number) => {
  const form = new FormData();
  form.set("data", JSON.stringify({ subscriber_emails: [email], template_id: plain }));
  form.append("file", new File([new Uint8Array(Math.floor(size))], "a.bin"));
  const encoded = await new Response(form).blob();
  return f.request("/api/tx", {
    method: "POST",
    headers: {
      ...f.sessionHeaders,
      "content-type": encoded.type,
      "content-length": String(encoded.size),
    },
    body: encoded,
  });
};
const base = peakKiB();
const holders = [upload("first@example.test", 3.5 * 1024 * 1024)];
await Bun.sleep(300);
// Needs more room than is left beside the first while it is held, so it waits.
holders.push(upload("waiting@example.test", 3.5 * 1024 * 1024));
await Bun.sleep(300);
const results = Array.from({ length: sends }, (_, i) =>
  f.tx({
    subscriber_emails: Array.from({ length: 4 }, (_, j) => `m-${i}-${j}@example.test`),
    subscriber_mode: "external",
    template_id: embedded,
  }),
);
await Bun.sleep(1500);
const during = peakKiB();
release();
const all = await Promise.all([...holders, ...results]);
const statuses = all.map((r) => r.status);
console.log(
  JSON.stringify({
    variant,
    sends,
    codes: [...new Set(statuses)],
    ok: statuses.filter((s) => s === 200).length,
    refused: statuses.filter((s) => s === 429).length,
    peakRssMiBBefore: mib(base),
    peakRssMiBWhileWaiting: mib(during),
    peakRssMiBEnd: mib(peakKiB()),
  }),
);
await f.close();
process.exit(0);
