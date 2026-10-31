// One agent-browser pass over the templates and campaigns screens, printing what each page said.
// `bun run e2e:browser:campaigns`; E2E_SHOTS=<directory> keeps screenshots.
import { randomBytes } from "node:crypto";
import { withStack } from "@/test/e2e/stack";
import { admin } from "@/test/worked-example/harness";

const session = `m43-${randomBytes(6).toString("hex")}`;
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
  const shot = (name: string) => {
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
      const post = async (uri, body) => (await (await fetch(uri, { method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify(body) })).json()).data;
      const hostile = '<img src=x onerror="window.pwned=1"> x-on:click="pwned=1"';
      const list = await post("/api/lists", { name: "Browser list", type: "public", optin: "single" });
      const template = await post("/api/templates", { name: "Browser " + hostile, type: "campaign",
        subject: "", body: "<div>Layout</div>{{ content | raw }}" });
      const scripted = await post("/api/campaigns", { name: "Browser " + hostile,
        subject: "Subject " + hostile, type: "regular", content_type: "html", lists: [list.id],
        tags: ["news", "<b>x</b>"],
        body: '<p>Visible</p><script>parent.pwned = 1;</' + 'script>' });
      const rich = await post("/api/campaigns", { name: "Rich campaign", subject: "Rich",
        type: "regular", content_type: "richtext", lists: [list.id], body: "<p>Rich body</p>" });
      return { list: list.id, template: template.id, scripted: scripted.id, rich: rich.id };
    })()`);
    const safe = () =>
      value(`({ pwned: window.pwned ?? null, parent: window.parent === window,
        images: document.querySelectorAll("section img").length })`);

    visit("/admin/templates", "templates");
    see("templates heading", text(".page-title"));
    see(
      "template rows",
      value(
        `[...document.querySelectorAll("[data-testid=template-row]")].map((r) => r.innerText.replace(/\\s+/g, " "))`,
      ),
    );
    // agent-browser's commands fail once a frame with no script context is open: the specs in
    // campaign-safety.e2e.js open the previews, and this reads the frame they open.
    see(
      "preview frame",
      value(`document.querySelector(".preview-modal iframe").getAttribute("sandbox")`),
    );
    see("nothing ran", safe());

    visit("/admin/templates/new", "template-new");
    see(
      "new template fields",
      value(`[...document.querySelectorAll("section.templates form [name]")].map((e) => e.name)`),
    );
    visit(`/admin/templates/${made.template}`, "template-edit");
    see("template heading", text("h1.page-title"));
    see("template body", text(".cm-content"));
    see("nothing ran", safe());

    visit("/admin/campaigns", "campaigns");
    see("campaigns heading", text(".page-title"));
    see(
      "campaign rows",
      value(
        `[...document.querySelectorAll("tr[data-campaign-id]")].map((r) => r.innerText.replace(/\\s+/g, " "))`,
      ),
    );
    see("nothing ran", safe());
    visit(`/admin/campaigns?status=draft&tag=news`, "campaigns-filtered");
    see("filtered", text(".page-title"));

    visit(`/admin/campaigns/new?list_id=${made.list}`, "campaign-new");
    see(
      "new campaign",
      value(`({ from: document.querySelector("input[name=from_email]").value,
        lists: [...document.querySelectorAll("ot-taginput .badge")].map((b) => b.firstChild.data),
        tabs: [...document.querySelectorAll("[role=tab]")].map((t) => t.innerText.trim()) })`),
    );

    visit(`/admin/campaigns/${made.scripted}`, "campaign");
    see("campaign heading", text("h1.page-title"));
    see("status", text("header .badge"));
    browser("eval", `document.querySelector("#content").click()`);
    settle();
    shot("campaign-html");
    see("html editor", text(".cm-content"));

    visit(`/admin/campaigns/${made.rich}#tab=content`, "campaign-richtext");
    see("rich text", text("richtext-editor [contenteditable]"));
    for (const name of ["attribs", "attachments", "archive"]) {
      browser("eval", `document.querySelector("#${name}").click()`);
      shot(`campaign-${name}`);
      see(name, text("[role=tabpanel]:not([hidden])"));
    }
    browser("eval", `document.querySelector("#attachments").click()`);
    browser(
      "eval",
      `[...document.querySelectorAll(".attachments footer button")].find((b) => b.innerText.includes("Add")).click()`,
    );
    settle();
    shot("media-picker");
    see("media picker", text(".media-picker-modal"));
    return 0;
  } finally {
    try {
      browser("close");
    } catch (error) {
      console.error(error);
    }
  }
});
