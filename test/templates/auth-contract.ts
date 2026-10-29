// Production-only D26/D54 authorization checks for the template routes.
import type { Credentials } from "@/test/contract/types";

export async function runTemplateAuthorization(
  baseUrl: string,
  credentials: Credentials,
  admin: { user: string; password: string },
) {
  const authorization = `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`;
  const ownedRoles: number[] = [],
    ownedUsers: number[] = [],
    ownedTemplates: number[] = [];
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const check = (value: unknown, label: string) => {
    if (!value) throw new Error(`FAIL template-auth-${label}`);
  };
  async function token(permissions: string[]) {
    const name = `m18-${crypto.randomUUID()}`;
    const roleResponse = await request("/api/roles/users", "POST", { name, permissions });
    check(roleResponse.status === 200, "role-create");
    const role = ((await roleResponse.json()) as { data: { id: number } }).data.id;
    ownedRoles.push(role);
    const userResponse = await request("/api/users", "POST", {
      username: name,
      type: "api",
      status: "enabled",
      user_role_id: role,
    });
    check(userResponse.status === 200, "user-create");
    const user = ((await userResponse.json()) as { data: { id: number; password: string } }).data;
    ownedUsers.push(user.id);
    return `Basic ${btoa(`${name}:${user.password}`)}`;
  }
  try {
    const denied = await token([]),
      reader = await token(["templates:get"]),
      writer = await token(["templates:manage"]);
    const candidate = {
      name: "synthetic auth fixture",
      type: "tx",
      subject: "subject",
      body: "body",
    };
    check(
      (await request("/api/templates", "GET", undefined, { authorization: denied })).status === 403,
      "denied-read",
    );
    check(
      (await request("/api/templates", "POST", candidate, { authorization: denied })).status ===
        403,
      "denied-write",
    );
    check(
      (await request("/api/templates", "GET", undefined, { authorization: reader })).status === 200,
      "reader",
    );
    check(
      (await request("/api/templates", "POST", candidate, { authorization: reader })).status ===
        403,
      "reader-no-write",
    );
    check(
      (await request("/api/templates", "GET", undefined, { authorization: writer })).status === 403,
      "writer-no-read",
    );
    const created = await request("/api/templates", "POST", candidate, { authorization: writer });
    check(created.status === 200, "writer");
    ownedTemplates.push(((await created.json()) as { data: { id: number } }).data.id);
    const page = await fetch(`${baseUrl}/admin/login`),
      text = await page.text();
    const nonce = /name="nonce"\s+value="([^"]+)"/.exec(text)?.[1];
    const nonceCookie = page.headers
      .getSetCookie()
      .find((x) => x.startsWith("nonce="))
      ?.split(";", 1)[0];
    check(nonce && nonceCookie, "nonce");
    const login = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie! },
      body: new URLSearchParams({ username: admin.user, password: admin.password, nonce: nonce! }),
    });
    const cookies = login.headers.getSetCookie();
    const session = cookies.find((x) => x.startsWith("session="))?.split(";", 1)[0];
    const csrf = cookies.find((x) => x.startsWith("csrf="))?.split(";", 1)[0];
    check(login.status === 302 && session && csrf, "login");
    const cookie = `${session}; ${csrf}`;
    const headers = { cookie, authorization: "" };
    check(
      (
        await request("/api/templates", "GET", undefined, {
          ...headers,
          authorization: "Basic invalid",
        })
      ).status === 403,
      "credential-precedence",
    );
    check((await request("/api/templates", "POST", candidate, headers)).status === 403, "csrf");
    check(
      (
        await request("/api/templates", "POST", candidate, {
          ...headers,
          "x-csrf-token": csrf!.slice(5),
          origin: "http://foreign.invalid",
        })
      ).status === 403,
      "origin",
    );
    const allowed = await request("/api/templates", "POST", candidate, {
      ...headers,
      "x-csrf-token": csrf!.slice(5),
      origin: baseUrl,
    });
    check(allowed.status === 200, "cookie-write");
    ownedTemplates.push(((await allowed.json()) as { data: { id: number } }).data.id);
    const postPreview = await fetch(`${baseUrl}/api/templates/preview`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ body: "{{ content | raw }}" }),
    });
    check(postPreview.status === 403, "preview-csrf");
  } finally {
    for (const id of ownedTemplates) await request(`/api/templates/${id}`, "DELETE");
    for (const id of ownedUsers) await request(`/api/users/${id}`, "DELETE");
    for (const id of ownedRoles) await request(`/api/roles/users/${id}`, "DELETE");
  }
}
