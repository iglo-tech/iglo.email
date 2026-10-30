// Before/after measurements for M2.5 (docs/perf/M2.5-public.md). Handler timing goes through the
// router with a real file-backed database at FULL synchronous, without a socket. Copy this file
// into a checkout of another commit to compare; it uses only the shared fixture surface.
import { publicFixture } from "@/test/public/fixture";

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;
const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)]!;
const round = (value: number) => Math.round(value * 100) / 100;
const report = (name: string, values: object) =>
  process.stdout.write(`${JSON.stringify({ name, ...values })}\n`);
const rows = 100_000;
const rounds = 150;
const f = await publicFixture();
try {
  await f.stopOutbox();
  const list = await f.list("Double", "public", "double");
  const known = await f.subscriber("confirmed@measure.test", "Known", {
    lists: [list.id],
    preconfirm_subscriptions: true,
  });
  const blocked = await f.subscriber("blocked@measure.test");
  await f.json(`/api/subscribers/${blocked}/blocklist`, "PUT");
  await f.subscriber("pending@measure.test", "Pending", { lists: [list.id] });
  if (!known) throw new Error("Invalid measurement setup");

  // Signup answers by state, interleaved so drift lands on every state alike.
  const signup = async (email: string, peer: string) => {
    const start = Bun.nanoseconds();
    const response = await f.peer("/api/public/subscription", peer, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, list_uuids: [list.uuid] }),
    });
    const elapsed = (Bun.nanoseconds() - start) / 1e6;
    if (response.status !== 200) throw new Error(`signup ${response.status}`);
    return elapsed;
  };
  const states: Record<string, number[]> = { fresh: [], pending: [], confirmed: [], blocked: [] };
  let peer = 0;
  const address = () => `192.0.${(++peer >> 8) & 255}.${peer & 255}`;
  for (let i = 0; i < rounds; i++) {
    states.fresh!.push(await signup(`fresh-${i}@measure.test`, address()));
    states.pending!.push(await signup("pending@measure.test", address()));
    states.confirmed!.push(await signup("confirmed@measure.test", address()));
    states.blocked!.push(await signup("blocked@measure.test", address()));
  }
  for (const [state, values] of Object.entries(states))
    report("signup", { state, medianMs: round(median(values)), p95Ms: round(p95(values)) });

  // Journal commit rate for sends without a subscriber, which the partial index covers.
  const message = {
    from: "Measure <noreply@measure.test>",
    subject: "Measure",
    contentType: "html" as const,
    body: Buffer.from("<p>Measure</p>"),
  };
  const commits = 2000;
  let start = Bun.nanoseconds();
  for (let i = 0; i < commits; i++)
    f.sends.enqueueRequest({
      sends: [
        {
          subscriberUuid: null,
          send: {
            source: "tx",
            kind: "transactional",
            message: { ...message, to: [`unlinked-${i}@measure.test`] },
          },
        },
      ],
    });
  report("enqueue-unlinked", {
    commits,
    perSecond: Math.round(commits / ((Bun.nanoseconds() - start) / 1e9)),
  });

  // Storage and a wipe against a large journal.
  const pragma = (name: string) =>
    Number(Object.values(f.db.query(`PRAGMA ${name}`).get() as object)[0]);
  const size = () => pragma("page_count") * pragma("page_size");
  f.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  const emptyBytes = size();
  start = Bun.nanoseconds();
  f.db.run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows})
     INSERT INTO sends(uuid, source, kind, to_email, status, smtp_message_id, payload, sent_at)
     SELECT 'row-' || i, 'tx', 'transactional', 'row-' || i || '@measure.test', 'sent',
       '<row-' || i || '@measure.test>', '{}', '2026-10-30T00:00:00.000Z' FROM n`,
  );
  const bulkMs = (Bun.nanoseconds() - start) / 1e6;
  f.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  report("storage", {
    rows,
    bulkInsertMs: round(bulkMs),
    bytesPerRow: Math.round((size() - emptyBytes) / rows),
    databaseMiB: round(size() / 1024 / 1024),
  });
  const wipes: number[] = [];
  for (let i = 0; i < 40; i++) {
    const email = `wipe-${i}@measure.test`;
    const id = await f.subscriber(email);
    f.db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
       INSERT INTO sends(uuid, source, kind, subscriber_id, to_email, status, smtp_message_id, payload)
       SELECT '${email}-' || i, 'tx', 'transactional', ${id}, '${email}', 'sent', '<m>', '{}' FROM n`,
    );
    const { uuid } = (await f.json(`/api/subscribers/${id}`)).body.data;
    start = Bun.nanoseconds();
    const response = await f.peer(`/subscription/wipe/${uuid}`, address(), { method: "POST" });
    wipes.push((Bun.nanoseconds() - start) / 1e6);
    if (response.status !== 200) throw new Error(`wipe ${response.status}`);
  }
  report("wipe", {
    linkedSends: 100,
    journalRows: rows,
    medianMs: round(median(wipes)),
    p95Ms: round(p95(wipes)),
  });
} finally {
  await f.close();
}
