// Browser check of the compiled public pages, adapted from listmonk tests/specs/forms.spec.js
// at 6fcd95f to `agent-browser`: subscription form, opt-in mail link, preferences, export and
// wipe, against the invocation-owned Mailpit. Run with `bun run public:browser`.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { provisionApiUser, withProduction } from "@/test/contract/owned";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";

const repository = resolve(import.meta.dir, "../..");
const session = `m25-${randomBytes(6).toString("hex")}`;
const screenshots = process.env.PUBLIC_BROWSER_SHOTS;
const fail = (label: string): never => {
  throw new Error(`FAIL browser-${label}`);
};
function browser(...args: string[]) {
  const run = Bun.spawnSync(
    ["agent-browser", "--session", session, "--allowed-domains", "127.0.0.1", ...args],
    { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  const out = run.stdout.toString();
  if (run.exitCode !== 0) fail(`command-${args[0]}: ${out} ${run.stderr.toString()}`);
  return out;
}
const text = () => browser("get", "text", "body");
const expectText = (value: string, label: string) => {
  const body = text();
  if (!body.includes(value)) fail(`${label}: ${body.slice(0, 400)}`);
};

const fixtures = await readFile(resolve(repository, "test/users/fixtures.md"), "utf8");
const admin = {
  user: /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(fixtures)![1]!,
  password: /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(fixtures)![1]!,
};
const sink = referenceMailpit(process.env);
await assertOwnedMailpit(sink);
const passed = await withProduction(
  resolve(repository, "dist/iglo.email"),
  AbortSignal.timeout(170_000),
  async (origin) => {
    const credentials = await provisionApiUser(origin, admin);
    const authorization = `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`;
    const api = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return (await response.json()) as { data: any };
    };
    const settings = (await api("/api/settings")).data;
    await api("/api/settings/smtp", "PUT", [
      {
        ...settings.smtp[0],
        enabled: true,
        host: sink.host,
        port: sink.port,
        auth_protocol: "none",
        username: "",
        password: "",
        tls_type: "none",
        email_headers: [],
      },
    ]);
    const single = (
      await api("/api/lists", "POST", { name: "Weekly news", type: "public", optin: "single" })
    ).data;
    const double = (
      await api("/api/lists", "POST", { name: "Product updates", type: "public", optin: "double" })
    ).data;
    await api("/api/lists", "POST", { name: "Staff only", type: "private", optin: "single" });
    const email = `browser-${randomBytes(6).toString("hex")}@example.test`;
    const shot = (name: string) => {
      if (screenshots) browser("screenshot", `${screenshots}/${name}.png`);
    };

    // Subscription form: the hidden bot field stays hidden and private lists do not show.
    browser("open", `${origin}/subscription/form`);
    expectText("Weekly news", "form-lists");
    if (text().includes("Staff only")) fail("form-private");
    if (browser("is", "visible", "input[name=nonce]").trim() !== "false") fail("form-nonce");
    shot("form");
    browser("fill", "input[name=email]", email);
    browser("fill", "input[name=name]", "Browser Person");
    browser("click", "button[type=submit]");
    browser("wait", "--text", "An e-mail has been sent");
    shot("form-done");

    // The received mail's link: the page asks, the button confirms.
    const search = new URLSearchParams({ query: `to:"${email}"`, limit: "5" });
    let id = "";
    for (let i = 0; i < 100 && !id; i++, await Bun.sleep(50)) {
      const found = (await (await fetch(`${sink.api}/api/v1/search?${search}`)).json()) as {
        messages: { ID: string }[];
      };
      id = found.messages[0]?.ID ?? "";
    }
    if (!id) fail("optin-mail");
    const mail = (await (await fetch(`${sink.api}/api/v1/message/${id}`)).json()) as {
      HTML: string;
    };
    const link = /href="([^"]*\/subscription\/optin\/[^"]*)"/
      .exec(mail.HTML)?.[1]
      ?.replaceAll("&amp;", "&");
    if (!link) fail("optin-link");
    browser("open", link!);
    expectText("Product updates", "optin-page");
    shot("optin");
    const query = new URLSearchParams({ query: `subscribers.email = '${email}'` });
    const row = async () => (await api(`/api/subscribers?${query}`)).data.results[0];
    const status = async (list: number) =>
      (await row()).lists.find((l: { id: number }) => l.id === list)?.subscription_status;
    if ((await status(double.id)) !== "unconfirmed") fail("optin-get-changed");
    browser("click", "#btn-unsub");
    browser("wait", "--text", "Subscribed successfully.");
    if ((await status(double.id)) !== "confirmed") fail("optin-confirm");

    // Preferences through the page reached from the unsubscribe link.
    const uuid = (await row()).uuid as string;
    const prefs = `${origin}/subscription/00000000-0000-0000-0000-000000000000/${uuid}`;
    browser("open", prefs);
    expectText("Unsubscribe", "unsub-page");
    browser("find", "text", "Manage preferences", "click");
    browser("wait", "input[name=name]");
    shot("preferences");
    browser("fill", "input[name=name]", "Renamed Person");
    browser("uncheck", `input[value="${double.uuid}"]`);
    browser("click", "#btn-unsub");
    browser("wait", "--text", "Your preferences have been saved.");
    const saved = await row();
    if (saved.name !== "Renamed Person") fail("prefs-name");
    if ((await status(double.id)) !== "unsubscribed") fail("prefs-list");
    if ((await status(single.id)) === "unsubscribed") fail("prefs-kept");

    // Export, then wipe with the confirmation dialog.
    browser("open", prefs);
    browser("click", "#privacy-export");
    browser("click", "input[type=submit]");
    browser("wait", "--text", "Your data has been e-mailed");
    shot("export");
    browser("open", prefs);
    browser("click", "#privacy-wipe");
    // Accept the page's confirm() once it opens.
    browser("eval", "window.confirm = () => true; 1");
    browser("click", "input[type=submit]");
    browser("wait", "--text", "Your subscriptions and all associated data");
    shot("wipe");
    if (await row()) fail("wipe");
    process.stdout.write("PASS public browser checks\n");
    return true;
  },
  admin,
  180_000,
).finally(() => {
  Bun.spawnSync(["agent-browser", "--session", session, "close"]);
});
if (!passed) process.exitCode = 1;
