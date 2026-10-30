import { afterAll, beforeAll, expect, test } from "bun:test";
import { admin, api, get, login, userWith, type Fixture } from "@/test/admin/support";
import { startUserFixture } from "@/test/users/fixture";

const sent = "If the account is active, you will receive a password reset email.";
const form = { "content-type": "application/x-www-form-urlencoded" };
let f: Fixture;
let cookie = "";
beforeAll(async () => {
  f = await startUserFixture();
  cookie = (await login(f, admin.user, admin.password)).cookie;
});
afterAll(() => f.close());

const forgot = (email: string, headers: Record<string, string> = {}) =>
  fetch(`${f.origin}/admin/forgot`, {
    method: "POST",
    headers: { ...form, ...headers },
    body: new URLSearchParams({ email }),
  });
const reset = (link: string, password: string, password2 = password, extra = {}) =>
  fetch(`${f.origin}${link}`, {
    method: "POST",
    redirect: "manual",
    headers: { ...form, ...extra },
    body: new URLSearchParams({ password, password2 }),
  });
/** The newest mail to the address, waited for: the handler answers before it sends. */
async function resetLink(address: string, seen = 0): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await fetch(`${f.origin}/fixture/mail`);
    const { data } = (await response.json()) as { data: { to: string[]; body: string }[] };
    const mails = data.filter((mail) => mail.to[0] === address);
    if (mails.length > seen) {
      const href = /href="http:\/\/fixture\.test(\/admin\/reset\?[^"]+)"/.exec(mails.at(-1)!.body);
      return href![1]!.replaceAll("&amp;", "&");
    }
    await Bun.sleep(5);
  }
  throw new Error(`No mail for ${address}`);
}
const mailCount = async () =>
  ((await (await fetch(`${f.origin}/fixture/mail`)).json()) as { data: unknown[] }).data.length;

test("the screens keep upstream's fields and the login page links to them", async () => {
  const login = await (await get(f, "/admin/login")).text();
  expect(login).toContain('href="/admin/forgot"');
  const page = await (await get(f, "/admin/forgot")).text();
  expect(page).toContain('action="/admin/forgot"');
  expect(page).toContain('name="email"');
});

test("the answer does not reveal whether an address exists", async () => {
  await userWith(f, cookie, "reset-known", []);
  const before = await mailCount();
  const unknown = await forgot("nobody@example.test");
  const known = await forgot("reset-known@example.test");
  expect(unknown.status).toBe(200);
  expect(known.status).toBe(200);
  const [left, right] = [await unknown.text(), await known.text()];
  expect(left).toBe(right);
  expect(left).toContain(sent);
  await resetLink("reset-known@example.test");
  await Bun.sleep(20);
  expect(await mailCount()).toBe(before + 1);
});

test("a link sets the password once, ends sessions and logs the user in", async () => {
  const old = await userWith(f, cookie, "reset-once", []);
  await forgot("RESET-once@example.test ");
  const link = await resetLink("reset-once@example.test");
  const page = await get(f, link);
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(page.headers.get("referrer-policy")).toBe("same-origin");
  const html = await page.text();
  expect(html).toContain('name="password2"');

  const short = await reset(link, "short");
  expect(await short.text()).toContain("password");
  const different = await reset(link, "fixture-new-password", "fixture-other-password");
  expect(await different.text()).toContain("Passwords don&#39;t match");

  const done = await reset(link, "  fixture-new-password  ");
  expect(done.status).toBe(302);
  expect(done.headers.get("location")).toBe("/admin");
  const session = done.headers.getSetCookie().find((value) => value.startsWith("session="))!;
  expect((await get(f, "/admin", session.split(";", 1)[0]!)).status).toBe(200);
  expect((await get(f, "/admin", old)).status).toBe(307);

  expect((await get(f, link)).status).toBe(400);
  expect((await reset(link, "fixture-third-password")).status).toBe(400);
  await login(f, "reset-once", "  fixture-new-password  ");
});

test("a link expires on the injected clock and a wrong token is refused", async () => {
  await userWith(f, cookie, "reset-expiry", []);
  await forgot("reset-expiry@example.test");
  const link = await resetLink("reset-expiry@example.test");
  expect((await get(f, link.replace(/token=[^&]+/, "token=wrong"))).status).toBe(400);
  await fetch(`${f.origin}/fixture/clock`, { method: "POST", body: String(30 * 60_000 - 1) });
  expect((await get(f, link)).status).toBe(200);
  await fetch(`${f.origin}/fixture/clock`, { method: "POST", body: "1" });
  const expired = await get(f, link);
  expect(expired.status).toBe(400);
  expect(await expired.text()).toContain("Invalid or expired reset link");
});

test("repeat requests neither flood the mailbox nor retire the link", async () => {
  await userWith(f, cookie, "reset-flood", []);
  const before = await mailCount();
  const unknown = await (await forgot("flood-nobody@example.test")).text();
  await forgot("reset-flood@example.test");
  const first = await resetLink("reset-flood@example.test");
  for (let i = 0; i < 5; i++) {
    const again = await forgot("reset-flood@example.test");
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(unknown);
  }
  await Bun.sleep(20);
  expect(await mailCount()).toBe(before + 1);
  expect((await get(f, first)).status).toBe(200);
  // After the interval the same link goes out again, keeping its 30 minutes.
  await fetch(`${f.origin}/fixture/clock`, { method: "POST", body: String(5 * 60_000) });
  await forgot("reset-flood@example.test");
  expect(await resetLink("reset-flood@example.test", 1)).toBe(first);
  await fetch(`${f.origin}/fixture/clock`, { method: "POST", body: String(25 * 60_000) });
  expect((await get(f, first)).status).toBe(400);
});

test("an identity change retires the link", async () => {
  await userWith(f, cookie, "reset-newer", []);
  await forgot("reset-newer@example.test");
  const second = await resetLink("reset-newer@example.test");
  const { data } = (await (await get(f, "/api/users", cookie)).json()) as {
    data: { id: number; username: string }[];
  };
  const user = data.find((item) => item.username === "reset-newer")!;
  const disabled = await api(f, cookie, `/api/users/${user.id}`, "PUT", {
    ...user,
    status: "disabled",
    password_login: true,
  });
  expect(disabled.status).toBe(200);
  expect((await get(f, second)).status).toBe(400);
});

test("a link dies when its account moves to another mailbox", async () => {
  const session = await userWith(f, cookie, "reset-moved", []);
  await forgot("reset-moved@example.test");
  const link = await resetLink("reset-moved@example.test");
  const moved = await api(f, session, "/api/profile", "PUT", {
    name: "reset-moved",
    email: "reset-moved-new@example.test",
  });
  expect(moved.status).toBe(200);
  expect((await get(f, link)).status).toBe(400);
});

test("the second factor still stands after a reset", async () => {
  const { data: id } = (await (
    await fetch(`${f.origin}/fixture/totp-user`, { method: "POST" })
  ).json()) as { data: number };
  expect(id).toBeGreaterThan(0);
  await forgot("fixture-totp@example.test");
  const link = await resetLink("fixture-totp@example.test");
  const done = await reset(link, "fixture-new-password");
  expect(done.status).toBe(302);
  expect(done.headers.get("location")).toStartWith("/admin/login/twofa?");
  expect(done.headers.getSetCookie()).toEqual([]);
});

test("an address that cannot log in with a password gets no mail", async () => {
  const before = await mailCount();
  await forgot("reset-newer@example.test");
  await forgot("no-at-sign");
  await Bun.sleep(20);
  expect(await mailCount()).toBe(before);
});

test("a foreign Origin is refused and the login limit counts these posts", async () => {
  const foreign = await forgot("reset-known@example.test", { origin: "https://evil.example" });
  expect(foreign.status).toBe(403);
  const wrongType = await fetch(`${f.origin}/admin/forgot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(wrongType.status).toBe(415);
  const limited = await startUserFixture({
    ...(await import("@/users/auth")).defaultAuthPolicy,
    loginAttempts: 1,
  });
  try {
    const post = () =>
      fetch(`${limited.origin}/admin/forgot`, {
        method: "POST",
        headers: form,
        body: "email=a%40example.test",
      });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
  } finally {
    await limited.close();
  }
});

test("a fresh install says how to provision and offers no account claim", async () => {
  const blank = await startUserFixture(undefined, false);
  try {
    const page = await fetch(`${blank.origin}/admin/login`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("IGLO_EMAIL_ADMIN_USER");
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain('name="password2"');
    await fetch(`${blank.origin}/fixture/bootstrap`, { method: "POST" });
    const provisioned = await (await fetch(`${blank.origin}/admin/login`)).text();
    expect(provisioned).not.toContain("IGLO_EMAIL_ADMIN_USER");
  } finally {
    await blank.close();
  }
});
