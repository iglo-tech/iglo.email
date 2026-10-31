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
  next = "/api/profile",
): Promise<Login> {
  const page = await fetch(`${target.baseUrl}/admin/login?${new URLSearchParams({ next })}`, {
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
      next,
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
    const escaped = await form(
      target,
      target.admin.user,
      target.admin.password,
      true,
      "/api/%70rofile",
    );
    check(
      escaped.response.status === 302 &&
        escaped.response.headers.get("location") === "/api/profile" &&
        !!escaped.session,
      "login-escaped-destination-canonical",
    );
    check(
      (await user(await request(target, "/api/profile", { cookie: escaped.session }))).username ===
        target.admin.user,
      "login-escaped-destination-authenticated",
    );
    for (const [name, next, expected] of [
      ["trailing-slash", "/api/profile/", "/api/profile"],
      ["trailing-dot", "/api/profile/.", "/api/profile"],
      ["literal-parent", "/a/../api/profile", "/"],
      ["encoded-parent", "/%2e%2e/api/profile", "/"],
      ["query-dots", "/api/profile?next=..", "/api/profile"],
      ["absolute-parent", "https://outside.example.test/a/../api/profile", "/"],
      ["scheme-relative-slash", "//outside.example.test/api/profile/", "/api/profile"],
      ["embedded-parent", "/api/pro..file", "/"],
      ["encoded-final-dot", "/api/profile/%2E", "/api/profile"],
    ] as const) {
      const login = await form(target, target.admin.user, target.admin.password, true, next);
      check(
        login.response.status === 302 &&
          login.response.headers.get("location") === expected &&
          !!login.session,
        `login-next-${name}`,
      );
      // Follow only after proving this is the known local destination, never the supplied host.
      const followed = await request(target, expected, { cookie: login.session });
      if (expected === "/api/profile") {
        check(
          (await user(followed)).username === target.admin.user,
          `login-next-${name}-authenticated`,
        );
      } else {
        // The root page is not ported. Its exact fallback Location is checked
        // above; verify the issued identity at the ported profile boundary.
        await followed.text();
        check(
          (await user(await request(target, "/api/profile", { cookie: login.session })))
            .username === target.admin.user,
          `login-next-${name}-fallback-session`,
        );
      }
    }
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
      "d27-invalid-role-safe-error",
    );
    const invalidRoleMessage = ((await noRole.json()) as { message: string }).message;
    check(
      target.mode === "reference"
        ? /\b[a-f0-9]{64}\b/.test(invalidRoleMessage)
        : !/\b[a-f0-9]{64}\b/.test(invalidRoleMessage),
      "d27-invalid-role-no-digest-leak",
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
    for (const direction of ["asc", "desc"] as const) {
      const orderedResponse = await request(
        target,
        `/api/users?order_by=loggedin_at&order=${direction}`,
        { auth: basic },
      );
      const ordered = ((await orderedResponse.json()) as { data: { loggedin_at: string | null }[] })
        .data;
      check(
        orderedResponse.status === 200 &&
          Array.isArray(ordered) &&
          ordered.some((entry) => entry.loggedin_at === null) &&
          ordered.some((entry) => entry.loggedin_at !== null) &&
          ordered.every(
            (entry, index) =>
              index === 0 ||
              (direction === "asc"
                ? entry.loggedin_at === null ||
                  (ordered[index - 1]!.loggedin_at !== null &&
                    Date.parse(ordered[index - 1]!.loggedin_at!) <= Date.parse(entry.loggedin_at))
                : ordered[index - 1]!.loggedin_at === null ||
                  (entry.loggedin_at !== null &&
                    Date.parse(ordered[index - 1]!.loggedin_at!) >= Date.parse(entry.loggedin_at))),
          ),
        `users-loggedin-order-${direction}`,
      );
    }
    const literalEmail = `m13-${suffix}@[127.0.0.1]`;
    const literalResponse = await request(target, "/api/users", {
      method: "POST",
      auth: basic,
      body: {
        username: `m13-mail-${suffix}`,
        email: literalEmail,
        type: "user",
        status: "enabled",
        user_role_id: 1,
      },
    });
    const literal = await user(literalResponse);
    created.push(literal.id);
    check(literal.email === literalEmail, "users-email-domain-literal");
    for (const email of [`m13..${suffix}@example.test`, `m13-${suffix}@example..test`]) {
      const invalidEmail = await request(target, "/api/users", {
        method: "POST",
        auth: basic,
        body: {
          username: `m13-invalid-${suffix}`,
          email,
          type: "user",
          status: "enabled",
          user_role_id: 1,
        },
      });
      check(
        invalidEmail.status === 400 &&
          ((await invalidEmail.json()) as { message: string }).message === "Invalid fields: email",
        "users-email-invalid-dots",
      );
    }
    for (const [index, email] of [
      `"m13.${suffix}"@example.test`,
      `"m13 ${suffix}"@example.test`,
      `m13-${suffix}@[anything]`,
      `m13-${suffix}@[127.0.0.256]`,
      `m13-${suffix}@[IPv6:::1]`,
      `m13-${suffix}@[::1]`,
      `m13-${suffix}\u0000@example.test`,
    ].entries()) {
      const response = await request(target, "/api/users", {
        method: "POST",
        auth: basic,
        body: {
          username: `m13-mail-probe-${index}-${suffix}`,
          email,
          type: "user",
          status: "enabled",
          user_role_id: 1,
        },
      });
      check(
        response.status === 400 &&
          ((await response.json()) as { message: string }).message === "Invalid fields: email",
        `users-email-probe-${index}`,
      );
    }
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
        try {
          if (
            listUserId &&
            (await request(target, `/api/users/${listUserId}`, { method: "DELETE", auth: basic }))
              .status !== 200
          )
            cleanupFailed = true;
        } catch {
          cleanupFailed = true;
        }
        try {
          if (
            (await request(target, `/api/roles/${role.id}`, { method: "DELETE", auth: basic }))
              .status !== 200
          )
            cleanupFailed = true;
        } catch {
          cleanupFailed = true;
        }
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
    const nameOnly = await request(target, "/api/profile", {
      method: "PUT",
      auth: apiAuth,
      body: { name: "API display name" },
    });
    if (target.mode === "reference") {
      check(
        nameOnly.status === 400 &&
          ((await nameOnly.json()) as { message: string }).message === "Invalid fields: email",
        "d28-api-profile-name-only",
      );
    } else {
      const renamed = await user(nameOnly);
      check(renamed.name === "API display name" && !renamed.password, "d28-api-profile-name-only");
    }
    const suppliedPassword = "m13-profile-password-not-api-token";
    const apiProfile = await user(
      await request(target, "/api/profile", {
        method: "PUT",
        auth: apiAuth,
        body: {
          name: "API supplied credential probe",
          email: `${apiName}@example.test`,
          password: suppliedPassword,
          username: "attempted-profile-rename",
          type: "user",
          status: "disabled",
          user_role_id: 999,
        },
      }),
    );
    check(
      apiProfile.id === api.id &&
        apiProfile.name === "API supplied credential probe" &&
        apiProfile.username === apiName &&
        apiProfile.type === "api" &&
        apiProfile.status === "enabled" &&
        apiProfile.user_role.id === 1 &&
        apiProfile.email === null &&
        !apiProfile.password,
      "api-profile-restricted-fields-and-secret-omission",
    );
    // Upstream caches API credentials. An ordinary admin update reloads that cache,
    // exposing whether the profile write actually preserved the persisted token.
    await user(
      await request(target, `/api/users/${api.id}`, {
        method: "PUT",
        auth: basic,
        body: {
          username: apiName,
          name: apiProfile.name,
          type: "api",
          status: "enabled",
          user_role_id: 1,
        },
      }),
    );
    check(
      (await request(target, "/api/health", { auth: apiAuth })).status ===
        (target.mode === "reference" ? 403 : 200),
      "d28-api-profile-preserves-persisted-token",
    );
    check(
      (
        await request(target, "/api/health", {
          auth: header({ user: apiName, token: suppliedPassword }),
        })
      ).status === 403,
      "api-profile-password-is-not-api-token",
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
      "d27-api-to-human-password-required",
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
      "d27-human-to-api-clears-password",
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
  await lastHumanAdmin(target, basic);
}

/** Both callers own a disposable target; restore its bootstrap account even on failure. */
async function lastHumanAdmin(target: AuthTarget, basic: string): Promise<void> {
  const response = await request(target, "/api/users", { auth: basic });
  const list = (await response.json()) as { data: UserRecord[] };
  const humans = list.data.filter(
    (entry) => entry.type === "user" && entry.status === "enabled" && entry.user_role.id === 1,
  );
  check(
    response.status === 200 && humans.length === 1 && humans[0]!.username === target.admin.user,
    "last-admin-owned-bootstrap-precondition",
  );
  const admin = humans[0]!;
  try {
    const defaults: [string, Record<string, unknown>][] = [
      ["omitted-role-status", {}],
      ["zero-empty-role-status", { user_role_id: 0, status: "" }],
      ["omitted-role", { status: "enabled" }],
      ["omitted-status", { user_role_id: 1 }],
      ["zero-role", { user_role_id: 0, status: "enabled" }],
      ["empty-status", { user_role_id: 1, status: "" }],
    ];
    for (const [name, fields] of defaults) {
      const updated = await request(target, `/api/users/${admin.id}`, {
        method: "PUT",
        auth: basic,
        body: {
          username: admin.username,
          name: admin.name,
          email: admin.email,
          type: "user",
          password_login: true,
          ...fields,
        },
      });
      if (target.mode === "reference") {
        check(
          updated.status === 400 &&
            ((await updated.json()) as { message: string }).message ===
              "User(s) couldn't be updated. There has to be at least one active Super Admin user.",
          `d29-last-admin-${name}`,
        );
      } else {
        const unchanged = await user(updated);
        check(
          unchanged.id === admin.id &&
            unchanged.name === admin.name &&
            unchanged.username === admin.username &&
            unchanged.status === "enabled" &&
            unchanged.type === "user" &&
            unchanged.user_role.id === 1 &&
            !unchanged.password,
          `d29-last-admin-${name}`,
        );
      }
      const persisted = await user(
        await request(target, `/api/users/${admin.id}`, { auth: basic }),
      );
      check(
        persisted.type === "user" &&
          persisted.status === "enabled" &&
          persisted.user_role.id === 1 &&
          persisted.username === admin.username,
        `last-admin-${name}-authority-preserved`,
      );
    }
    const converted = await request(target, `/api/users/${admin.id}`, {
      method: "PUT",
      auth: basic,
      body: {
        username: admin.username,
        name: admin.name,
        type: "api",
        status: "enabled",
        user_role_id: 1,
      },
    });
    check(
      converted.status === (target.mode === "reference" ? 200 : 400),
      "d28-last-human-admin-conversion-guard",
    );
    if (target.mode === "reference") {
      check((await user(converted)).type === "api", "d28-reference-final-human-converted");
    } else {
      check(
        ((await converted.json()) as { message: string }).message ===
          "User(s) couldn't be updated. There has to be at least one active Super Admin user.",
        "d28-last-human-admin-error",
      );
      const preserved = await user(
        await request(target, `/api/users/${admin.id}`, { auth: basic }),
      );
      check(
        preserved.type === "user" &&
          preserved.status === "enabled" &&
          preserved.username === admin.username,
        "d28-last-human-admin-preserved",
      );
    }
  } finally {
    if (target.mode === "reference") {
      const restored = await user(
        await request(target, `/api/users/${admin.id}`, {
          method: "PUT",
          auth: basic,
          body: {
            username: admin.username,
            name: admin.name,
            email: admin.email,
            type: "user",
            status: "enabled",
            user_role_id: 1,
            password_login: true,
            password: target.admin.password,
          },
        }),
      );
      check(
        restored.type === "user" && restored.username === admin.username && !restored.password,
        "last-admin-reference-restored",
      );
    }
  }
  // 07: upstream takes both, which leaves nobody who can log in.
  if (target.mode !== "reference") {
    const needSuper =
      "User(s) couldn't be updated. There has to be at least one active Super Admin user.";
    const noLogin = await request(target, `/api/users/${admin.id}`, {
      method: "PUT",
      auth: basic,
      body: {
        username: admin.username,
        name: admin.name,
        email: admin.email,
        type: "user",
        status: "enabled",
        user_role_id: 1,
        password_login: false,
      },
    });
    check(noLogin.status === 400, "last-admin-password-login-off-refused");
    check(
      ((await noLogin.json()) as { message: string }).message === needSuper,
      "last-admin-password-login-off-message",
    );
    const placeholder = await request(target, "/api/users", {
      method: "POST",
      auth: basic,
      body: {
        username: "no-login-admin",
        name: "No Login",
        email: "no-login-admin@example.test",
        type: "user",
        status: "enabled",
        user_role_id: 1,
        password_login: false,
      },
    });
    const replacement = await user(placeholder);
    const disabled = await request(target, `/api/users/${admin.id}`, {
      method: "PUT",
      auth: basic,
      body: {
        username: admin.username,
        name: admin.name,
        email: admin.email,
        type: "user",
        status: "disabled",
        user_role_id: 1,
        password_login: true,
      },
    });
    check(disabled.status === 400, "last-admin-no-login-replacement-refused");
    const gone = await request(target, `/api/users/${replacement.id}`, {
      method: "DELETE",
      auth: basic,
    });
    check(gone.status === 200, "last-admin-no-login-replacement-removed");
  }
  const login = await form(target, target.admin.user, target.admin.password);
  check(login.response.status === 302 && !!login.session, "last-admin-password-login-preserved");
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
