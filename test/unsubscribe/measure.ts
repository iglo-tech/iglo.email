// Serial in-process measurements for docs/perf/M2.4-unsubscribe.md; not a CI threshold.
// MEASURE_PART=tx runs only the transactional path, which also exists before M2.4.
import { createRealClock } from "@/clock";
import { txFixture } from "@/test/tx/fixture";

const N = Number(process.env.UNSUB_MEASURE_N ?? "200");
const part = process.env.MEASURE_PART ?? "all";
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2),
    p50: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
  };
};
const rss = () => Math.round(process.memoryUsage().rss / 1048576);
const results: Record<string, unknown> = { n: N, bun: Bun.version, part, rssStartMiB: rss() };
const body =
  '<p>Hello {{ subscriber.name }} <a href="{{ "https://example.test/offer" | track_link }}">offer</a></p>';

{
  // Transactional sync sends to linked subscribers through POST /api/tx.
  const f = await txFixture({ clock: createRealClock() });
  const template = await f.template(body);
  const ids: number[] = [];
  for (let i = 0; i < N; i++) ids.push(await f.subscriber(`tx-${i}@example.test`, `Tx ${i}`));
  const latencies: number[] = [];
  const started = performance.now();
  for (const id of ids) {
    const t = performance.now();
    const r = await f.tx({ subscriber_id: id, template_id: template });
    if (r.status !== 200 || r.body.data.sends[0].status !== "sent") throw new Error("tx failed");
    latencies.push(performance.now() - t);
  }
  results.txSync = {
    requestMs: stats(latencies),
    sentPerSecond: Math.round((N * 1000) / (performance.now() - started)),
  };
  await f.close();
}

if (part === "all") {
  const f = await txFixture({ clock: createRealClock() });
  const template = await f.template(`${body}<a href="{{ unsubscribe_url }}">u</a>{{ track_view }}`);
  const list = (
    await f.json("/api/lists", "POST", { name: "measure", type: "public", optin: "single" })
  ).body.data.id as number;
  const ids: number[] = [];
  for (let i = 0; i < N; i++)
    ids.push(await f.subscriber(`m-${i}@example.test`, `M ${i}`, { lists: [list] }));
  // Synthetic history: 20,000 older delivered marketing rows across the subscribers,
  // outside the cap window, so the cap query runs against a populated journal.
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  f.db.run("BEGIN");
  const insert = f.db.prepare(
    "INSERT INTO sends(uuid, source, kind, subscriber_id, to_email, list_id, status, smtp_message_id, created_at, sent_at) VALUES (?, 'tx', 'marketing', ?, ?, ?, 'sent', ?, ?, ?)",
  );
  for (let i = 0; i < 20_000; i++) {
    const id = ids[i % N]!;
    const uuid = crypto.randomUUID();
    insert.run(uuid, id, `m-${i % N}@example.test`, list, `<${uuid}@x>`, old, old);
  }
  f.db.run("COMMIT");
  const send = (id: number) =>
    f.tx({ subscriber_id: id, template_id: template, kind: "marketing", list_id: list });
  const sent: number[] = [];
  const uuids: string[] = [];
  let started = performance.now();
  for (const id of ids) {
    const t = performance.now();
    const r = await send(id);
    if (r.status !== 200 || r.body.data.sends[0].status !== "sent") throw new Error("send failed");
    uuids.push(r.body.data.sends[0].uuid);
    sent.push(performance.now() - t);
  }
  results.marketingSync = {
    requestMs: stats(sent),
    sentPerSecond: Math.round((N * 1000) / (performance.now() - started)),
  };
  const capped: number[] = [];
  for (const id of ids) {
    const t = performance.now();
    const r = await send(id);
    if (r.body.data.sends[0].status !== "skipped") throw new Error("cap failed");
    capped.push(performance.now() - t);
  }
  results.marketingCapSkipMs = stats(capped);
  const mails = f.sink.messages.slice(-N);
  const link = (data: string) =>
    /http:\/\/fixture\.test(\/m\/[0-9a-f-]+\/link\/[0-9a-f-]+)/.exec(
      data.replace(/=\r\n/g, "").replace(/=3D/g, "="),
    )![1]!;
  const timed = async (fn: (i: number) => Promise<Response>, expected: number) => {
    const values: number[] = [];
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      const response = await fn(i);
      await response.arrayBuffer();
      if (response.status !== expected) throw new Error(`public route ${response.status}`);
      values.push(performance.now() - t);
    }
    return stats(values);
  };
  const subscriberUuid = async (id: number) =>
    (await f.json(`/api/subscribers/${id}`)).body.data.uuid as string;
  const subs: string[] = [];
  for (const id of ids) subs.push(await subscriberUuid(id));
  results.publicMs = {
    pixel: await timed((i) => f.request(`/m/${uuids[i]}/px.png`), 200),
    linkRedirect: await timed((i) => f.request(link(mails[i]!.data)), 307),
    page: await timed((i) => f.request(`/m/${uuids[i]}/unsubscribe/${subs[i]}`), 200),
    oneClick: await timed(
      (i) =>
        f.request(`/m/${uuids[i]}/unsubscribe/${subs[i]}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        }),
      200,
    ),
  };
  results.journalRows = Number(
    (f.db.query("SELECT count(*) AS n FROM sends").get() as { n: bigint }).n,
  );
  await f.close();
}
results.rssEndMiB = rss();
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
