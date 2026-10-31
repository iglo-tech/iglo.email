// One agent-browser pass over the sequence list, editor, enrollment explorer, timeline, test mode
// and subscriber tabs, printing what each page said. `bun run e2e:browser:sequences`;
// E2E_SHOTS=<directory> keeps screenshots.
import { randomBytes } from "node:crypto";
import { withStack } from "@/test/e2e/stack";
import { admin } from "@/test/worked-example/harness";

const session = `m55-${randomBytes(6).toString("hex")}`;
const shots = process.env.E2E_SHOTS;
function browser(...args: string[]): string {
  const run = Bun.spawnSync(
    ["agent-browser", "--session", session, "--allowed-domains", "127.0.0.1", ...args],
    { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  if (run.exitCode !== 0)
    throw new Error(`agent-browser ${args[0]}: ${run.stdout} ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}
const value = (expression: string) => JSON.parse(browser("eval", expression));
const see = (label: string, observed: unknown) =>
  console.log(`${label}: ${JSON.stringify(observed)}`);
const text = (selector: string) =>
  value(`document.querySelector(${JSON.stringify(selector)})?.innerText.replace(/\\s+/g, " ")`);
const settle = () => browser("wait", "--load", "networkidle");

process.exitCode = await withStack(async ({ origin, mailbox }) => {
  const visit = (path: string, name: string) => {
    browser("open", `${origin}${path}`);
    settle();
    browser("wait", "800");
    if (shots) browser("screenshot", `${shots}/${name}.png`);
  };
  try {
    browser("open", `${origin}/admin/login`);
    browser("fill", "#username", admin.user);
    browser("fill", "#password", admin.password);
    browser("click", "button[type=submit]");
    settle();

    const made = value(`(async () => {
      const csrf = document.cookie.split("; ").find((c) => c.startsWith("csrf=")).slice(5);
      const headers = { "content-type": "application/json", "x-csrf-token": csrf };
      const call = async (method, uri, body) => (await (await fetch(uri, { method, headers,
        body: JSON.stringify(body) })).json()).data;
      const hostile = '<img src=x onerror="window.pwned=1"> x-on:click="pwned=1"';
      const tx = await call("POST", "/api/templates", { name: "Browser " + hostile, type: "tx",
        subject: "Hello", body: "<p>Hi</p>" });
      const sequence = await call("POST", "/api/sequences", { name: "Browser " + hostile,
        status: "active", trigger: { event: "browser_event" }, exit_on: ["browser_stop"],
        steps: [{ wait: "PT0S", kind: "transactional", template_id: tx.id },
          { wait: "P3D", kind: "transactional", template_id: tx.id,
            condition: { not: { event: "browser_stop", since: "trigger" } } }] });
      const event = await call("POST", "/api/subscriber-events", { subscriber: {
        email: "real@example.com", name: "Real", attribs: { note: hostile } },
        name: "browser_event", data: { note: hostile } });
      const tester = await call("POST", "/api/subscribers", { email: "tester@example.com",
        name: "Tester", status: "enabled", lists: [] });
      const test = await call("POST", "/api/enrollments", { sequence_id: sequence.id,
        subscriber_id: tester.id, test: true });
      return JSON.stringify({ sequence: sequence.id, real: event.subscriber_id,
        enrollment: event.enrollments.started[0].id, test: test.id });
    })()`);
    const { sequence, real, enrollment, test } = typeof made === "string" ? JSON.parse(made) : made;
    await Bun.sleep(1500);

    visit("/admin/sequences", "list");
    see("list row", text('[data-testid="sequence-row"]'));
    see("list note", text(".sequences .table-wrapper > p"));

    visit(`/admin/sequences/${sequence}`, "editor");
    see("live warning", text('[data-testid="live-warning"]'));
    see(
      "editor",
      value(`({ steps: document.querySelectorAll('[data-testid="step-card"]').length,
        name: document.querySelector('[data-testid="sequence-name"]').innerText,
        editors: document.querySelectorAll(".cm-editor").length })`),
    );
    browser("click", '[data-testid="btn-test-mode"]');
    see("test dialog", text('[data-testid="test-dialog"] .dialog-body'));
    browser("click", '[data-testid="test-dialog"] button.outline');

    visit(`/admin/sequences/enrollments?sequence_id=${sequence}`, "explorer");
    see(
      "explorer rows",
      value(`[...document.querySelectorAll('[data-testid="enrollment-row"]')]
        .map((row) => row.innerText.replace(/\\s+/g, " "))`),
    );

    visit(`/admin/sequences/enrollments/${enrollment}`, "timeline");
    see("real timeline", text('[data-testid="timeline"]'));
    visit(`/admin/sequences/enrollments/${test}`, "test-timeline");
    see("test timeline", text('[data-testid="timeline"]'));
    see("test badge", text('[data-testid="test-badge"]'));
    see("test mail subjects", [...new Set(mailbox.mails.map((mail) => mail.subject))]);

    visit(`/admin/subscribers/${real}/events`, "subscriber-events");
    see("events tab", text('[data-testid="event-row"]'));
    visit(`/admin/subscribers/${real}/enrollments`, "subscriber-enrollments");
    see("enrollments tab", text('[data-testid="enrollment-row"]'));
    visit(`/admin/subscribers/${real}/sends`, "subscriber-sends");
    see("sends tab", text('[data-testid="send-row"]'));
    see("hostile text ran", value("window.pwned === undefined ? 'no' : 'YES'"));
    return 0;
  } finally {
    Bun.spawnSync(["agent-browser", "--session", session, "close"], { timeout: 15_000 });
  }
});
