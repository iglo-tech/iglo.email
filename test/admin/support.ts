import { expect } from "bun:test";
import { startUserFixture } from "@/test/users/fixture";

export type Fixture = Awaited<ReturnType<typeof startUserFixture>>;
export const admin = { user: "fixture-admin", password: "fixture-admin-password" };

/** A session cookie through the real login form. */
export async function login(f: Fixture, username: string, password: string) {
  const page = await fetch(`${f.origin}/admin/login`);
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const nonceCookie = page.headers.getSetCookie()[0]!.split(";", 1)[0]!;
  const response = await fetch(`${f.origin}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie },
    body: new URLSearchParams({ username, password, nonce, next: "/admin" }),
  });
  expect(response.status).toBe(302);
  return {
    location: response.headers.get("location") ?? "",
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; "),
  };
}
export const get = (f: Fixture, path: string, cookie = "") =>
  fetch(`${f.origin}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
/** An admin API call as a session, with its CSRF header. */
export async function api(f: Fixture, cookie: string, path: string, method: string, body: unknown) {
  const csrf = /(?:^|; )csrf=([^;]+)/.exec(cookie)?.[1] ?? "";
  return fetch(`${f.origin}${path}`, {
    method,
    headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
/** A user with its own role, returning the login session. */
export async function userWith(f: Fixture, cookie: string, name: string, permissions: string[]) {
  const role = await fetch(`${f.origin}/fixture/role`, {
    method: "POST",
    body: JSON.stringify({ name, permissions }),
  });
  const { data: roleId } = (await role.json()) as { data: number };
  const created = await api(f, cookie, "/api/users", "POST", {
    username: name,
    email: `${name}@example.test`,
    name,
    type: "user",
    status: "enabled",
    password_login: true,
    password: "fixture-user-password",
    password2: "fixture-user-password",
    user_role_id: roleId,
  });
  expect(created.status).toBe(200);
  return (await login(f, name, "fixture-user-password")).cookie;
}
