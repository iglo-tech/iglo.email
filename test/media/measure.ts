// Attachment memory of the campaign runner (docs/perf/M3.5-media.md); opt-in, not a CI threshold.
// `bun test/media/measure.ts`. Real emailer and MIME composition, loopback sink, serial scenarios.
import { runnerFixture } from "@/test/campaigns/runner/fixture";

const mebibyte = 1024 * 1024;
const held = () => {
  Bun.gc(true);
  return process.memoryUsage().arrayBuffers;
};
const scenarios = [
  { name: "6 campaigns, 1 shared 8 MiB file", campaigns: 6, shared: true, concurrency: 1 },
  { name: "6 campaigns, own 8 MiB files", campaigns: 6, shared: false, concurrency: 1 },
  { name: "12 campaigns, own 8 MiB files", campaigns: 12, shared: false, concurrency: 1 },
  {
    name: "6 campaigns, 1 shared 8 MiB file, 4 workers",
    campaigns: 6,
    shared: true,
    concurrency: 4,
  },
];
for (const s of scenarios) {
  const f = await runnerFixture({ realEmailer: true });
  try {
    Object.assign(f.settings, { concurrency: s.concurrency, batchSize: s.concurrency });
    const list = await f.list("measure");
    const recipients = 4 * s.concurrency;
    for (let i = 0; i < recipients; i++) await f.member(`to-${i}@example.com`, [list]);
    const upload = async (i: number) => {
      const body = new FormData();
      const content = new Uint8Array(8 * mebibyte).fill(i);
      body.append("file", new File([content], `file-${i}.pdf`, { type: "application/pdf" }));
      const response = await f.request("/api/media", {
        method: "POST",
        headers: f.sessionHeaders,
        body,
      });
      return (await response.json()).data.id as number;
    };
    const shared = s.shared ? await upload(0) : 0;
    const ids: number[] = [];
    for (let i = 0; i < s.campaigns; i++) {
      const media = s.shared ? shared : await upload(i + 1);
      const c = await f.campaign({
        name: `C${i}`,
        subject: "S",
        lists: [list],
        content_type: "plain",
        type: "regular",
        messenger: "email",
        body: "B",
        media: [media],
      });
      await f.status(c.id, "running");
      ids.push(c.id);
    }
    const base = held();
    const started = performance.now();
    let peak = 0;
    let rss = 0;
    f.start();
    let done = false;
    while (!done) {
      for (let i = 0; i < 20; i++) await Bun.sleep(1);
      f.sink.messages.length = 0;
      f.clock.advance(100);
      peak = Math.max(peak, held() - base);
      rss = Math.max(rss, process.memoryUsage().rss);
      done = (await Promise.all(ids.map(f.read))).every((c) => c.status === "finished");
    }
    console.log(
      JSON.stringify({
        scenario: s.name,
        messages: recipients * s.campaigns,
        seconds: +((performance.now() - started) / 1000).toFixed(1),
        peakArrayBufferMiB: +(peak / mebibyte).toFixed(1),
        peakRssMiB: Math.round(rss / mebibyte),
      }),
    );
  } finally {
    await f.close();
  }
}
