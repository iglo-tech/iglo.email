// Public-boundary tests for the M1.2 policy and authorization seams.
import { createConnection } from "node:net";
import type { Credentials } from "@/test/contract/types";

export async function runSettingsLive(target: {
  baseUrl: string;
  credentials: Credentials;
  admin: { user: string; password: string };
}) {
  const base = target.baseUrl;
  const adminAuth = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  function check(value: unknown, label: string): asserts value {
    if (!value) throw new Error(`FAIL settings-live-${label}`);
  }
  const request = (path: string, method = "GET", body?: unknown, auth = adminAuth) =>
    fetch(base + path, {
      method,
      headers: {
        Authorization: auth,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function pending(path: string, authorization: string, payload: string, method = "PUT") {
    const url = new URL(base),
      socket = createConnection({ host: "127.0.0.1", port: Number(url.port) });
    const result = new Promise<string>((resolve, reject) => {
      let output = "";
      socket.on("data", (part) => (output += part.toString()));
      socket.on("end", () => resolve(output));
      socket.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", resolve);
    });
    const split = Math.floor(payload.length / 2);
    socket.write(
      `${method} ${path} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: ${authorization}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload.slice(0, split)}`,
    );
    return {
      finish: () => {
        socket.end(payload.slice(split));
        return result;
      },
    };
  }
  const get = async () =>
    ((await (await request("/api/settings")).json()) as { data: Record<string, any> }).data;
  const key = (name: string, body: unknown) => request(`/api/settings/${name}`, "PUT", body);
  const initial = await get();
  check((await key("security.session_duration", "1h")).status === 501, "session-duration-staged");
  check(
    (await get())["security.session_duration"] === initial["security.session_duration"],
    "session-duration-unchanged",
  );
  check((await key("app.root_url", "http://example.invalid")).status === 400, "root-readonly");
  check(
    (await key("app.check_updates", true)).status === 400 &&
      (await get())["app.check_updates"] === false,
    "updates-disabled",
  );
  const two = await Promise.all([
    key("app.site_name", "Concurrent A"),
    key("app.logo_url", "Concurrent B"),
  ]);
  check(
    two.every((r) => r.status === 200),
    "concurrent-status",
  );
  const concurrent = await get();
  check(
    concurrent["app.site_name"] === "Concurrent A" && concurrent["app.logo_url"] === "Concurrent B",
    "concurrent-values",
  );
  const secret = "synthetic-ƒ-password";
  check((await key("bounce.sendgrid_key", secret)).status === 200, "secret-write");
  let view = await get();
  check(
    view["bounce.sendgrid_key"] === "•".repeat([...secret].length) &&
      !JSON.stringify(view).includes(secret),
    "secret-mask",
  );
  check((await key("bounce.sendgrid_key", "")).status === 200, "secret-retain");
  view = await get();
  check(view["bounce.sendgrid_key"] === "•".repeat([...secret].length), "secret-retained-mask");
  check((await key("privacy.domain_blocklist", [" *.Example.Test "])).status === 200, "domain-set");
  async function create(email: string) {
    return request("/api/subscribers", "POST", { email });
  }
  check((await create("a@example.test")).status === 400, "wildcard-apex");
  check((await create("a@sub.example.test")).status === 400, "wildcard-one-label");
  const nested = await create("a@deep.sub.example.test");
  check(nested.status === 200, "wildcard-no-recursion");
  const id = ((await nested.json()) as { data: { id: number } }).data.id;
  check((await key("privacy.domain_allowlist", ["example.test"])).status === 200, "allowlist-set");
  check((await create("a@example.test")).status === 200, "allowlist-precedence");
  check((await create("b@sub.example.test")).status === 400, "allowlist-excludes");
  check(
    (await request(`/api/subscribers/${id}`, "PATCH", { name: "Still allowed" })).status === 200,
    "patch-untouched-email",
  );
  const pendingSubscriber = await pending(
    "/api/subscribers",
    adminAuth,
    JSON.stringify({ email: "pending@example.test" }),
    "POST",
  );
  check(
    (await key("privacy.domain_allowlist", ["other.test"])).status === 200,
    "inflight-policy-change",
  );
  check((await pendingSubscriber.finish()).includes(" 400 "), "inflight-policy-current");
  const badSmtp = structuredClone(initial.smtp);
  for (const server of badSmtp) server.enabled = false;
  const before = await get();
  check((await key("smtp", badSmtp)).status === 400, "invalid-smtp");
  check(JSON.stringify(await get()) === JSON.stringify(before), "invalid-atomic");
  const roles: number[] = [],
    users: number[] = [];
  try {
    async function token(perms: string[]) {
      const name = `m12-${crypto.randomUUID()}`;
      const roleResponse = await request("/api/roles/users", "POST", { name, permissions: perms });
      check(roleResponse.status === 200, "role-create");
      const role = ((await roleResponse.json()) as { data: { id: number } }).data.id;
      roles.push(role);
      const userResponse = await request("/api/users", "POST", {
        username: name,
        type: "api",
        status: "enabled",
        user_role_id: role,
      });
      check(userResponse.status === 200, "user-create");
      const user = (
        (await userResponse.json()) as { data: { id: number; username: string; password: string } }
      ).data;
      users.push(user.id);
      return { role, name, auth: `Basic ${btoa(`${user.username}:${user.password}`)}` };
    }
    const reader = await token(["settings:get"]),
      writer = await token(["settings:manage"]),
      denied = await token([]);
    check(
      (await request("/api/settings", "GET", undefined, reader.auth)).status === 200,
      "reader-get",
    );
    check(
      (await request("/api/settings/app.site_name", "PUT", "x", reader.auth)).status === 403,
      "reader-put",
    );
    check(
      (await request("/api/settings", "GET", undefined, writer.auth)).status === 403,
      "writer-get",
    );
    check(
      (await request("/api/settings/app.site_name", "PUT", "Writer", writer.auth)).status === 200,
      "writer-put",
    );
    check(
      (await request("/api/settings/smtp/test", "POST", {}, writer.auth)).status === 501,
      "writer-staged",
    );
    check(
      (await request("/api/settings/smtp/test", "POST", {}, denied.auth)).status === 403,
      "denied-staged",
    );
    const inflight = await pending(
      "/api/settings/app.site_name",
      writer.auth,
      JSON.stringify("late write"),
    );
    check(
      (
        await request(`/api/roles/users/${writer.role}`, "PUT", {
          name: writer.name,
          permissions: [],
        })
      ).status === 200,
      "revoke-role",
    );
    check(
      (await request("/api/settings/app.site_name", "PUT", "forbidden", writer.auth)).status ===
        403,
      "live-revocation",
    );
    check((await inflight.finish()).includes(" 403 "), "inflight-revocation");
    check((await get())["app.site_name"] === "Writer", "inflight-no-write");
    check(
      (await request("/api/settings", "GET", undefined, "token invalid:invalid")).status === 403,
      "invalid-credential",
    );
    const page = await fetch(base + "/admin/login");
    const html = await page.text(),
      nonce = /name="nonce"\s+value="([^"]+)"/.exec(html)?.[1];
    const nonceCookie = page.headers
      .getSetCookie()
      .find((c) => c.startsWith("nonce="))
      ?.split(";", 1)[0];
    check(nonce && nonceCookie, "login-form");
    const login = await fetch(base + "/admin/login", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: nonceCookie },
      body: new URLSearchParams({
        username: target.admin.user,
        password: target.admin.password,
        nonce,
      }),
    });
    const cookies = login.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("session="))?.split(";", 1)[0],
      csrf = cookies.find((c) => c.startsWith("csrf="))?.split(";", 1)[0];
    check(login.status === 302 && session && csrf, "login");
    const cookie = `${session}; ${csrf}`;
    const cookieRequest = (extra: Record<string, string>) =>
      fetch(base + "/api/settings/app.site_name", {
        method: "PUT",
        headers: { Cookie: cookie, "Content-Type": "application/json", ...extra },
        body: '"cookie"',
      });
    check((await cookieRequest({})).status === 403, "cookie-csrf");
    check(
      (await cookieRequest({ "X-CSRF-Token": csrf.slice(5), Origin: "http://foreign.invalid" }))
        .status === 403,
      "cookie-origin",
    );
    check((await cookieRequest({ "X-CSRF-Token": csrf.slice(5) })).status === 200, "cookie-valid");
  } finally {
    for (const id of users) await request(`/api/users/${id}`, "DELETE");
    for (const id of roles) await request(`/api/roles/users/${id}`, "DELETE");
  }
}
