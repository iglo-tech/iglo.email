// Reference: listmonk cmd/auth.go, cmd/users.go and internal/auth/auth.go at 6fcd95f.
import { randomUUID } from "node:crypto";
import type { Credentials, Mode } from "@/test/contract/types";
import { rawRequest } from "@/test/server/raw-request";

interface UserRecord {
  id: number;
  username: string;
  name: string;
  email: string | null;
  type: string;
  status: string;
  password_login: boolean;
  password: string | null;
  user_role: { id: number; name: string; permissions: string[] };
  list_role: unknown;
}

interface Login {
  response: Response;
  session: string;
  csrf: string;
  body: string;
}

export interface AuthTarget {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
  admin: { user: string; password: string };
}

function check(value: unknown, name: string): asserts value {
  if (!value) throw new Error(`FAIL ${name}`);
  process.stdout.write(`PASS ${name}\n`);
}

function cookie(response: Response, name: string): string {
  const header = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  return header?.split(";", 1)[0] ?? "";
}

async function form(
  target: AuthTarget,
  username: string,
  password: string,
  includeNonce = true,
): Promise<Login> {
  const page = await fetch(`${target.baseUrl}/admin/login?next=%2Fapi%2Fprofile`, {
    redirect: "manual",
  });
  const html = await page.text();
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(html)?.[1] ?? "";
  const nonceCookie = cookie(page, "nonce");
  if (page.status !== 200 || !nonce || !nonceCookie) throw new Error("FAIL login-form");
  const response = await fetch(`${target.baseUrl}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: nonceCookie },
    body: new URLSearchParams({
      username,
      password,
      next: "/api/profile",
      ...(includeNonce ? { nonce } : {}),
    }),
  });
  const body = await response.text();
  return { response, session: cookie(response, "session"), csrf: cookie(response, "csrf"), body };
}

function header(credentials: Credentials): string {
  return `Basic ${Buffer.from(`${credentials.user}:${credentials.token}`).toString("base64")}`;
}

async function request(
  target: AuthTarget,
  path: string,
  options: {
    method?: string;
    auth?: string;
    cookie?: string;
    csrf?: string;
    origin?: string;
    body?: unknown;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.auth) headers.set("Authorization", options.auth);
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.csrf) headers.set("X-CSRF-Token", options.csrf);
  if (options.origin) headers.set("Origin", options.origin);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${target.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: "manual",
  });
}

async function user(response: Response): Promise<UserRecord> {
  if (response.status !== 200) throw new Error(`FAIL user-response-status-${response.status}`);
  const value = (await response.json()) as { data?: UserRecord };
  if (!value.data || !Number.isSafeInteger(value.data.id) || value.data.id < 1)
    throw new Error("FAIL user-response-id");
  const keys = [
    "avatar",
    "created_at",
    "email",
    "id",
    "list_role",
    "loggedin_at",
    "name",
    "password",
    "password_login",
    "status",
    "twofa_type",
    "type",
    "updated_at",
    "user_role",
    "username",
  ];
  const entry = value.data as unknown as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(keys.sort()) ||
    typeof entry.username !== "string" ||
    typeof entry.name !== "string" ||
    (entry.email !== null && typeof entry.email !== "string") ||
    (entry.password !== null && typeof entry.password !== "string") ||
    typeof entry.password_login !== "boolean" ||
    !["user", "api"].includes(String(entry.type)) ||
    !["enabled", "disabled"].includes(String(entry.status)) ||
    entry.avatar !== null ||
    entry.twofa_type !== "none" ||
    entry.list_role !== null ||
    typeof entry.created_at !== "string" ||
    !Number.isFinite(Date.parse(entry.created_at)) ||
    typeof entry.updated_at !== "string" ||
    !Number.isFinite(Date.parse(entry.updated_at)) ||
    (entry.loggedin_at !== null &&
      (typeof entry.loggedin_at !== "string" || !Number.isFinite(Date.parse(entry.loggedin_at))))
  )
    throw new Error("FAIL user-response-shape");
  const role = value.data.user_role;
  if (
    !role ||
    JSON.stringify(Object.keys(role).sort()) !== JSON.stringify(["id", "name", "permissions"]) ||
    role.id !== 1 ||
    role.name !== "Super Admin" ||
    !Array.isArray(role.permissions) ||
    role.permissions.length !== 28 ||
    new Set(role.permissions).size !== 28 ||
    !role.permissions.includes("users:get") ||
    !role.permissions.includes("users:manage")
  )
    throw new Error("FAIL user-role-shape");
  return value.data;
}

/** One stateful corpus for the disposable reference and compiled production. */
export async function runAuthContract(target: AuthTarget): Promise<void> {
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/.test(target.baseUrl))
    throw new Error("Invalid contract target");
  const basic = header(target.credentials);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const name = `m13-human-${suffix}`;
  const profileName = `m13-profile-${suffix}`;
  const apiName = `m13-api-${suffix}`;
  const password = "  m13-spaced-password  ";
  const email = `${name}@example.test`;
  const created: number[] = [];
  let cleanupFailed = false;
  try {
    const health = await request(target, "/api/health", { auth: basic });
    check(
      health.status === 200 && (await health.text()) === '{"data":true}\n',
      "auth-health-basic",
    );
    const tokenHealth = await request(target, "/api/health", {
      auth: `token ${target.credentials.user}:${target.credentials.token}`,
    });
    check(
      tokenHealth.status === 200 && (await tokenHealth.text()) === '{"data":true}\n',
      "auth-health-token",
    );
    const invalid = await request(target, "/api/health", { auth: "token invalid:invalid" });
    check(
      invalid.status === 403 &&
        ((await invalid.json()) as { message: string }).message === "invalid API credentials",
      "auth-invalid-token",
    );
    for (const [authorization, message, caseName] of [
      ["Bearer abc", "unknown Authorization scheme", "auth-unknown-scheme"],
      ["Basic !!", "invalid Base64 value in Basic Authorization header", "auth-invalid-base64"],
      ["token missing", "api_key:token missing", "auth-missing-pair"],
      ["token :empty", "empty `api_key` or `token`", "auth-empty-key"],
    ]) {
      const response = await request(target, "/api/health", { auth: authorization! });
      const observed = ((await response.json()) as { message: string }).message;
      const expected = `code=400, message=${message}`;
      check(response.status === 403 && observed === expected, caseName!);
    }

    const admin = await form(target, target.admin.user, target.admin.password);
    check(
      admin.response.status === 302 &&
        admin.response.headers.get("location") === "/api/profile" &&
        !!admin.session,
      "login-success",
    );
    const profile = await request(target, "/api/profile", { cookie: admin.session });
    check((await user(profile)).username === target.admin.user, "login-profile");
    const invalidWithCookie = await request(target, "/api/health", {
      auth: "token invalid:invalid",
      cookie: admin.session,
    });
    check(
      invalidWithCookie.status === (target.mode === "reference" ? 200 : 403),
      "D26-header-precedence-invalid",
    );
    const selectedProfile = await request(target, "/api/profile", {
      auth: basic,
      cookie: admin.session,
    });
    check(
      (await user(selectedProfile)).username ===
        (target.mode === "reference" ? target.admin.user : target.credentials.user),
      "D26-header-precedence-principal",
    );
    const noNonce = await form(target, target.admin.user, target.admin.password, false);
    check(noNonce.response.status === (target.mode === "reference" ? 302 : 403), "D26-login-nonce");

    const human = await user(
      await request(target, "/api/users", {
        method: "POST",
        auth: basic,
        body: {
          username: name,
          name: "",
          email: ` ${email.toUpperCase()} `,
          type: "user",
          status: "enabled",
          password_login: true,
          password,
          user_role_id: 1,
        },
      }),
    );
    created.push(human.id);
    check(
      human.username === name &&
        human.name === name &&
        human.email === email &&
        human.type === "user" &&
        human.status === "enabled" &&
        human.user_role.id === 1 &&
        human.list_role === null &&
        !human.password,
      "users-create-human",
    );
    const duplicate = await request(target, "/api/users", {
      method: "POST",
      auth: basic,
      body: {
        username: name,
        email: `duplicate-${suffix}@example.test`,
        type: "user",
        status: "enabled",
        user_role_id: 1,
      },
    });
    const duplicateBody = (await duplicate.json()) as { message: string };
    check(
      duplicate.status === 500 &&
        duplicateBody.message ===
          `Error creating User: pq: duplicate key value violates unique constraint "users_username_key" (23505). Key (username)=(${name}) already exists.`,
      "users-duplicate-username",
    );
    const noRole = await request(target, "/api/users", {
      method: "POST",
      auth: basic,
      body: {
        username: `m13-invalid-role-${suffix}`,
        type: "api",
        status: "enabled",
        user_role_id: 0,
      },
    });
    // Upstream's database error may contain credential digests; never print its body.
    check(
      noRole.status === (target.mode === "reference" ? 500 : 400),
      "proposed-invalid-role-safe-error",
    );
    const invalidRoleMessage = ((await noRole.json()) as { message: string }).message;
    check(
      target.mode === "reference"
        ? /\b[a-f0-9]{64}\b/.test(invalidRoleMessage)
        : !/\b[a-f0-9]{64}\b/.test(invalidRoleMessage),
      "proposed-invalid-role-no-digest-leak",
    );
    const fetched = await user(await request(target, `/api/users/${human.id}`, { auth: basic }));
    check(
      fetched.id === human.id && fetched.username === name && !fetched.password,
      "users-get-human",
    );
    const listResponse = await request(target, "/api/users?order_by=username&order=asc", {
      auth: basic,
    });
    const list = (await listResponse.json()) as { data: UserRecord[] };
    check(
      listResponse.status === 200 &&
        Array.isArray(list.data) &&
        list.data.some((entry) => entry.id === human.id && !entry.password),
      "users-list",
    );
    if (target.mode === "reference") {
      const listRoleName = `m13-list-role-${suffix}`;
      const roleResponse = await request(target, "/api/roles/lists", {
        method: "POST",
        auth: basic,
        body: { name: listRoleName, lists: [] },
      });
      if (roleResponse.status !== 200) throw new Error("FAIL reference-list-role-setup");
      const role = ((await roleResponse.json()) as { data: { id: number } }).data;
      if (!Number.isSafeInteger(role.id) || role.id < 1)
        throw new Error("FAIL reference-list-role-id");
      let listUserId = 0;
      try {
        const response = await request(target, "/api/users", {
          method: "POST",
          auth: basic,
          body: {
            username: `m13-list-user-${suffix}`,
            email: `m13-list-user-${suffix}@example.test`,
            type: "user",
            status: "enabled",
            user_role_id: 1,
            list_role_id: role.id,
          },
        });
        if (response.status !== 200) throw new Error("FAIL reference-list-user-setup");
        const entry = (
          (await response.json()) as {
            data: { id: number; list_role_id: number; list_role: unknown };
          }
        ).data;
        listUserId = entry.id;
        check(
          Number.isSafeInteger(listUserId) &&
            listUserId > 0 &&
            entry.list_role_id === role.id &&
            JSON.stringify(entry.list_role) ===
              JSON.stringify({ id: role.id, name: listRoleName, lists: null }),
          "reference-user-detail-empty-list-role",
        );
        const responseList = await request(target, "/api/users", { auth: basic });
        const entries = (
          (await responseList.json()) as { data: { id: number; list_role: unknown }[] }
        ).data;
        const listRole = entries.find((item) => item.id === listUserId)?.list_role;
        check(
          JSON.stringify(listRole) ===
            JSON.stringify({
              id: role.id,
              name: listRoleName,
              lists: [{ id: 0, name: "", permissions: [] }],
            }),
          "reference-user-list-empty-list-role",
        );
      } finally {
        if (listUserId)
          await request(target, `/api/users/${listUserId}`, { method: "DELETE", auth: basic });
        await request(target, `/api/roles/${role.id}`, { method: "DELETE", auth: basic });
      }
    }
    const spaced = await form(target, name, password);
    check(
      target.mode === "reference"
        ? spaced.response.status === 200 && !spaced.session
        : spaced.response.status === 302 && !!spaced.session,
      "D26-exact-password",
    );

    const api = await user(
      await request(target, "/api/users", {
        method: "POST",
        auth: basic,
        body: { username: apiName, type: "api", status: "enabled", user_role_id: 1 },
      }),
    );
    created.push(api.id);
    check(
      api.username === apiName &&
        api.type === "api" &&
        api.email === null &&
        typeof api.password === "string" &&
        api.password.length === 48,
      "users-create-api-token",
    );
    const apiAuth = header({ user: apiName, token: api.password! });
    const apiRead = await user(await request(target, `/api/users/${api.id}`, { auth: basic }));
    check(!apiRead.password && apiRead.id === api.id, "users-token-returned-once");
    check(
      (await request(target, "/api/health", { auth: apiAuth })).status === 200,
      "users-created-token-auth",
    );
    const conversionName = `m13-convert-${suffix}`;
    const conversion = await user(
      await request(target, "/api/users", {
        method: "POST",
        auth: basic,
        body: { username: conversionName, type: "api", status: "enabled", user_role_id: 1 },
      }),
    );
    created.push(conversion.id);
    const conversionResponse = await request(target, `/api/users/${conversion.id}`, {
      method: "PUT",
      auth: basic,
      body: {
        username: conversionName,
        type: "user",
        status: "enabled",
        user_role_id: 1,
        email: `${conversionName}@example.test`,
        password_login: true,
      },
    });
    check(
      conversionResponse.status === (target.mode === "reference" ? 200 : 400),
      "proposed-api-to-human-password-required",
    );
    const convertedHuman = await user(
      await request(target, `/api/users/${human.id}`, {
        method: "PUT",
        auth: basic,
        body: {
          username: name,
          type: "api",
          status: "enabled",
          user_role_id: 1,
          password_login: true,
        },
      }),
    );
    check(
      convertedHuman.password_login === (target.mode === "reference"),
      "proposed-human-to-api-clears-password",
    );
    check(
      (await request(target, "/api/health", { auth: header({ user: name, token: password }) }))
        .status === 403,
      "converted-human-password-is-not-api-token",
    );
    if (target.mode === "normal")
      check(
        (await request(target, "/api/profile", { cookie: spaced.session })).status === 403,
        "converted-human-session-revoked",
      );
    const apiUpdated = await user(
      await request(target, `/api/users/${api.id}`, {
        method: "PUT",
        auth: basic,
        body: { username: apiName, type: "api", status: "disabled", user_role_id: 1 },
      }),
    );
    check(apiUpdated.status === "disabled" && !apiUpdated.password, "users-disable-api");
    check(
      (await request(target, "/api/health", { auth: apiAuth })).status === 403,
      "users-disabled-token-denied",
    );
    const deletedApi = await request(target, `/api/users?id=${api.id}`, {
      method: "DELETE",
      auth: basic,
    });
    check(
      deletedApi.status === 200 && ((await deletedApi.json()) as { data: boolean }).data === true,
      "users-delete-batch",
    );
    created.splice(created.indexOf(api.id), 1);
    check(
      (await request(target, `/api/users/${api.id}`, { auth: basic })).status === 404,
      "users-deleted-not-found",
    );

    const profileUser = await user(
      await request(target, "/api/users", {
        method: "POST",
        auth: basic,
        body: {
          username: profileName,
          email: `${profileName}@example.test`,
          type: "user",
          status: "enabled",
          password_login: true,
          password: "m13-contract-password",
          user_role_id: 1,
        },
      }),
    );
    created.push(profileUser.id);
    const profileLogin = await form(target, profileName, "m13-contract-password");
    check(profileLogin.response.status === 302 && !!profileLogin.session, "profile-login");
    const profileCookie = [profileLogin.session, profileLogin.csrf].filter(Boolean).join("; ");
    const profileCsrf = profileLogin.csrf.slice("csrf=".length);
    const profileUpdate = {
      name: "Updated test user",
      email: `${profileName}@example.test`,
      username: "attempted-escalation",
      type: "api",
      user_role_id: 999,
    };
    if (target.mode === "normal") {
      const missing = await request(target, "/api/profile", {
        method: "PUT",
        cookie: profileCookie,
        body: profileUpdate,
      });
      const wrong = await request(target, "/api/profile", {
        method: "PUT",
        cookie: profileCookie,
        csrf: "wrong",
        body: profileUpdate,
      });
      const other = await request(target, "/api/profile", {
        method: "PUT",
        cookie: profileCookie,
        csrf: admin.csrf.slice("csrf=".length),
        body: profileUpdate,
      });
      const foreign = await request(target, "/api/profile", {
        method: "PUT",
        cookie: profileCookie,
        csrf: profileCsrf,
        origin: "https://foreign.example.test",
        body: profileUpdate,
      });
      check(
        missing.status === 403 &&
          wrong.status === 403 &&
          other.status === 403 &&
          foreign.status === 403,
        "D26-profile-csrf-origin-denied",
      );
      const unchanged = await user(
        await request(target, "/api/profile", { cookie: profileCookie }),
      );
      check(unchanged.name === profileName, "profile-denial-no-write");
    }
    const updatedProfile = await user(
      await request(target, "/api/profile", {
        method: "PUT",
        cookie: profileCookie,
        csrf: profileCsrf,
        body: profileUpdate,
      }),
    );
    check(
      updatedProfile.name === "Updated test user" &&
        updatedProfile.username === profileName &&
        updatedProfile.type === "user" &&
        updatedProfile.user_role.id === 1,
      "profile-update-restricted-fields",
    );

    if (target.mode === "reference") {
      let reset = false;
      try {
        await rawRequest(target.baseUrl, "/api/logout", {
          method: "POST",
          headers: { Authorization: basic },
        });
      } catch (error) {
        reset = (error as { code?: string }).code === "ECONNRESET";
      }
      check(reset, "D26-header-only-logout");
    } else {
      const tokenLogout = await request(target, "/api/logout", { method: "POST", auth: basic });
      check(
        tokenLogout.status === 200 &&
          JSON.stringify(await tokenLogout.json()) === '{"data":true,"redirect_url":null}',
        "D26-header-only-logout",
      );
    }
    check(
      (await request(target, "/api/health", { auth: basic })).status === 200,
      "users-logout-token-remains-valid",
    );

    const noCsrf = await request(target, "/api/logout", { method: "POST", cookie: admin.session });
    check(noCsrf.status === (target.mode === "reference" ? 200 : 403), "D26-session-csrf");
    if (target.mode === "normal") {
      check(!!admin.csrf, "session-csrf-cookie");
      const csrf = admin.csrf.slice("csrf=".length);
      const foreign = await request(target, "/api/logout", {
        method: "POST",
        cookie: `${admin.session}; ${admin.csrf}`,
        csrf,
        origin: "https://foreign.example.test",
      });
      check(foreign.status === 403, "D26-foreign-origin");
      const logout = await request(target, "/api/logout", {
        method: "POST",
        cookie: `${admin.session}; ${admin.csrf}`,
        csrf,
      });
      check(
        logout.status === 200 &&
          (await request(target, "/api/profile", { cookie: admin.session })).status === 403,
        "session-logout-revokes",
      );
    }
  } finally {
    for (const id of created.reverse()) {
      try {
        const response = await request(target, `/api/users/${id}`, {
          method: "DELETE",
          auth: basic,
        });
        if (response.status !== 200) cleanupFailed = true;
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) process.stderr.write("FAIL cleanup-user\n");
  }
  if (cleanupFailed) throw new Error("FAIL cleanup-user");
}

if (import.meta.main) {
  try {
    if (process.argv[2] !== "reference")
      throw new Error("Use the reference or owned production contract command");
    const baseUrl = process.env.REFERENCE_URL ?? "";
    const apiUser = process.env.REFERENCE_API_USER ?? "";
    const apiToken = process.env.REFERENCE_API_TOKEN ?? "";
    if (!apiUser || !apiToken) throw new Error("Missing reference credentials");
    await runAuthContract({
      mode: "reference",
      baseUrl,
      credentials: { user: apiUser, token: apiToken },
      admin: { user: "reference-admin", password: "reference-admin-password" },
    });
  } catch (error) {
    // Only fixed diagnostics and status codes are printed, never response bodies or credentials.
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-]+$/.test(error.message) ? error.message : "Auth contract failed"}\n`,
    );
    process.exitCode = 1;
  }
}
