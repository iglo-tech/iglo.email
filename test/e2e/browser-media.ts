// One agent-browser pass over the bounces, media, import and forms screens, printing what each page
// said. `bun run e2e:browser:media`; E2E_SHOTS=<directory> keeps screenshots.
import { randomBytes } from "node:crypto";
import { withStack } from "@/test/e2e/stack";
import { admin } from "@/test/worked-example/harness";

const session = `m45-${randomBytes(6).toString("hex")}`;
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

process.exitCode = await withStack(async ({ origin }) => {
  const visit = (path: string, name: string) => {
    browser("open", `${origin}${path}`);
    settle();
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
      const settings = await (await fetch("/api/settings")).json();
      await call("PUT", "/api/settings", { ...settings.data, "bounce.enabled": true,
        "bounce.webhooks_enabled": true });
      const list = await call("POST", "/api/lists", { name: "Browser " + hostile, type: "public",
        description: hostile });
      await call("POST", "/api/subscribers", { email: "browser@example.com", name: "Browser",
        status: "enabled", lists: [list.id] });
      await call("POST", "/webhooks/bounce", { email: "browser@example.com", type: "soft",
        source: hostile, meta: { reason: hostile } });
      const form = new FormData();
      form.set("file", new File([Uint8Array.fromBase64(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      )], hostile + ".png", { type: "image/png" }));
      await fetch("/api/media", { method: "POST", headers: { "x-csrf-token": csrf }, body: form });
      return { list: list.id };
    })()`);
    const safe = () =>
      value(
        `({ pwned: window.pwned ?? null, images: document.querySelectorAll("section img").length })`,
      );

    visit("/admin/subscribers/bounces", "bounces");
    see("bounces heading", text(".page-title"));
    see("bounce row", text("[data-testid=bounce-row]"));
    browser("eval", `document.querySelector("[data-testid=btn-meta]").click()`);
    if (shots) browser("screenshot", `${shots}/bounce-meta.png`);
    see("bounce meta", text("dialog[open] pre"));
    see("bounces safe", safe());

    visit("/admin/campaigns/media", "media");
    see("media heading", text(".page-title"));
    see("media caption", text(".gallery figcaption"));
    see("media safe", safe());

    visit(`/admin/subscribers/import?list_id=${made.list}`, "import");
    see("import heading", text(".page-title"));
    see("import list", text("ot-taginput .badge"));
    const started = value(`(async () => {
      const csrf = document.cookie.split("; ").find((c) => c.startsWith("csrf=")).slice(5);
      const form = new FormData();
      form.set("params", JSON.stringify({ mode: "subscribe", subscription_status: "unconfirmed",
        delim: ",", lists: [${made.list}] }));
      form.set("file", new File(["email,name\\nbad-address,Browser\\nimported@example.com,Done\\n"],
        "subs.csv", { type: "text/csv" }));
      const response = await fetch("/api/import/subscribers", { method: "POST",
        headers: { "x-csrf-token": csrf }, body: form });
      return response.status;
    })()`);
    see("import started", started);
    visit("/admin/subscribers/import", "import-status");
    see("import status", text(".status"));
    see("import log", text("[data-testid=import-logs]"));

    visit("/admin/lists/forms", "forms");
    see("forms heading", text(".page-title"));
    browser("eval", `document.querySelector("[data-testid=lists] input").click()`);
    settle();
    if (shots) browser("screenshot", `${shots}/forms-html.png`);
    see("form html", text("[data-testid=form] [role=textbox]"));
    see("forms safe", safe());
    return 0;
  } finally {
    try {
      browser("close");
    } catch (error) {
      console.error(error);
    }
  }
});
