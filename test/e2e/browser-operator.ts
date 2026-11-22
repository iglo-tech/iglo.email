// One agent-browser pass over the operator screens of B127: the send log, a subscriber's counts,
// events, enrollments and sends, the subscriber list's exact external-ID search, an enrollment's
// timeline, and the dashboard, at 1280 and 390 px. It prints what each screen said, and
// E2E_SHOTS=<directory> keeps a screenshot per screen and width. `bun run e2e:browser:operator`.
import { randomBytes } from "node:crypto";
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
  return JSON.stringify({ sequence: sequence.id, subscriber: ana.subscriber_id,
    enrollment: ana.enrollments.started[0].id, blocked: blocked.id, external: "ext-42" });
})()`;

process.exitCode = await withStack(async ({ origin }) => {
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
    const { subscriber, enrollment, blocked, external } = JSON.parse(made);
    await Bun.sleep(1500);

    both("/admin/sends", "send-log", () => {
      see("send log rows", text('[data-testid="send-row"]'));
    });
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
    both("/admin", "dashboard", () => {
      see("dashboard stats", text(".stat-card"));
    });
    see("hostile text ran", value("window.pwned === undefined ? 'no' : 'YES'"));
    return 0;
  } finally {
    Bun.spawnSync(["agent-browser", "--session", session, "close"], { timeout: 15_000 });
  }
});
