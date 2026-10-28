// Reference: listmonk cmd/roles.go and cmd/users.go at 6fcd95f.
import { createHmac, randomUUID } from "node:crypto";
import type { AuthTarget } from "@/test/contract/auth";

function check(value: unknown, name: string): asserts value {
  if (!value) throw new Error(`FAIL ${name}`);
  process.stdout.write(`PASS ${name}\n`);
}

export async function runRolesContract(target: AuthTarget): Promise<void> {
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/.test(target.baseUrl))
    throw new Error("Invalid contract target");
  const auth = `Basic ${Buffer.from(`${target.credentials.user}:${target.credentials.token}`).toString("base64")}`;
  const suffix = randomUUID().replaceAll("-", "");
  const owned: number[] = [];
  let human = 0;
  async function request(path: string, method = "GET", body?: unknown, authorization = auth) {
    return fetch(`${target.baseUrl}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function create(kind: "users" | "lists", body: unknown): Promise<number> {
    const response = await request(`/api/roles/${kind}`, "POST", body);
    check(response.status === 200, `role-create-${kind}`);
    const data = ((await response.json()) as { data: { id: number } }).data;
    check(Number.isSafeInteger(data.id) && data.id > 1, `role-create-${kind}-id`);
    owned.push(data.id);
    return data.id;
  }
  function responseCookie(response: Response, name: string): string {
    return (
      response.headers
        .getSetCookie()
        .find((v) => v.startsWith(`${name}=`))
        ?.split(";", 1)[0] ?? ""
    );
  }
  function totp(secret: string): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const character of secret.replace(/=+$/, "")) {
      const index = alphabet.indexOf(character);
      if (index < 0) throw new Error("FAIL factor-secret-format");
      bits += index.toString(2).padStart(5, "0");
    }
    const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((v) => parseInt(v, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const digest = createHmac("sha1", key).update(counter).digest();
    const offset = digest[19]! & 15;
    return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
  }
  async function login(username: string, password: string) {
    const page = await fetch(`${target.baseUrl}/admin/login`);
    const html = await page.text();
    const nonce = /name="nonce"\s+value="([^"]+)"/.exec(html)?.[1] ?? "";
    return fetch(`${target.baseUrl}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: responseCookie(page, "nonce"),
      },
      body: new URLSearchParams({ username, password, nonce, next: "/api/profile" }),
    });
  }
  try {
    check(
      (await request("/api/roles/users", "GET", undefined, "")).status === 403,
      "roles-unauthenticated",
    );
    const role = await create("users", {
      name: `m14-${suffix}`,
      permissions: ["users:get", "roles:get"],
    });
    const list = await create("lists", { name: `m14-list-${suffix}`, lists: [] });
    const users = await request(`/api/roles/users?query=${suffix}`);
    const userRoles = (
      (await users.json()) as {
        data: Array<{ id: number; name: string; type: string; permissions: string[] }>;
      }
    ).data;
    check(
      users.status === 200 &&
        userRoles.some(
          (r) =>
            r.id === role &&
            r.name === `m14-${suffix}` &&
            r.type === "user" &&
            r.permissions.includes("roles:get"),
        ),
      "role-user-projection-search",
    );
    const lists = await request(`/api/roles/lists?query=${suffix}`);
    const listRoles = (
      (await lists.json()) as { data: Array<{ id: number; name: string; lists: unknown[] }> }
    ).data;
    check(
      lists.status === 200 &&
        listRoles.some(
          (r) =>
            r.id === list &&
            r.name === `m14-list-${suffix}` &&
            Array.isArray(r.lists) &&
            r.lists.length === 0,
        ),
      "role-list-projection-search",
    );
    const update = await request(`/api/roles/users/${role}`, "PUT", {
      name: `changed-${suffix}`,
      permissions: ["roles:manage"],
    });
    check(update.status === 200, "role-user-update");
    const invalid = await request("/api/roles/users", "POST", {
      name: `invalid-${suffix}`,
      permissions: ["unknown:permission"],
    });
    check(invalid.status === 400, "role-invalid-permission");
    const primordial = await request("/api/roles/users/1", "PUT", {
      name: "ignored",
      permissions: [],
    });
    check(primordial.status === 400, "role-primordial-protected");
    const username = `m14-human-${suffix}`;
    const password = "m14-synthetic-password";
    const created = await request("/api/users", "POST", {
      username,
      password,
      password_login: true,
      name: username,
      email: `${username}@example.test`,
      type: "user",
      status: "enabled",
      user_role_id: 1,
    });
    check(created.status === 200, "factor-human-create");
    human = ((await created.json()) as { data: { id: number } }).data.id;
    const firstLogin = await login(username, password);
    const session = responseCookie(firstLogin, "session");
    const csrf = responseCookie(firstLogin, "csrf").slice(5);
    check(firstLogin.status === 302 && !!session, "factor-human-login");
    async function self(path: string, method = "GET", body?: unknown) {
      return fetch(`${target.baseUrl}${path}`, {
        method,
        redirect: "manual",
        headers: {
          Cookie: session,
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    const provisioning = await self(`/api/users/${human}/twofa/totp`);
    const factor = ((await provisioning.json()) as { data: { secret: string; qr: string } }).data;
    check(
      provisioning.status === 200 &&
        /^[A-Z2-7]+=*$/.test(factor.secret) &&
        Buffer.from(factor.qr, "base64")
          .subarray(0, 8)
          .equals(Buffer.from("89504e470d0a1a0a", "hex")),
      "factor-provisioning",
    );
    const invalidFactor = await self(`/api/users/${human}/twofa`, "PUT", {
      secret: factor.secret,
      code: "invalid",
    });
    check(invalidFactor.status === 400, "factor-invalid-code");
    const enabled = await self(`/api/users/${human}/twofa`, "PUT", {
      secret: factor.secret,
      code: totp(factor.secret),
    });
    check(enabled.status === 200 && (await enabled.text()) === '{"data":true}\n', "factor-enable");
    const profile = await self("/api/profile");
    const profileData = ((await profile.json()) as { data: Record<string, unknown> }).data;
    check(
      profile.status === 200 && profileData.twofa_type === "totp" && !("twofa_key" in profileData),
      "factor-profile-no-secret",
    );
    const secondLogin = await login(username, password);
    const location = secondLogin.headers.get("location") ?? "";
    check(
      secondLogin.status === 302 &&
        !responseCookie(secondLogin, "session") &&
        location.startsWith("/admin/login/twofa?"),
      "factor-password-challenge",
    );
    const factorPage = await fetch(`${target.baseUrl}${location}`);
    const factorHtml = await factorPage.text();
    const url = new URL(location, target.baseUrl);
    const token = url.searchParams.get("token") ?? "";
    const nonce = /name="nonce"\s+value="([^"]+)"/.exec(factorHtml)?.[1] ?? "";
    check(
      factorPage.status === 200 && !!token && factorHtml.includes('name="totp_code"'),
      "factor-form",
    );
    const verify = await fetch(`${target.baseUrl}/admin/login/twofa`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: responseCookie(factorPage, "nonce"),
      },
      body: new URLSearchParams({
        token,
        next: "/api/profile",
        totp_code: totp(factor.secret),
        nonce,
      }),
    });
    check(
      verify.status === 302 &&
        verify.headers.get("location") === "/api/profile" &&
        !!responseCookie(verify, "session"),
      "factor-login-success",
    );
    const disabled = await self(`/api/users/${human}/twofa`, "DELETE", { password });
    check(disabled.status === 200, "factor-disable");
    const wrongKind = await request(`/api/roles/users/${list}`, "PUT", {
      name: `wrong-${suffix}`,
      permissions: [],
    });
    check(
      wrongKind.status === (target.mode === "reference" ? 200 : 400),
      "D30-role-wrong-kind-update",
    );
  } finally {
    if (human) {
      const response = await request(`/api/users/${human}`, "DELETE");
      if (response.status !== 200) throw new Error("FAIL factor-human-cleanup");
    }
    for (const id of owned.reverse()) {
      const response = await request(`/api/roles/${id}`, "DELETE");
      if (response.status !== 200) throw new Error("FAIL role-cleanup");
    }
  }
}

if (import.meta.main) {
  try {
    if (process.argv[2] !== "reference") throw new Error("Invalid mode");
    const {
      REFERENCE_URL: baseUrl,
      REFERENCE_API_USER: user,
      REFERENCE_API_TOKEN: token,
    } = process.env;
    if (!baseUrl || !user || !token) throw new Error("Missing reference credentials");
    await runRolesContract({
      mode: "reference",
      baseUrl,
      credentials: { user, token },
      admin: { user: "reference-admin", password: "reference-admin-password" },
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-]+$/.test(error.message) ? error.message : "Roles contract failed"}\n`,
    );
    process.exitCode = 1;
  }
}
