// One agent-browser pass over the operator screens of B127: the send log, a subscriber's counts,
// events, enrollments and sends, the subscriber list's exact external-ID search, an enrollment's
// timeline, and the dashboard, at 1280 and 390 px. It prints what each screen said, and
// E2E_SHOTS=<directory> keeps a screenshot per screen and width. `bun run e2e:browser:operator`.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { withStack } from "@/test/e2e/stack";
import { admin } from "@/test/worked-example/harness";

const session = `b127-${randomBytes(6).toString("hex")}`;
const shots = process.env.E2E_SHOTS;
function browser(...args: Array<string>): string {
  const run = Bun.spawnSync(
    ["agent-browser", "--session", session, "--allowed-domains", "127.0.0.1", ...args],
    { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  if (run.exitCode !== 0) {
    throw new Error(`agent-browser ${args[0]}: ${run.stdout} ${run.stderr.toString()}`);
  }
  return run.stdout.toString().trim();
}
const value = (expression: string): unknown => JSON.parse(browser("eval", expression));
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

process.exitCode = await withStack(async ({ origin, dataDir }) => {
  // Each screen at a width; the layout must not scroll sideways at 390 px.
  const visit = (path: string, name: string, width: number) => {
    browser("set", "viewport", String(width), width === 390 ? "844" : "900");
    browser("open", `${origin}${path}`);
    settle();
    browser("wait", "800");
    see(`${name} ${width}px horizontal overflow`, value(sideways));
    if (shots) {
      browser("screenshot", `${shots}/${name}-${width}.png`);
    }
  };
  const both = (path: string, name: string, then: () => void) => {
    visit(path, name, 1280);
    then();
    visit(path, name, 390);
    then();
  };
  try {
    browser("open", `${origin}/admin/login`);
    browser("fill", "#username", admin.user);
    browser("fill", "#password", admin.password);
    browser("click", "button[type=submit]");
    settle();

    const made = String(value(seed));
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

    both("/admin/sends", "send-log", () => {
      see("send log rows", text('[data-testid="send-row"]'));
    });
    see(
      "server log",
      value(`fetch("/api/logs?per_page=5").then((r) => r.text()).then((t) => t.slice(0, 1200))`),
    );
    see(
      "journal (status, error, payload kept)",
      value(`fetch("/api/sends?per_page=10").then((r) => r.json()).then((d) =>
        d.data.results.map((s) => [s.id, s.status, s.error, s.skip_reason, s.subject !== null])
      )`),
    );
    both("/admin/sends?status=sent&source=sequence", "send-log-filtered", () => {
      see(
        "filtered rows",
        value(`[...document.querySelectorAll('[data-testid="send-row"]')]
        .map((row) => row.innerText.replace(/\\s+/g, " "))`),
      );
    });

    both(`/admin/subscribers?search=${external}`, "subscriber-search", () => {
      see(
        "exact external id finds",
        value(`[...document.querySelectorAll("table tbody tr")]
        .map((row) => row.innerText.replace(/\\s+/g, " ").slice(0, 80))`),
      );
    });

    both(`/admin/subscribers/${subscriber}`, "subscriber-counts", () => {
      see(
        "stats",
        value(`[...document.querySelectorAll(".stat-card")]
        .map((card) => card.innerText.replace(/\\s+/g, " "))`),
      );
    });
    both(`/admin/subscribers/${subscriber}/events`, "subscriber-events", () => {
      see("events", text('[data-testid="event-row"]'));
    });
    both(`/admin/subscribers/${subscriber}/sends`, "subscriber-sends", () => {
      see("sends tab", text('[data-testid="send-row"]'));
    });
    both(`/admin/subscribers/${blocked}/events`, "blocked-events", () => {
      see("blocked events", text('[data-testid="event-row"]'));
    });
    both(`/admin/sequences/enrollments/${enrollment}`, "timeline", () => {
      see("timeline", text('[data-testid="timeline"]'));
    });
    both(`/admin/subscribers/${subscriber}/enrollments`, "subscriber-enrollments", () => {
      see("enrollments tab", text('[data-testid="enrollment-row"]'));
    });
    both(`/admin/sequences/enrollments/${exitedEnrollment}`, "exited-timeline", () => {
      see("exited timeline", text('[data-testid="timeline"]'));
    });
    both(`/admin/sequences/enrollments/${heldEnrollment}`, "held-timeline", () => {
      see("held timeline", text('[data-testid="timeline"]'));
    });
    both(`/admin/subscribers/${blocked}/sends`, "blocked-sends", () => {
      see("refused send", text('[data-testid="send-row"]'));
    });
    both("/admin", "dashboard", () => {
      see("dashboard stats", text(".stat-card"));
    });
    see("hostile text ran", value("window.pwned === undefined ? 'no' : 'YES'"));
    return 0;
  } finally {
    Bun.spawnSync(["agent-browser", "--session", session, "close"], { timeout: 15_000 });
  }
});
