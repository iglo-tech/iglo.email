// One agent-browser pass over the analytics, logs and maintenance screens, printing what each page
// said. `bun run e2e:browser:analytics`; E2E_SHOTS=<directory> keeps screenshots.
import { randomBytes } from "node:crypto";
import { withStack } from "@/test/e2e/stack";
import { admin } from "@/test/worked-example/harness";

const session = `m46-${randomBytes(6).toString("hex")}`;
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
      const list = await call("POST", "/api/lists", { name: "Browser " + hostile, type: "public" });
      const sub = await call("POST", "/api/subscribers", { email: "browser@example.com",
        name: "Browser", status: "enabled", lists: [list.id] });
      await call("POST", "/api/subscribers", { email: "orphan@example.com", name: "Orphan",
        status: "enabled", lists: [] });
      const campaign = await call("POST", "/api/campaigns", { name: "Browser " + hostile,
        subject: "s", lists: [list.id], content_type: "plain", type: "regular", messenger: "email",
        body: "b" });
      await fetch("/campaign/" + campaign.uuid + "/" + sub.uuid + "/px.png");
      await fetch("/campaign/" + campaign.uuid + "/" + sub.uuid + "/px.png");
      return JSON.stringify({ list: list.id, campaign: campaign.id });
    })()`);
    const { list, campaign } = typeof made === "string" ? JSON.parse(made) : made;
    const range = "from=2020-01-01&to=2099-01-01";

    visit(`/admin/campaigns/analytics?id=${campaign}&${range}`, "campaign-analytics");
    see("campaign views", text('[data-testid="chart-views"]'));
    see("campaign clicks", text('[data-testid="chart-clicks"]'));
    see(
      "campaign canvas drawn",
      value(`!!document.querySelector("#chart-views").getContext("2d")`),
    );
    see("hostile name ran", value("window.pwned === undefined ? 'no' : 'YES'"));

    visit(`/admin/lists/analytics?id=${list}&${range}`, "list-analytics");
    see("list subscriptions", text('[data-testid="chart-subscriptions"]'));

    visit("/admin/settings/logs", "logs");
    see("logs", text(".logs .page-content"));

    visit("/admin/settings/maintenance", "maintenance");
    see("maintenance", text(".maintenance .page-content"));
    see(
      "orphan delete",
      value(`(async () => {
        const csrf = document.cookie.split("; ").find((c) => c.startsWith("csrf=")).slice(5);
        const out = await fetch("/api/maintenance/subscribers/orphan", { method: "DELETE",
          headers: { "x-csrf-token": csrf } });
        return out.status + " " + (await out.text()).trim();
      })()`),
    );
    return 0;
  } finally {
    browser("close");
  }
});
