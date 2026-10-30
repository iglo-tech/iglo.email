// Attachment memory of the campaign runner (docs/perf/M3.5-media.md); opt-in, not a CI threshold.
// `bun test/media/measure.ts`. Real emailer and MIME composition, loopback sink, serial scenarios.
import { generateKeyPairSync } from "node:crypto";
import { campaignsFixture } from "@/test/campaigns/fixture";
import { runnerFixture } from "@/test/campaigns/runner/fixture";
import { startStalledSink } from "@/test/tx/sink";

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
  {
    name: "1 campaign, 8 MiB file, 4 workers, DKIM, slow SMTP",
    campaigns: 1,
    shared: true,
    concurrency: 4,
    signed: true,
  },
];
const dkim = {
  domain_name: "fixture.test",
  key_selector: "measure",
  private_key: generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey,
};
for (const s of scenarios) {
  const f = await runnerFixture({
    realEmailer: true,
    ...(s.signed ? { dkim, sinkPauseMs: 2 } : {}),
  });
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
    let signed = 0;
    f.start();
    let done = false;
    while (!done) {
      for (let i = 0; i < 20; i++) await Bun.sleep(1);
      signed += f.sink.messages.filter((m) => /^DKIM-Signature:/im.test(m.data)).length;
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
        signed,
        seconds: +((performance.now() - started) / 1000).toFixed(1),
        peakArrayBufferMiB: +(peak / mebibyte).toFixed(1),
        peakRssMiB: Math.round(rss / mebibyte),
      }),
    );
  } finally {
    await f.close();
  }
}

// Serial test sends of distinct files while SMTP stalls after its greeting.
{
  const smtp = await startStalledSink();
  const f = await campaignsFixture({ smtpPort: smtp.port });
  try {
    const list = await f.list("stalled");
    await f.subscriber("test@example.com", [list]);
    const input = {
      name: "Stalled",
      subject: "S",
      lists: [list],
      content_type: "plain",
      type: "regular",
      messenger: "fixture",
      body: "B",
      from_email: "Fixture <noreply@fixture.test>",
    };
    const campaign = await f.campaign(input);
    const ids: number[] = [];
    for (let i = 0; i < 16; i++) {
      const body = new FormData();
      const content = new Uint8Array(8 * mebibyte).fill(i);
      body.append("file", new File([content], `stalled-${i}.pdf`, { type: "application/pdf" }));
      const response = await f.request("/api/media", {
        method: "POST",
        headers: f.sessionHeaders,
        body,
      });
      ids.push((await response.json()).data.id);
    }
    const base = held();
    const statuses: Record<number, number> = {};
    let peak = 0;
    for (const id of ids) {
      const { status } = await f.json(`/api/campaigns/${campaign.id}/test`, "POST", {
        ...input,
        media: [id],
        subscribers: ["test@example.com"],
      });
      statuses[status] = (statuses[status] ?? 0) + 1;
      peak = Math.max(peak, held() - base);
    }
    console.log(
      JSON.stringify({
        scenario: "16 serial test sends, own 8 MiB files, stalled SMTP",
        statuses,
        peakArrayBufferMiB: +(peak / mebibyte).toFixed(1),
        peakRssMiB: Math.round(process.memoryUsage().rss / mebibyte),
      }),
    );
  } finally {
    f.clock.advance(60_000);
    await smtp.close();
    await f.close();
  }
}
