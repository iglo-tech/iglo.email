// One agent-browser pass over the operator screens of B127: the send log, a subscriber's counts,
// events, enrollments and sends, the subscriber list's exact external-ID search, an enrollment's
// timeline, and the dashboard, at 1280 and 390 px. It prints what each screen said, and
// E2E_SHOTS=<directory> keeps a screenshot per screen and width. `bun run e2e:browser:operator`.
// Every agent-browser step is awaited (B127 r2): the SMTP sink runs in this process, so a blocking
// call would stop the sink from greeting, and the server's sends would settle as unknown.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { withStack } from "@/test/e2e/stack";
import { admin } from "@/test/worked-example/harness";

const session = `b127-${randomBytes(6).toString("hex")}`;
const shots = process.env.E2E_SHOTS;
async function browser(...args: Array<string>): Promise<string> {
  const run = Bun.spawn(
    ["agent-browser", "--session", session, "--allowed-domains", "127.0.0.1", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const limit = setTimeout(() => run.kill(), 30_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`agent-browser ${args[0]}: ${stdout} ${stderr}`);
    }
    return stdout.trim();
  } finally {
    clearTimeout(limit);
  }
}
const value = async (expression: string): Promise<unknown> =>
  JSON.parse(await browser("eval", expression));
const see = (label: string, observed: unknown) =>
  console.log(`${label}: ${JSON.stringify(observed)}`);
const text = (selector: string) =>
  value(`document.querySelector(${JSON.stringify(selector)})?.innerText.replace(/\\s+/g, " ")`);
const settle = () => browser("wait", "--load", "networkidle");
const sideways = "document.documentElement.scrollWidth - document.documentElement.clientWidth";

// The seeding runs in the page, as the admin would: the session's CSRF token, the same API.
const seed = `(async () => {
  const csrf = document.cookie.split("; ").find((c) => c.startsWith("csrf=")).slice(5);
  const headers = { "content-type": "application/json", "x-csrf-token": csrf };
  const call = async (method, uri, body) => (await (await fetch(uri, { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body) })).json()).data;
  const news = await call("POST", "/api/lists", { name: "Operator news", type: "public",
    optin: "single" });
  const subject = "Welcome <img src=x onerror=\\"window.pwned=1\\">";
  const tx = await call("POST", "/api/templates", { name: "Operator tx", type: "tx",
    subject, body: "<p>Hi {{ subscriber.name }}</p>" });
  const sequence = await call("POST", "/api/sequences", { name: "Onboarding",
    status: "active", trigger: { event: "operator_signup" }, reentry: "always",
    list_id: news.id,
    steps: [{ wait: "PT0S", kind: "marketing", template_id: tx.id },
      { wait: "PT0S", kind: "transactional", template_id: tx.id }] });
  const ana = await call("POST", "/api/subscriber-events", { subscriber: {
    email: "ana@example.com", name: "Ana", external_id: "ext-42",
    grant_lists: [news.id] }, name: "operator_signup" });
  const blocked = await call("POST", "/api/subscribers", { email: "blocked@example.com",
    name: "Blocked", status: "blocklisted", lists: [] });
  await call("POST", "/api/subscriber-events", { subscriber: {
    email: "blocked@example.com", name: "Blocked" }, name: "operator_signup" });
  // A transactional send to a blocklisted person is refused: a skipped row with no subject.
  const refused = await call("POST", "/api/tx", { subscriber_id: blocked.id,
    template_id: tx.id, data: {} });
  // A sequence whose marketing step the frequency cap holds for Ana (she got one this minute).
  const held = await call("POST", "/api/sequences", { name: "Held", status: "active",
    trigger: { event: "operator_hold" }, reentry: "always", list_id: news.id,
    steps: [{ wait: "PT1H", kind: "marketing", template_id: tx.id }] });
  const heldStart = await call("POST", "/api/subscriber-events", { subscriber: {
    email: "ana@example.com", name: "Ana" }, name: "operator_hold" });
  // A sequence that an event exits: Ana's enrollment ends on operator_stop.
  await call("POST", "/api/sequences", { name: "Exit", status: "active",
    trigger: { event: "operator_start" }, exit_on: ["operator_stop"], reentry: "always",
    list_id: news.id, steps: [{ wait: "P1D", kind: "transactional", template_id: tx.id }] });
  const started = await call("POST", "/api/subscriber-events", { subscriber: {
    email: "ana@example.com", name: "Ana" }, name: "operator_start" });
  await call("POST", "/api/subscriber-events", { subscriber: {
    email: "ana@example.com", name: "Ana" }, name: "operator_stop" });
  // A transactional send to Ana, as the producer sends it: its row names the template.
  const plainTx = await call("POST", "/api/tx", { subscriber_id: ana.subscriber_id,
    template_id: tx.id, data: {} });
  // A person whose data was wiped: their send keeps its row, with no address and no subject.
  const gone = await call("POST", "/api/subscribers", { email: "gone@example.com",
    name: "Gone", status: "enabled", lists: [] });
  const wiped = await call("POST", "/api/tx", { subscriber_id: gone.id, template_id: tx.id,
    data: {} });
  await call("DELETE", "/api/subscribers/" + gone.id);
  return JSON.stringify({ sequence: sequence.id, subscriber: ana.subscriber_id,
    enrollment: ana.enrollments.started[0].id, blocked: blocked.id, external: "ext-42",
    refused: refused.sends[0].id, wiped: wiped.sends[0].id, held: held.id,
    heldEnrollment: heldStart.enrollments.started[0].id,
    exitedEnrollment: started.enrollments.started[0].id,
    txStatus: plainTx.sends[0].status });
})()`;

process.exitCode = await withStack(async ({ origin, dataDir, errors }) => {
  // Each screen at a width; the layout must not scroll sideways at 390 px.
  const visit = async (path: string, name: string, width: number) => {
    await browser("set", "viewport", String(width), width === 390 ? "844" : "900");
    await browser("open", `${origin}${path}`);
    await settle();
    await browser("wait", "800");
    see(`${name} ${width}px horizontal overflow`, await value(sideways));
    if (shots) {
      await browser("screenshot", `${shots}/${name}-${width}.png`);
    }
  };
  const both = async (path: string, name: string, then: () => Promise<void>) => {
    await visit(path, name, 1280);
    await then();
    await visit(path, name, 390);
    await then();
  };
  try {
    await browser("open", `${origin}/admin/login`);
    await browser("fill", "#username", admin.user);
    await browser("fill", "#password", admin.password);
    await browser("click", "button[type=submit]");
    await settle();

    const made = String(await value(seed));
    const {
      subscriber,
      enrollment,
      blocked,
      external,
      heldEnrollment,
      exitedEnrollment,
      txStatus,
    } = JSON.parse(made);
    see("live transactional send", txStatus);
    await Bun.sleep(1500);
    // The thirty-day retention pass cannot run inside a browser pass, so the marketing message Ana was
    // sent loses its payload as that pass leaves it (the same column, cleared): the row a retained
    // send shows, with its address and its status kept.
    const journal = new Database(join(dataDir, "iglo-email.db"));
    try {
      journal.run(
        "UPDATE sends SET payload = NULL WHERE subscriber_id = ? AND kind = 'transactional' AND status = 'sent' AND source = 'sequence'",
        [subscriber],
      );
    } finally {
      journal.close();
    }

    await both("/admin/sends", "send-log", async () => {
      see("send log rows", await text('[data-testid="send-row"]'));
    });
    see(
      "server log",
      await value(
        `fetch("/api/logs?per_page=5").then((r) => r.text()).then((t) => t.slice(0, 1200))`,
      ),
    );
    see(
      "journal (status, error, payload kept)",
      await value(`fetch("/api/sends?per_page=10").then((r) => r.json()).then((d) =>
        d.data.results.map((s) => [s.id, s.status, s.error, s.skip_reason, s.subject !== null])
      )`),
    );
    await both("/admin/sends?status=sent&source=sequence", "send-log-filtered", async () => {
      see(
        "filtered rows",
        await value(`[...document.querySelectorAll('[data-testid="send-row"]')]
        .map((row) => row.innerText.replace(/\\s+/g, " "))`),
      );
    });

    await both(`/admin/subscribers?search=${external}`, "subscriber-search", async () => {
      see(
        "exact external id finds",
        await value(`[...document.querySelectorAll("table tbody tr")]
        .map((row) => row.innerText.replace(/\\s+/g, " ").slice(0, 80))`),
      );
    });

    await both(`/admin/subscribers/${subscriber}`, "subscriber-counts", async () => {
      see(
        "stats",
        await value(`[...document.querySelectorAll(".stat-card")]
        .map((card) => card.innerText.replace(/\\s+/g, " "))`),
      );
    });
    await both(`/admin/subscribers/${subscriber}/events`, "subscriber-events", async () => {
      see("events", await text('[data-testid="event-row"]'));
    });
    await both(`/admin/subscribers/${subscriber}/sends`, "subscriber-sends", async () => {
      see("sends tab", await text('[data-testid="send-row"]'));
    });
    await both(`/admin/subscribers/${blocked}/events`, "blocked-events", async () => {
      see("blocked events", await text('[data-testid="event-row"]'));
    });
    await both(`/admin/sequences/enrollments/${enrollment}`, "timeline", async () => {
      see("timeline", await text('[data-testid="timeline"]'));
    });
    await both(
      `/admin/subscribers/${subscriber}/enrollments`,
      "subscriber-enrollments",
      async () => {
        see("enrollments tab", await text('[data-testid="enrollment-row"]'));
      },
    );
    await both(`/admin/sequences/enrollments/${exitedEnrollment}`, "exited-timeline", async () => {
      see("exited timeline", await text('[data-testid="timeline"]'));
    });
    await both(`/admin/sequences/enrollments/${heldEnrollment}`, "held-timeline", async () => {
      see("held timeline", await text('[data-testid="timeline"]'));
    });
    await both(`/admin/subscribers/${blocked}/sends`, "blocked-sends", async () => {
      see("refused send", await text('[data-testid="send-row"]'));
    });
    await both("/admin", "dashboard", async () => {
      see("dashboard stats", await text(".stat-card"));
    });
    see("hostile text ran", await value("window.pwned === undefined ? 'no' : 'YES'"));
    see("server stderr", errors());
    return 0;
  } finally {
    const close = Bun.spawn(["agent-browser", "--session", session, "close"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await close.exited;
  }
});
