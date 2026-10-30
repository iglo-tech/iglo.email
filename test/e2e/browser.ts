// One agent-browser pass over login, 2FA enrolment, password reset and the dashboard, printing
// what the page said. `bun run e2e:browser`; E2E_SHOTS=<directory> keeps screenshots.
import { randomBytes } from "node:crypto";
import { withStack } from "@/test/e2e/stack";
import { totp } from "@/test/e2e/totp";
import { admin, check } from "@/test/worked-example/harness";

const session = `m41-${randomBytes(6).toString("hex")}`;
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
const path = () => value("location.pathname") as string;
const see = (label: string, observed: unknown) =>
  console.log(`${label}: ${JSON.stringify(observed)}`);
const shot = (name: string) => {
  if (shots) browser("screenshot", `${shots}/${name}.png`);
};
const settle = () => browser("wait", "--load", "networkidle");
const logout = () => {
  browser("click", ".user-trigger");
  browser("find", "role", "menuitem", "click", "--name", "Logout");
  browser("wait", "--url", "**/admin/login");
};
const fillLogin = (username: string, password: string) => {
  browser("fill", "#username", username);
  browser("fill", "#password", password);
  browser("click", "button[type=submit]");
  settle();
};

process.exitCode = await withStack(async ({ origin, blankOrigin, mailbox }) => {
  try {
    // Login.
    browser("open", `${origin}/admin/campaigns`);
    see("unauthenticated page goes to", value("location.pathname + location.search"));
    shot("login");
    fillLogin(admin.user, "wrong-password-here");
    see("wrong password", value('document.querySelector(".error")?.textContent'));
    fillLogin(admin.user, admin.password);
    see("after login", path());
    see("unported view", value('document.querySelector("main").innerText'));

    // Dashboard, with one campaign and list made through the screens' own API.
    const made = value(`(async () => {
      const csrf = document.cookie.split("; ").find((c) => c.startsWith("csrf=")).slice(5);
      const post = async (uri, body) => (await (await fetch(uri, { method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify(body) })).json()).data;
      const list = await post("/api/lists", { name: "Browser list", type: "public", optin: "single" });
      await post("/api/campaigns", { name: "<b>Browser</b> campaign", subject: "Hello", lists: [list.id],
        from_email: "browser@example.test", content_type: "richtext", messenger: "email",
        type: "regular", body: "<p>Hello</p>" });
      const user = await post("/api/users", { username: "browser-user", email: "browser-user@example.test",
        name: "Browser User", type: "user", status: "enabled", password_login: true,
        password: "browser-user-password", password2: "browser-user-password", user_role_id: 1 });
      return user.id;
    })()`) as number;
    browser("open", `${origin}/admin`);
    settle();
    see(
      "dashboard stats",
      value(
        '[...document.querySelectorAll(".stat-card")].map((c) => c.innerText.replace(/\\s+/g, " "))',
      ),
    );
    see(
      "campaign row",
      value('document.querySelector("[data-testid=campaign-row]").innerText.replace(/\\s+/g, " ")'),
    );
    see(
      "markup injected from campaign name",
      value('document.querySelectorAll("[data-testid=campaign-row] b").length'),
    );
    see(
      "system card",
      value('document.querySelector("[data-testid=system]").innerText.replace(/\\s+/g, " ")'),
    );
    shot("dashboard");
    check(made > 0, "user created");
    logout();

    // 2FA enrolment and verification.
    fillLogin("browser-user", "browser-user-password");
    browser("open", `${origin}/admin/user/profile`);
    settle();
    browser("click", "input[role=switch]");
    browser("wait", "[data-testid=totp-secret]");
    const secret = value(
      'document.querySelector("[data-testid=totp-secret]").textContent',
    ) as string;
    see(
      "enrolment shows",
      value(
        '({ qr: !!document.querySelector(".totp-setup img")?.naturalWidth, secretLength: document.querySelector("[data-testid=totp-secret]").textContent.length })',
      ),
    );
    shot("twofa-enrol");
    browser("fill", "[x-ref=totpCode]", totp(secret));
    browser("click", ".totp-setup button[type=submit]");
    browser("wait", "[data-testid=twofa-enabled]");
    see(
      "after enabling",
      value(
        'document.querySelector("[data-testid=twofa-enabled]").innerText.replace(/\\s+/g, " ")',
      ),
    );
    logout();
    fillLogin("browser-user", "browser-user-password");
    see("password alone reaches", path());
    shot("twofa-challenge");
    browser("fill", "#totp_code", "000000");
    browser("click", "button[type=submit]");
    settle();
    see("wrong code", value('document.querySelector(".error")?.textContent'));
    browser("fill", "#totp_code", totp(secret));
    browser("click", "button[type=submit]");
    settle();
    see("right code reaches", path());
    logout();

    // Password reset, with the link from the mail the sink received.
    browser("open", `${origin}/admin/forgot`);
    shot("forgot");
    browser("fill", "#email", "nobody@example.test");
    browser("click", "button[type=submit]");
    settle();
    const unknown = value('document.querySelector(".wrap").innerText');
    browser("open", `${origin}/admin/forgot`);
    browser("fill", "#email", "browser-user@example.test");
    browser("click", "button[type=submit]");
    settle();
    const known = value('document.querySelector(".wrap").innerText');
    see("same answer for both addresses", unknown === known);
    see("answer", known);
    const mail = await mailbox.one("browser-user@example.test", "Reset your password");
    const link = /href="([^"]+\/admin\/reset\?[^"]+)"/
      .exec(mail.body)![1]!
      .replaceAll("&amp;", "&");
    browser("open", link);
    shot("reset");
    browser("fill", "#password", "browser-new-password");
    browser("fill", "#password2", "browser-new-password");
    browser("click", "button[type=submit]");
    settle();
    see("user with 2FA continues to", path());
    browser("fill", "#totp_code", totp(secret, Date.now() + 30_000));
    browser("click", "button[type=submit]");
    settle();
    see("after the factor", path());
    browser("open", link);
    see("the link again", value('document.querySelector(".wrap").innerText'));
    browser("open", `${blankOrigin}/admin/login`);
    see("fresh install", value('document.querySelector(".login").innerText'));
    shot("first-time");
    return 0;
  } finally {
    try {
      browser("close");
    } catch (error) {
      console.error(error);
    }
  }
});
