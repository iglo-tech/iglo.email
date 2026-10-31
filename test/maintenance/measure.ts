// Serial timing for docs/perf/M4.6-maintenance.md; opt-in, not a CI threshold. Real HTTP against the
// compiled build on a generated database of 1,000,000 subscribers, while a client requests a view
// pixel every 5 ms (one short write on the server's thread) and a second process watches the write
// lock (test/maintenance/measure-probe.ts). Each operation runs once, as each consumes its rows.
// Usage: bun run build && bun test/maintenance/measure.ts [subscribers]
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { provisionApiUser } from "@/test/contract/owned";

const repository = resolve(import.meta.dir, "../..");
const executable = join(repository, "dist/iglo.email");
const subscribers = Number(process.argv[2] ?? 1_000_000);
const base = join(repository, "upstream/measurements");
mkdirSync(base, { recursive: true });
const dataDir = mkdtempSync(join(base, "m46-"));

const admin = { user: "measure-admin", password: "measure-admin-password" };
const YEAR = 365 * 86_400_000;
const now = Date.now();
const stamp = (i: number, total: number) => new Date(now - YEAR + (i / total) * YEAR).toISOString();

function seed(db: Database) {
  const started = performance.now();
  db.run("PRAGMA synchronous = OFF");
  db.run("BEGIN IMMEDIATE");
  for (let i = 1; i <= 21; i++)
    db.run("INSERT INTO lists (uuid, name, type, optin) VALUES (?, ?, 'public', ?)", [
      crypto.randomUUID(),
      `measure ${i}`,
      i === 21 ? "double" : "single",
    ]);
  const person = db.prepare(
    `INSERT INTO subscribers (uuid, email, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const member = db.prepare(
    `INSERT INTO subscriber_lists (subscriber_id, list_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  // 10% blocklisted, 20% orphans, 20% unconfirmed on the double opt-in list, the rest on two lists.
  for (let i = 1; i <= subscribers; i++) {
    const at = stamp(i, subscribers);
    const kind = i % 10;
    const blocklisted = kind === 0;
    person.run(
      crypto.randomUUID(),
      `measure-${i}@example.test`,
      `Measure ${i}`,
      blocklisted ? "blocklisted" : "enabled",
      at,
      at,
    );
    if (kind === 1 || kind === 2) continue;
    if (kind === 3 || kind === 4) member.run(i, 21, "unconfirmed", at, at);
    else {
      const status = blocklisted ? "unsubscribed" : "confirmed";
      member.run(i, 1 + (i % 20), status, at, at);
      if (i % 2) member.run(i, 1 + ((i + 7) % 20), status, at, at);
    }
  }
  const campaign = db.prepare(
    `INSERT INTO campaigns (uuid, name, subject, from_email, body, status, type, messenger, template_id)
     VALUES (?, ?, 's', 'a@example.test', 'b', 'finished', 'regular', 'email', NULL)`,
  );
  for (let i = 1; i <= 100; i++) campaign.run(crypto.randomUUID(), `measure ${i}`);
  db.run(
    `INSERT INTO links (uuid, url) VALUES ('${crypto.randomUUID()}', 'https://example.test/a')`,
  );
  const views = db.prepare(
    "INSERT INTO campaign_views (campaign_id, subscriber_id, created_at) VALUES (?, ?, ?)",
  );
  const clicks = db.prepare(
    "INSERT INTO link_clicks (campaign_id, link_id, subscriber_id, created_at) VALUES (?, 1, ?, ?)",
  );
  for (let i = 1; i <= 1_000_000; i++) {
    const owner = 1 + ((i * 7) % subscribers);
    views.run(1 + (i % 100), owner, stamp(i, 1_000_000));
    if (i % 2) clicks.run(1 + (i % 100), owner, stamp(i, 1_000_000));
  }
  // A sent transactional message for the blocklisted and half the orphans, to anonymize.
  const send = db.prepare(
    `INSERT INTO sends (uuid, source, kind, subscriber_id, to_email, status, payload, sent_at)
     VALUES (?, 'tx', 'transactional', ?, ?, 'sent', '{}', ?)`,
  );
  for (let i = 1; i <= subscribers; i++) {
    if (i % 10 < 2)
      send.run(crypto.randomUUID(), i, `measure-${i}@example.test`, stamp(i, subscribers));
  }
  db.run("COMMIT");
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  return Math.round((performance.now() - started) / 1000);
}

interface Result {
  operation: string;
  rows: number | string;
  seconds: number;
  lockMs: number;
  pixelMs: number;
  pixelP99: number;
  pixels: number;
}
const results: Result[] = [];

/** The server on the data directory, up. It is seeded stopped: a loop gives up on a held lock. */
async function serve() {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = Bun.spawn(
    [executable, "serve", "--host", "127.0.0.1", "--port", String(port), "--data-dir", dataDir],
    {
      env: {
        PATH: "",
        IGLO_EMAIL_ADMIN_USER: admin.user,
        IGLO_EMAIL_ADMIN_PASSWORD: admin.password,
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const origin = `http://127.0.0.1:${port}`;
  for (const deadline = Date.now() + 30_000; ; await Bun.sleep(50)) {
    if ((await fetch(`${origin}/health`).catch(() => null))?.ok) break;
    if (Date.now() > deadline) throw new Error("server did not start");
  }
  const stop = async () => {
    child.kill("SIGTERM");
    await child.exited;
  };
  return { origin, stop };
}

const first = await serve();
const credentials = await provisionApiUser(first.origin, admin);
await first.stop();
const running: { stop?: () => Promise<void> } = {};
try {
  await (async () => {
    const authorization = `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`;
    const file = join(dataDir, "iglo-email.db");
    const db = new Database(file);
    const seeded = seed(db);
    console.log(`seeded in ${seeded} s, ${Math.round(statSync(file).size / 1048576)} MiB`);
    const { uuid: campaign } = db.query("SELECT uuid FROM campaigns LIMIT 1").get() as {
      uuid: string;
    };
    const { uuid: reader } = db.query("SELECT uuid FROM subscribers WHERE id = 5").get() as {
      uuid: string;
    };
    db.close();
    const { origin, stop } = await serve();
    running.stop = stop;
    const put = (path: string, body: unknown) =>
      fetch(`${origin}${path}`, {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await put("/api/settings/privacy.individual_tracking", true);

    const measured = async (
      operation: string,
      work: () => Promise<number | string>,
    ): Promise<void> => {
      const probe = Bun.spawn(["bun", join(import.meta.dir, "measure-probe.ts"), file], {
        stdin: "pipe",
        stdout: "pipe",
      });
      let running = true;
      const pixels: number[] = [];
      const pixel = (async () => {
        while (running) {
          const started = performance.now();
          const response = await fetch(`${origin}/campaign/${campaign}/${reader}/px.png`);
          await response.arrayBuffer();
          if (response.status !== 200) throw new Error(`pixel ${response.status}`);
          pixels.push(performance.now() - started);
          await Bun.sleep(5);
        }
      })();
      const started = performance.now();
      const rows = await work();
      const seconds = (performance.now() - started) / 1000;
      running = false;
      await pixel;
      await probe.stdin.end();
      const lockMs = Number(await new Response(probe.stdout).text());
      const result = {
        operation,
        rows,
        seconds: +seconds.toFixed(1),
        lockMs,
        pixelMs: +Math.max(...pixels).toFixed(1),
        pixelP99: +pixels.sort((a, b) => a - b)[Math.floor(pixels.length * 0.99)]!.toFixed(1),
        pixels: pixels.length,
      };
      results.push(result);
      console.log(JSON.stringify(result));
    };
    const remove = async (path: string) => {
      const response = await fetch(`${origin}/api/maintenance/${path}`, {
        method: "DELETE",
        headers: { authorization },
      });
      const body = (await response.json()) as { data: { count: number } | true; message?: string };
      if (response.status !== 200) throw new Error(`${path}: ${response.status} ${body.message}`);
      return body.data === true ? "" : body.data.count;
    };
    const exported = async (type: string) => {
      const since = new Date(now - 2 * YEAR).toISOString();
      const response = await fetch(
        `${origin}/api/maintenance/analytics/${type}/export?since=${encodeURIComponent(since)}`,
        { headers: { authorization } },
      );
      let lines = 0;
      for await (const chunk of response.body!)
        for (let at = -1; (at = (chunk as Buffer).indexOf(10, at + 1)) >= 0;) lines++;
      return lines - 1;
    };

    await measured("Idle, the pixel alone, 5 s", async () => {
      await Bun.sleep(5000);
      return "";
    });
    await measured("Export views", () => exported("views"));
    await measured("Export clicks", () => exported("clicks"));
    await measured("Unconfirmed subscriptions", () =>
      remove(
        `subscriptions/unconfirmed?before_date=${encodeURIComponent(new Date(now).toISOString())}`,
      ),
    );
    const half = encodeURIComponent(new Date(now - YEAR / 2).toISOString());
    await measured("Analytics: views, the older half", () =>
      remove(`analytics/views?before_date=${half}`),
    );
    await measured("Analytics: all, the rest", () =>
      remove(`analytics/all?before_date=${encodeURIComponent(new Date(now + 1000).toISOString())}`),
    );
    await measured("Orphans", () => remove("subscribers/orphan"));
    await measured("Blocklisted", () => remove("subscribers/blocklisted"));
    await measured("Orphans again, a walk that finds none", () => remove("subscribers/orphan"));

    // One webhook on subscriber.deleted, with a selection inside the budget.
    const receiver = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("ok"),
    });
    const hook = await fetch(`${origin}/api/webhooks`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://127.0.0.1:${receiver.port}/hook`,
        events: ["subscriber.deleted"],
      }),
    });
    if (hook.status !== 200) throw new Error(`hook ${hook.status}`);
    const again = new Database(file);
    again.run("PRAGMA busy_timeout = 10000");
    again.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000)
      INSERT INTO subscribers (uuid, email, name, status)
      SELECT lower(hex(randomblob(16))), 'hooked' || i || '@example.test', 'h', 'blocklisted' FROM n`);
    again.close();
    await measured("Blocklisted, 50,000 with one webhook", () => remove("subscribers/blocklisted"));
    receiver.stop(true);

    // Why not one statement: the same kind of delete, on the server's own connection settings.
    const direct = new Database(file);
    direct.run("PRAGMA busy_timeout = 10000");
    direct.run("PRAGMA synchronous = FULL");
    direct.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500000)
      INSERT INTO campaign_views (campaign_id, subscriber_id, created_at)
      SELECT 1 + i % 100, (SELECT min(id) FROM subscribers WHERE id >= (i * 7) % ${subscribers}),
        '2020-01-01T00:00:00.000Z' FROM n`);
    const started = performance.now();
    direct.run("DELETE FROM campaign_views WHERE created_at < '2021-01-01'");
    console.log(`one DELETE of 500,000 views: ${Math.round(performance.now() - started)} ms`);
    direct.run("PRAGMA wal_checkpoint(TRUNCATE)");
    direct.close();
  })();
} finally {
  await running.stop?.();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(
  results
    .map(
      (r) =>
        `| ${r.operation} | ${r.rows} | ${r.seconds} | ${r.lockMs} | ${r.pixelP99} | ${r.pixelMs} |`,
    )
    .join("\n"),
);
