// B145b (14-projects sections 7, 14 invariants 3, 4, 7 and 15 "Rate" and "Guard", D161): the
// dispatcher runs at the effective rate, the lower of messaging.max_send_rate and SES's MaxSendRate,
// and the last-resort guard holds marketing and campaign starts while the latest snapshot leaves at
// most max(2% of Max24HourSend, effective rate × 60 s) of the quota. Each test runs an instance in
// this process on a test clock, with a stand-in for SES v2 GetAccount and a loopback SMTP sink that
// stamps receipts with the test clock. Everything is driven through the HTTP API, the sink and the
// instance's stderr; the guard's campaign lease and the queued rows' claim are read from the
// project's database, read-only, because no API shows a lease.
import { Database } from "bun:sqlite";
import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance, PRIMARY_SLUG } from "@/projects/instance";
import { serveRouted } from "@/server/server";
import { TestClock } from "@/test/server/fixture";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import { adminCredentials, api, createApiUser, logIn } from "@/test/projects/fixture";
import { asBody } from "@/test/read-body";
import { startSink } from "@/test/tx/sink";

setDefaultTimeout(60_000);

const HOST = "127.0.0.1";
const GUARD = "[instance] SES quota guard: ";

interface Quota {
  max: number;
  sent: number;
  rate: number;
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const turns = async (count = 10) => {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

/**
 * An instance with one project, its loops started on a test clock. `quota` is what the stand-in
 * answers and may be changed between reads; `credentials: false` saves no SES API keys.
 */
async function guarded(options: { setting: number; quota: Quota; credentials?: boolean }) {
  // Every stderr line, kept for the guard's attention lines and not printed.
  const errors = spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(() => errors.mockRestore());
  const lines = () =>
    errors.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith(GUARD))
      .map((line) => line.slice(GUARD.length));
  const clock = new TestClock();
  const sink = await startSink({ clock });
  cleanup.push(() => sink.close());
  const quota = { ...options.quota };
  let reads = 0;
  const ses = Bun.serve({
    port: 0,
    hostname: HOST,
    fetch: () => {
      reads++;
      return Response.json({
        SendQuota: {
          Max24HourSend: quota.max,
          MaxSendRate: quota.rate,
          SentLast24Hours: quota.sent,
        },
        ProductionAccessEnabled: true,
        SendingEnabled: true,
      });
    },
  });
  cleanup.push(() => ses.stop(true));
  const admin = await adminCredentials();
  const dataDir = await mkdtemp(join(tmpdir(), "iglo-email-b145b-guard-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const instance = await openInstance(
    {
      dataDir,
      rootUrl: `http://${HOST}`,
      listen: { host: HOST, port: 0 },
      seed: { admin: { user: admin.user, password: admin.password } },
      sesEndpoint: () => `http://${HOST}:${ses.port}`,
    },
    clock,
  );
  const server = serveRouted({ host: HOST, port: 0 }, (incoming, peer) =>
    instance.dispatch(incoming, peer),
  );
  instance.attach(server);
  cleanup.push(async () => {
    await Promise.allSettled(instance.stop());
    await server.stop(true);
    await instance.close();
  });
  const port = server.port!;
  const operator = (await instanceLogin(port, HOST, admin)).session!;
  const current = await instanceCall(port, HOST, operator, "GET", "/api/instance/settings");
  const { data } = asBody<{ data: Record<string, unknown> }>(await current.json());
  const smtp = asBody<Array<Record<string, unknown>>>(data.smtp).map((item, index) =>
    index === 0
      ? {
          ...item,
          enabled: true,
          host: HOST,
          port: sink.port,
          tls_type: "none",
          auth_protocol: "none",
        }
      : item,
  );
  const saved = await instanceCall(port, HOST, operator, "PUT", "/api/instance/settings", {
    ...data,
    smtp,
    "messaging.max_send_rate": options.setting,
    ...(options.credentials === false
      ? {}
      : {
          "ses.api_region": "eu-west-1",
          "ses.api_access_key_id": "AKIAIOSFODNN7EXAMPLE",
          "ses.api_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        }),
  });
  expect(saved.status).toBe(200);
  const key = await createApiUser(port, HOST, await logIn(port, HOST, admin), "guard");
  let failed: unknown;
  instance.start((failure) => {
    failed = failure ?? new Error("a loop failed");
  });
  cleanup.push(() => {
    expect(failed).toBeUndefined();
  });

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await api(port, HOST, key, method, path, body);
    if (response.status !== 200) {
      throw new Error(`${method} ${path}: ${response.status} ${response.text}`);
    }
    return asBody<{ data: T }>(JSON.parse(response.text)).data;
  };

  /** Waits until the sink has taken no message for three quiet polls. */
  const settle = async () => {
    let last = -1;
    let quiet = 0;
    while (quiet < 3) {
      await turns();
      await Bun.sleep(2);
      const now = sink.messages.length;
      quiet = now === last ? quiet + 1 : 0;
      last = now;
    }
  };
  /** Moves the clock `ms` in steps of `step`, settling after each. */
  const run = async (ms: number, step: number) => {
    for (let moved = 0; moved < ms; moved += step) {
      clock.advance(step);
      await settle();
    }
  };
  /** Steps the clock until `done`, or fails after 20 s of real time. */
  const until = async (done: () => boolean | Promise<boolean>, step: number, what: string) => {
    const end = Date.now() + 20_000;
    while (!(await done())) {
      if (Date.now() > end) {
        throw new Error(`${what}: ${sink.messages.length} received`);
      }
      clock.advance(step);
      await settle();
    }
  };

  /** A single opt-in list with `count` confirmed members; their addresses. */
  const audience = async (name: string, count: number) => {
    const list = await call<{ id: number }>("POST", "/api/lists", {
      name,
      type: "public",
      optin: "single",
    });
    const emails: Array<string> = [];
    for (let i = 0; i < count; i++) {
      const email = `${name}-${i}@example.test`;
      await call("POST", "/api/subscribers", {
        email,
        name: `${name} ${i}`,
        status: "enabled",
        lists: [list.id],
        preconfirm_subscriptions: true,
      });
      emails.push(email);
    }
    return { id: list.id, emails };
  };
  const templates = await call<Array<{ id: number; type: string }>>("GET", "/api/templates");
  const template = templates.find((item) => item.type === "tx")!.id;

  /** The send log's statuses by kind. */
  const sends = async () => {
    const page = await call<{ results: Array<{ kind: string; status: string }> }>(
      "GET",
      "/api/sends?per_page=100",
    );
    return (kind: string, status: string) =>
      page.results.filter((row) => row.kind === kind && row.status === status).length;
  };
  /** Reads the project's database, read-only: what no API shows. */
  const peek = <T>(sql: string): T => {
    const db = new Database(join(dataDir, "projects", PRIMARY_SLUG, "iglo-email.db"), {
      readonly: true,
    });
    try {
      return asBody<T>(db.query(sql).get());
    } finally {
      db.close();
    }
  };
  const received = (emails: ReadonlyArray<string>) =>
    sink.messages.filter((message) => emails.includes(message.to[0] ?? "")).length;

  // The first read happens at start; wait for it to land before anything is measured.
  if (options.credentials !== false) {
    await until(
      async () =>
        reads > 0 && (await call<{ available: boolean }>("GET", "/api/sending/capacity")).available,
      0,
      "the first SES read",
    );
  }

  return {
    clock,
    sink,
    quota,
    reads: () => reads,
    lines,
    call,
    run,
    until,
    settle,
    audience,
    template,
    sends,
    peek,
    received,
    check: () => instanceCall(port, HOST, operator, "POST", "/api/instance/settings/ses/check", {}),
    /** The instance Settings page as the admin gets it. */
    settingsPage: async () =>
      (await instanceCall(port, HOST, operator, "GET", "/admin/instance/settings")).text(),
  };
}
type Guarded = Awaited<ReturnType<typeof guarded>>;

/** Async transactional sends to `emails`: rows the outbox paces through the dispatcher. */
const transactional = (f: Guarded, emails: Array<string>) =>
  f.call("POST", "/api/tx", { subscriber_emails: emails, template_id: f.template, async: true });

// --- Rate ---

test("the effective rate is SES's MaxSendRate when it is lower than the setting, and follows a new snapshot", async () => {
  // Setting 10/s, SES 2/s: two starts a second. A large quota, far from any line.
  const f = await guarded({ setting: 10, quota: { max: 1_000_000, sent: 0, rate: 2 } });
  const people = await f.audience("rate", 40);
  await transactional(f, people.emails);
  await f.run(3000, 100);
  const first = f.sink.messages.length;
  expect(first).toBeGreaterThanOrEqual(4);
  expect(first).toBeLessThanOrEqual(7);
  // A new snapshot with SES at 5/s: the dispatcher re-reads the rate at once.
  f.quota.rate = 5;
  expect((await f.check()).status).toBe(200);
  await f.run(3000, 100);
  const second = f.sink.messages.length - first;
  expect(second).toBeGreaterThanOrEqual(13);
  expect(second).toBeLessThanOrEqual(16);
  // Instance settings shows SES's rate beside the setting, and the warning while it is higher.
  const page = await f.settingsPage();
  expect(page).toContain("SES allows 5/s.");
  expect(page).toContain('data-testid="ses-rate-warning"');
  expect(page).toContain("The setting is higher than the rate SES allows: sending runs at 5/s.");
});

test("the effective rate is the setting when it is lower than SES's MaxSendRate", async () => {
  const f = await guarded({ setting: 2, quota: { max: 1_000_000, sent: 0, rate: 10 } });
  const people = await f.audience("rate", 30);
  await transactional(f, people.emails);
  await f.run(3000, 100);
  expect(f.sink.messages.length).toBeGreaterThanOrEqual(4);
  expect(f.sink.messages.length).toBeLessThanOrEqual(7);
});

// --- Guard ---

/**
 * The guard at its line: marketing rows stay queued with no claim, a running campaign keeps its
 * cursor and its heartbeat, a transactional call is delivered; three minutes of unchanged reads
 * do not lift it; a newer snapshot one above the line does, and everything is sent. One attention
 * line marks the start and one the end.
 */
async function holdAndResume(quota: Quota, line: number) {
  const atLine = quota.max - line;
  const f = await guarded({ setting: 14, quota: { ...quota, sent: atLine } });
  expect(f.lines()).toEqual([
    `holding marketing and campaign sends: ${line} of the 24-hour quota of ${quota.max} left, at or below the hold line of ${line} (snapshot read at ${f.clock.now().toISOString()})`,
  ]);
  const news = await f.audience("news", 5);
  const letter = await f.audience("letter", 5);
  const people = await f.audience("people", 1);
  await f.call("POST", "/api/tx", {
    subscriber_emails: news.emails,
    template_id: f.template,
    kind: "marketing",
    list_id: news.id,
    async: true,
  });
  const campaign = await f.call<{ id: number }>("POST", "/api/campaigns", {
    name: "Held",
    subject: "Held",
    lists: [letter.id],
    from_email: "Guard <guard@example.test>",
    content_type: "plain",
    type: "regular",
    messenger: "email",
    body: "Hello",
  });
  await f.call("PUT", `/api/campaigns/${campaign.id}/status`, { status: "running" });
  // Transactional mail is never held: a synchronous call is delivered while the guard holds.
  let answered: { sends: Array<{ status: string }> } | undefined;
  const sync = f
    .call<{ sends: Array<{ status: string }> }>("POST", "/api/tx", {
      subscriber_emails: people.emails,
      template_id: f.template,
    })
    .then((data) => {
      answered = data;
    });
  await f.until(() => answered !== undefined, 50, "the transactional call");
  await sync;
  expect(answered!.sends.map((send) => send.status)).toEqual(["sent"]);
  expect(f.received(people.emails)).toBe(1);
  // The campaign has opened: it holds its lease and waits for slots.
  await f.until(
    () =>
      f.peek<{ lease: string | null }>(`SELECT runner_lease AS lease FROM campaigns`).lease !==
      null,
    100,
    "the campaign's lease",
  );
  const leaseAt = () =>
    Date.parse(
      f.peek<{ until: string }>(`SELECT runner_lease_until AS until FROM campaigns`).until,
    );
  const cursor = () =>
    f.peek<{ cursor: number }>(`SELECT last_subscriber_id AS cursor FROM campaigns`).cursor;
  const startCursor = cursor();
  const firstLease = leaseAt();
  // Three minutes pass with the same answer from SES, read every minute: still held.
  const readsBefore = f.reads();
  await f.run(180_000, 1000);
  expect(f.reads()).toBeGreaterThanOrEqual(readsBefore + 3);
  let count = await f.sends();
  expect(count("marketing", "queued")).toBe(5);
  expect(count("marketing", "sending")).toBe(0);
  expect(
    f.peek<{ claimed: number }>(
      `SELECT count(*) AS claimed FROM sends WHERE kind = 'marketing' AND claimed_until IS NOT NULL`,
    ).claimed,
  ).toBe(0);
  const held = await f.call<{ status: string; sent: number }>(
    "GET",
    `/api/campaigns/${campaign.id}`,
  );
  expect({ status: held.status, sent: held.sent }).toEqual({ status: "running", sent: 0 });
  expect(cursor()).toBe(startCursor);
  // The heartbeat renewed the lease past the three minutes.
  expect(leaseAt()).toBeGreaterThan(firstLease);
  expect(leaseAt()).toBeGreaterThan(f.clock.now().getTime());
  expect(f.received([...news.emails, ...letter.emails])).toBe(0);
  expect(f.lines()).toHaveLength(1);
  // A newer snapshot one above the line: the guard lifts, and everything held is sent.
  f.quota.sent = atLine - 1;
  await f.until(
    () => f.received([...news.emails, ...letter.emails]) === 10,
    200,
    "the held mail after the guard lifted",
  );
  expect(f.lines()).toHaveLength(2);
  expect(f.lines()[1]).toStartWith(
    `resuming marketing and campaign sends: ${line + 1} of the 24-hour quota of ${quota.max} left, above the hold line of ${line} (snapshot read at `,
  );
  await f.until(
    async () =>
      (await f.call<{ status: string }>("GET", `/api/campaigns/${campaign.id}`)).status ===
      "finished",
    200,
    "the campaign's end",
  );
  count = await f.sends();
  expect(count("marketing", "sent")).toBe(5);
  // Each message once: nothing granted before or during the hold was sent twice.
  expect(f.sink.messages).toHaveLength(11);
  expect(f.lines()).toHaveLength(2);
}

test("guard, 2% term: a 1,000,000 quota holds at 20,000 left and resumes at 20,001", async () => {
  // max(2% of 1,000,000 = 20,000, 14 × 60 = 840) = 20,000.
  await holdAndResume({ max: 1_000_000, sent: 0, rate: 14 }, 20_000);
});

test("guard, rate term: a 10,000 quota at rate 14 holds at 840 left and resumes at 841", async () => {
  // max(2% of 10,000 = 200, 14 × 60 = 840) = 840: the 2% term alone would let SES refuse mail.
  await holdAndResume({ max: 10_000, sent: 0, rate: 14 }, 840);
});

test("without SES API credentials there is no guard: marketing at the would-be line is sent", async () => {
  const f = await guarded({
    setting: 14,
    quota: { max: 10_000, sent: 9160, rate: 14 },
    credentials: false,
  });
  const news = await f.audience("news", 5);
  await f.call("POST", "/api/tx", {
    subscriber_emails: news.emails,
    template_id: f.template,
    kind: "marketing",
    list_id: news.id,
    async: true,
  });
  await f.until(() => f.received(news.emails) === 5, 200, "the marketing sends");
  expect(f.reads()).toBe(0);
  expect(f.lines()).toEqual([]);
  // Instance settings says the setting alone applies, with no forecast and no guard.
  const page = await f.settingsPage();
  expect(page).toContain("No SES API credentials are saved: the setting alone applies");
  expect(page).not.toContain("SES allows");
});
