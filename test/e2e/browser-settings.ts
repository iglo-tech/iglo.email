// One agent-browser pass over the settings, users, roles and profile screens, printing what each
// page said. `bun run e2e:browser:settings`; E2E_SHOTS=<directory> keeps screenshots.
import { randomBytes } from "node:crypto";
import { withStack } from "@/test/e2e/stack";
import { admin } from "@/test/worked-example/harness";

const session = `m44-${randomBytes(6).toString("hex")}`;
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
      const hostile = '<img src=x onerror="window.pwned=1"> x-on:click="pwned=1"';
      const role = await post("/api/roles/users", { name: "Browser " + hostile,
        permissions: ["lists:get_all", "sequences:get"] });
      const listRole = await post("/api/roles/lists", { name: "Browser list " + hostile, lists: [] });
      const user = await post("/api/users", { username: "browser-user", name: hostile,
        email: "browser-user@example.test", type: "user", status: "enabled",
        user_role_id: role.id, list_role_id: listRole.id });
      return { role: role.id, listRole: listRole.id, user: user.id };
    })()`);
    const safe = () =>
      value(
        `({ pwned: window.pwned ?? null, images: document.querySelectorAll("main img").length })`,
      );

    visit("/admin/settings", "settings");
    see("settings heading", text(".page-title"));
    see(
      "settings tabs",
      value(
        `[...document.querySelectorAll(".settings-sidebar [role=tab]")].map((t) => t.innerText)`,
      ),
    );
    for (const name of ["performance", "privacy", "security", "media", "smtp", "bounces"]) {
      browser("eval", `document.querySelector("#${name}").click()`);
      if (shots) browser("screenshot", `${shots}/settings-${name}.png`);
      see(name, text(".settings-tabs > [role=tabpanel]:not([hidden])").slice(0, 160));
    }
    browser(
      "eval",
      `document.querySelector("#bounces").click(); [...document.querySelectorAll("input[type=checkbox]")].find((i) => i.closest("label")?.innerText.includes("Enable bounce processing")).click()`,
    );
    see(
      "unavailable cards",
      value(`[...document.querySelectorAll("[data-unavailable] legend")].map((l) => l.innerText)`),
    );
    for (const name of ["messengers", "appearance"]) {
      browser("eval", `document.querySelector("#${name}").click()`);
      if (shots) browser("screenshot", `${shots}/settings-${name}.png`);
      see(name, text(".settings-tabs > [role=tabpanel]:not([hidden])").slice(0, 200));
    }

    visit("/admin/users", "users");
    see("users heading", text(".page-title"));
    see(
      "user rows",
      value(
        `[...document.querySelectorAll("[data-testid=user-row]")].map((r) => r.innerText.replace(/\\s+/g, " "))`,
      ),
    );
    see("nothing ran", safe());
    visit(`/admin/users/${made.user}`, "user");
    see("user heading", text("h1.page-title"));
    see(
      "user form",
      value(`({ username: document.querySelector("[name=username]").value,
        role: document.querySelector("[name=user_role]").selectedOptions[0].text })`),
    );
    see("nothing ran", safe());
    visit("/admin/users/1", "own-user");
    see(
      "own record",
      value(`({ roles: document.querySelector("[data-testid=user-roles]").disabled,
        password: document.querySelector("[data-testid=password-login]").disabled })`),
    );
    visit("/admin/users/new", "user-new");
    see(
      "new user fields",
      value(`[...document.querySelectorAll("section.users form [name]")].map((e) => e.name)`),
    );

    visit("/admin/users/roles", "roles");
    see(
      "role rows",
      value(
        `[...document.querySelectorAll("[data-testid=role-row]")].map((r) => r.innerText.replace(/\\s+/g, " "))`,
      ),
    );
    see("nothing ran", safe());
    visit(`/admin/users/roles/${made.role}`, "role");
    see("role heading", text("h1.page-title"));
    see(
      "role boxes",
      value(`({ boxes: document.querySelectorAll("form input[type=checkbox]").length,
        checked: [...document.querySelectorAll("form input:checked")].map((b) => b.value) })`),
    );
    visit("/admin/users/roles/1", "role-super");
    see(
      "super admin role",
      value(`({ disabled: document.querySelector("form input[type=checkbox]").disabled,
        save: getComputedStyle(document.querySelector("[data-testid=btn-save]")).display })`),
    );
    visit("/admin/users/roles/lists", "list-roles");
    see("list roles heading", text(".page-title"));
    visit(`/admin/users/roles/lists/${made.listRole}`, "list-role");
    see("list role heading", text("h1.page-title"));
    see("nothing ran", safe());

    visit("/admin/user/profile", "profile");
    see("profile heading", text("h1.page-title"));
    see(
      "profile",
      value(`({ user: document.querySelector(".user-profile h4").innerText,
        email: document.querySelector("[name=email]").value,
        twofa: document.querySelector(".twofa-app-section h3").innerText })`),
    );
    return 0;
  } finally {
    try {
      browser("close");
    } catch (error) {
      console.error(error);
    }
  }
});
