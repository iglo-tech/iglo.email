// One agent-browser pass over the subscribers and lists screens, printing what each page said.
// `bun run e2e:browser:lists`; E2E_SHOTS=<directory> keeps screenshots.
import { randomBytes } from "node:crypto";
import { withStack } from "@/test/e2e/stack";
import { admin } from "@/test/worked-example/harness";

const session = `m42-${randomBytes(6).toString("hex")}`;
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
      const post = async (uri, body) => (await (await fetch(uri, { method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify(body) })).json()).data;
      const hostile = '<img src=x onerror="window.pwned=1"> {{ 7*7 }} x-on:click="pwned=1"';
      const list = await post("/api/lists", { name: "Browser " + hostile, type: "public",
        optin: "double", tags: ["news", "<b>x</b>"], description: "About " + hostile });
      const plain = await post("/api/lists", { name: "Plain list", type: "private", optin: "single" });
      const sub = await post("/api/subscribers", { email: "browser@example.test",
        name: "Sub " + hostile, status: "enabled", lists: [list.id, plain.id],
        attribs: { note: hostile } });
      for (let i = 0; i < 25; i++)
        await post("/api/subscribers", { email: "row" + i + "@example.test", name: "Row " + i,
          status: "enabled", lists: [plain.id] });
      return { list: list.id, sub: sub.id };
    })()`) as { list: number; sub: number };
    const safe = () =>
      value(
        "({ pwned: window.pwned ?? null, images: document.querySelectorAll('main section img').length })",
      );

    visit("/admin/subscribers", "subscribers");
    see("subscribers heading", text(".page-heading"));
    see(
      "rows and pages",
      value(
        `({ rows: document.querySelectorAll("[data-testid=sub-row]").length,
          pages: document.querySelector("nav.pagination").innerText.replace(/\\s+/g, " ") })`,
      ),
    );
    visit("/admin/subscribers?search=browser@example.test", "subscribers-search");
    see("hostile row", text("[data-testid=sub-row]"));
    see("nothing ran", safe());
    visit(`/admin/subscribers?query=${encodeURIComponent("no_column = 1")}`, "subscribers-error");
    see("refused query", text("[data-testid=error]"));

    visit("/admin/subscribers/new", "subscriber-new");
    see(
      "new form",
      value(`[...document.querySelectorAll("section.subscribers legend")].map((l) => l.innerText)`),
    );
    visit(`/admin/subscribers/${made.sub}`, "subscriber-view");
    see("overview", text(".activity"));
    visit(`/admin/subscribers/${made.sub}/edit`, "subscriber-edit");
    see(
      "edit form",
      value(
        `({ name: document.querySelector("input[name=name]").value,
          attribs: document.querySelector("textarea[name=attribs]").value.slice(0, 40) })`,
      ),
    );
    see("nothing ran", safe());
    visit(`/admin/subscribers/${made.sub}/lists`, "subscriber-lists");
    see("memberships", text(".subscriptions tbody"));
    visit(`/admin/subscribers/${made.sub}/bounces`, "subscriber-bounces");
    see("bounces", text(".bounces tbody"));

    visit("/admin/lists", "lists");
    see("lists heading", text(".page-heading"));
    see(
      "list rows",
      value(
        `[...document.querySelectorAll("[data-testid=list-row]")].map((r) => r.innerText.replace(/\\s+/g, " "))`,
      ),
    );
    see("nothing ran", safe());
    visit("/admin/lists/new", "list-new");
    see(
      "new list fields",
      value(`[...document.querySelectorAll("section.lists form [name]")].map((e) => e.name)`),
    );
    visit(`/admin/lists/${made.list}`, "list-view");
    see("list overview", text("section.lists"));
    see(
      "analytics link",
      value(`document.querySelector("[data-testid=btn-analytics]").getAttribute("href")`),
    );
    visit(`/admin/lists/${made.list}/edit`, "list-edit");
    see(
      "edit list",
      value(
        `({ name: document.querySelector("input[name=name]").value,
          tags: [...document.querySelectorAll("ot-taginput .badge")].map((b) => b.firstChild.data) })`,
      ),
    );
    see("nothing ran", safe());
    return 0;
  } finally {
    try {
      browser("close");
    } catch (error) {
      console.error(error);
    }
  }
});
