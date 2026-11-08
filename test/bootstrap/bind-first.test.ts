// The port is bound before any background loop starts (B52, src/main.ts). A start that cannot
// bind does nothing: the queued send, the running campaign and the due webhook delivery that its
// loops would claim stay as they were, and the receiver gets no request. Rows are written into a
// stopped data directory, as test/retention/main-wiring.test.ts does, and read back once the
// process has exited: a queued row has no API that shows it while no loop runs.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createServer, type Server as NetServer } from "node:net";
import { join } from "node:path";
import { encodePayload } from "@/messaging/payload";
import {
  buildExecutable,
  removeDirectory,
  startServer,
  temporaryDirectory,
} from "@/test/backup/fixture";

setDefaultTimeout(60_000);

const SEND = "00000000-0000-4000-8000-0000000000b5";
const CAMPAIGN = "00000000-0000-4000-8000-0000000000c5";
const DELIVERY = "00000000-0000-4000-8000-0000000000d5";

let build = "";
let executable = "";
const cleanup: Array<() => void | Promise<void>> = [];

beforeAll(async () => {
  build = temporaryDirectory();
  executable = await buildExecutable(build);
});
afterAll(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
  removeDirectory(build);
});

/** A data directory with one first start's schema and one queued send, campaign and delivery. */
async function seeded(receiverUrl: string): Promise<string> {
  const base = temporaryDirectory();
  cleanup.push(() => removeDirectory(base));
  const dataDir = join(base, "data");
  const first = await startServer(executable, dataDir);
  await first.stop();

  const now = new Date();
  const past = new Date(now.getTime() - 60_000).toISOString();
  const payload = encodePayload(
    {
      from: "Bind <bind@example.test>",
      to: ["queued@example.test"],
      subject: "Queued before the bind",
      contentType: "plain",
      body: new TextEncoder().encode("Queued before the bind"),
      headers: {},
      attachments: [],
    },
    null,
  );
  const db = new Database(join(dataDir, "iglo-email.db"), { readwrite: true, strict: true });
  try {
    db.run(
      `INSERT INTO sends (uuid, source, kind, to_email, status, payload, created_at)
       VALUES (?, 'tx', 'transactional', 'queued@example.test', 'queued', ?, ?)`,
      [SEND, payload, past],
    );
    db.run(
      `INSERT INTO campaigns (uuid, name, subject, from_email, body, content_type, messenger,
         status, send_at, created_at, updated_at)
       VALUES (?, 'Due before the bind', 'Due', 'news@example.test', '<p>Due</p>', 'html', 'email',
         'running', ?, ?, ?)`,
      [CAMPAIGN, past, past, past],
    );
    db.run("INSERT INTO webhooks (id, url, secret, events) VALUES (1, ?, 'secret', '[]')", [
      receiverUrl,
    ]);
    db.run(
      `INSERT INTO webhook_deliveries (uuid, webhook_id, event, payload, status, next_attempt_at,
         created_at, updated_at)
       VALUES (?, 1, 'subscriber.created', '{}', 'queued', ?, ?, ?)`,
      [DELIVERY, past, past, past],
    );
  } finally {
    db.close(true);
  }
  return dataDir;
}

/** A webhook receiver the test owns; it counts every request it answers. */
function receiver() {
  let hits = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      hits++;
      return new Response("ok");
    },
  });
  cleanup.push(() => server.stop(true));
  return {
    url: `http://127.0.0.1:${server.port}/hook`,
    get hits() {
      return hits;
    },
  };
}

/** A port the test holds open, so the server's bind must fail. */
async function occupy(): Promise<{ port: number; server: NetServer }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("occupied address");
  return { port: address.port, server };
}

/** One `serve` on a port, run to its end: exit code and stderr. A watchdog ends a hang. */
async function serveOn(dataDir: string, port: number) {
  const child = Bun.spawn(
    [executable, "serve", "--host", "127.0.0.1", "--port", String(port), "--data-dir", dataDir],
    { env: { PATH: "" }, stdout: "pipe", stderr: "pipe" },
  );
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(watchdog);
  return { exitCode, stderr };
}

/** The rows the loops would claim, as the database holds them now. */
function state(dataDir: string) {
  const db = new Database(join(dataDir, "iglo-email.db"), { readonly: true, strict: true });
  try {
    const send = db
      .query<{ status: string; attempts: number; claimed_until: string | null }, [string]>(
        "SELECT status, attempts, claimed_until FROM sends WHERE uuid = ?",
      )
      .get(SEND)!;
    const campaign = db
      .query<{ status: string; runner_lease: string | null }, [string]>(
        "SELECT status, runner_lease FROM campaigns WHERE uuid = ?",
      )
      .get(CAMPAIGN)!;
    const deliveries = db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM campaign_deliveries WHERE campaign_id = (SELECT id FROM campaigns WHERE uuid = ?)",
      )
      .get(CAMPAIGN)!;
    const delivery = db
      .query<{ status: string; attempts: number }, [string]>(
        "SELECT status, attempts FROM webhook_deliveries WHERE uuid = ?",
      )
      .get(DELIVERY)!;
    return { send, campaign, claimedRecipients: deliveries.n, delivery };
  } finally {
    db.close();
  }
}

test("a start whose port is taken claims no send, campaign or webhook delivery", async () => {
  const hook = receiver();
  const dataDir = await seeded(hook.url);
  const { port } = await occupy();

  const result = await serveOn(dataDir, port);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/port \d+ in use/);
  expect(state(dataDir)).toEqual({
    send: { status: "queued", attempts: 0, claimed_until: null },
    campaign: { status: "running", runner_lease: null },
    claimedRecipients: 0,
    delivery: { status: "queued", attempts: 0 },
  });
  expect(hook.hits).toBe(0);
});

test("a normal start after a failed bind serves /health and runs its loops", async () => {
  const hook = receiver();
  const dataDir = await seeded(hook.url);
  const { port } = await occupy();
  expect((await serveOn(dataDir, port)).exitCode).toBe(1);

  const server = await startServer(executable, dataDir);
  cleanup.push(() => server.kill());
  const health = await fetch(server.health, { signal: AbortSignal.timeout(2_000) });
  expect(health.ok).toBe(true);

  // The loops start after the bind; the queued send and the due delivery are claimed at once.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && (state(dataDir).send.status === "queued" || hook.hits === 0)) {
    await Bun.sleep(50);
  }
  expect(state(dataDir).send.status).not.toBe("queued");
  expect(hook.hits).toBeGreaterThan(0);
  await server.stop();
});
