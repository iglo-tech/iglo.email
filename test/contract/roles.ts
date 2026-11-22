// Reference: listmonk cmd/roles.go and cmd/users.go at 6fcd95f.
import { createHmac, randomUUID } from "node:crypto";
import type { ErrorCode } from "@/server/error-codes";
import type { AuthTarget } from "@/test/contract/auth";
import { asBody } from "@/test/read-body";

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
    if (index < 0) {
      throw new Error("FAIL factor-secret-format");
    }
    bits += index.toString(2).padStart(5, "0");
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((v) => Number.parseInt(v, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[19]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7f_ff_ff_ff) % 1_000_000).padStart(6, "0");
}

function check(value: unknown, name: string): asserts value {
  if (!value) {
    throw new Error(`FAIL ${name}`);
  }
  process.stdout.write(`PASS ${name}\n`);
}

export async function runRolesContract(target: AuthTarget): Promise<void> {
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/.test(target.baseUrl)) {
    throw new Error("Invalid contract target");
  }
  const auth = `Basic ${Buffer.from(`${target.credentials.user}:${target.credentials.token}`).toString("base64")}`;
  const suffix = randomUUID().replaceAll("-", "");
  const owned: Array<number> = [];
  let human = 0;
  let realList = 0;
  let cleanupFailures = 0;
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
    const data = asBody<{ data: { id: number } }>(await response.json()).data;
    const row: Record<string, unknown> = data;
    const keys =
      kind === "users"
        ? ["created_at", "id", "lists", "name", "permissions", "type", "updated_at"]
        : ["created_at", "id", "lists", "name", "updated_at"];
    check(
      JSON.stringify(Object.keys(row).sort()) === JSON.stringify(keys) &&
        row.lists === null &&
        typeof row.created_at === "string" &&
        Number.isFinite(Date.parse(row.created_at)) &&
        row.updated_at === row.created_at &&
        (kind !== "users" || (row.type === "user" && Array.isArray(row.permissions))),
      `role-create-${kind}-projection`,
    );
    check(Number.isSafeInteger(data.id) && data.id > 1, `role-create-${kind}-id`);
    owned.push(data.id);
    return data.id;
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
    const listResource = await request("/api/lists", "POST", { name: `m14-owned-list-${suffix}` });
    check(listResource.status === 200, "role-real-list-create");
    realList = asBody<{ data: { id: number } }>(await listResource.json()).data.id;
    const grant = await request(`/api/roles/lists/${list}`, "PUT", {
      name: `m14-list-${suffix}`,
      lists: [{ id: realList, permissions: ["list:get"] }],
    });
    check(grant.status === 200, "role-real-list-grant");
    const grants = await request(`/api/roles/lists?query=m14-list-${suffix}`);
    const granted = asBody<{
      data: Array<{
        id: number;
        lists: Array<{ id: number; name: string; permissions: Array<string> }>;
      }>;
    }>(await grants.json()).data.find((item) => item.id === list);
    check(
      granted?.lists.some(
        (item) =>
          item.id === realList &&
          item.name === `m14-owned-list-${suffix}` &&
          item.permissions.includes("list:get"),
      ),
      "role-real-list-projection",
    );
    const clearGrant = await request(`/api/roles/lists/${list}`, "PUT", {
      name: `m14-list-${suffix}`,
      lists: [],
    });
    check(clearGrant.status === 200, "role-real-list-clear");
    const users = await request(`/api/roles/users?query=${suffix}`);
    const userRoles = asBody<{
      data: Array<{ id: number; name: string; type: string; permissions: Array<string> }>;
    }>(await users.json()).data;
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
    const listRoles = asBody<{ data: Array<{ id: number; name: string; lists: Array<unknown> }> }>(
      await lists.json(),
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
    const reference = target.mode === "reference";
    // The exact bytes of an error, with its trailing newline. An owned error carries its stable code
    // (B131, D129); the reference answers none, so its bytes are listmonk's.
    const errorBytes = (message: string, code: ErrorCode) =>
      `${JSON.stringify(reference ? { message } : { message, code })}\n`;
    check(
      (await invalid.text()) ===
        errorBytes(
          reference
            ? "Invalid fields: permission: unknown:permission"
            : "Invalid fields: permission",
          "invalid_fields",
        ),
      "D31-invalid-user-permission-message",
    );
    // User-role replacement requires an explicit array; list children retain
    // their separate upstream null/omitted-as-empty clearing contract.
    async function currentUserRole() {
      const response = await request(`/api/roles/users?query=${suffix}`);
      check(response.status === 200, "D32-user-role-read");
      const entries = asBody<{ data: Array<Record<string, unknown>> }>(await response.json()).data;
      return entries.find((entry) => entry.id === role);
    }
    for (const variant of ["omitted", "null"] as const) {
      const missing = variant === "null" ? { permissions: null } : {};
      const before = await currentUserRole();
      for (const method of ["POST", "PUT"] as const) {
        const name = `missing-${method}-${variant}-${suffix}`;
        const response = await request(
          method === "POST" ? "/api/roles/users" : `/api/roles/users/${role}`,
          method,
          { name, ...missing },
        );
        const body = asBody<{ message?: string; data?: { id: number } }>(await response.json());
        // Retain cleanup even if a regression unexpectedly creates a role.
        if (method === "POST" && response.status === 200 && body.data?.id) {
          owned.push(body.data.id);
        }
        check(response.status === (reference ? 500 : 400), `D32-${method}-${variant}-status`);
        check(
          reference
            ? typeof body.message === "string" &&
                body.message.startsWith(
                  method === "POST" ? "Error creating Role: " : "Error updating User role: ",
                ) &&
                body.message.includes('null value in column "permissions"')
            : body.message === "Invalid fields: permissions",
          `D32-${method}-${variant}-message`,
        );
        check(
          JSON.stringify(await currentUserRole()) === JSON.stringify(before),
          `D32-${method}-${variant}-grants-unchanged`,
        );
        const named = await request(`/api/roles/users?query=${name}`);
        check(
          asBody<{ data: Array<unknown> }>(await named.json()).data.length === 0,
          `D32-${method}-${variant}-name-not-written`,
        );
      }
    }
    const explicitEmpty = await request(`/api/roles/users/${role}`, "PUT", {
      name: `changed-${suffix}`,
      permissions: [],
    });
    check(
      explicitEmpty.status === 200 &&
        JSON.stringify((await currentUserRole())?.permissions) === "[]",
      "D32-explicit-empty-user-grants",
    );
    for (const variant of ["omitted", "null", "empty"] as const) {
      const child = {
        id: 2_147_483_647,
        ...(variant === "omitted" ? {} : { permissions: variant === "null" ? null : [] }),
      };
      const cleared = await create("lists", {
        name: `empty-child-${variant}-${suffix}`,
        lists: [child],
      });
      const replacement = await request(`/api/roles/lists/${list}`, "PUT", {
        name: `m14-list-${suffix}`,
        lists: [child],
      });
      check(replacement.status === 200, `list-child-${variant}-replacement`);
      const response = await request(`/api/roles/lists?query=${suffix}`);
      const entries = asBody<{ data: Array<{ id: number; lists: Array<unknown> }> }>(
        await response.json(),
      ).data;
      check(
        [list, cleared].every((id) =>
          entries.some((entry) => entry.id === id && entry.lists.length === 0),
        ),
        `list-child-${variant}-no-grant`,
      );
    }
    const invalidList = await request("/api/roles/lists", "POST", {
      name: `bad-${suffix}`,
      lists: [{ id: 123, permissions: ["unknown:permission"] }],
    });
    check(
      invalidList.status === 400 &&
        (await invalidList.text()) ===
          errorBytes(
            reference
              ? "Invalid fields: list permission: unknown:permission"
              : "Invalid fields: list permission",
            "invalid_fields",
          ),
      "D31-invalid-list-permission-message",
    );
    const duplicate = await request("/api/roles/users", "POST", {
      name: `changed-${suffix}`,
      permissions: [],
    });
    const duplicateMessage = reference
      ? `Error creating Role: pq: duplicate key value violates unique constraint "idx_roles_name" (23505). Key (type, name)=(user, changed-${suffix}) already exists.`
      : "Error creating Role";
    check(
      duplicate.status === 500 &&
        (await duplicate.text()) === errorBytes(duplicateMessage, "internal_error"),
      "D31-duplicate-role-message",
    );
    const childDetail =
      'pq: insert or update on table "roles" violates foreign key constraint "roles_list_id_fkey" (23503). Key (list_id)=(2147483647) is not present in table "lists".';
    const badChildCreate = await request("/api/roles/lists", "POST", {
      name: `bad-child-${suffix}`,
      lists: [{ id: 2_147_483_647, permissions: ["list:get"] }],
    });
    check(
      badChildCreate.status === 500 &&
        (await badChildCreate.text()) ===
          errorBytes(
            reference
              ? `Error creating Role: code=500, message=Error creating Role: ${childDetail}`
              : "Error creating Role",
            "internal_error",
          ),
      "D31-invalid-child-create-message",
    );
    const after = await request(`/api/roles/lists?query=bad-child-${suffix}`);
    const orphans = asBody<{ data: Array<{ id: number }> }>(await after.json()).data;
    check(orphans.length === (reference ? 1 : 0), "D30-invalid-child-create-atomicity");
    for (const r of orphans) {
      owned.push(r.id);
    }
    const ponies = await create("users", { name: `m14 ${suffix} Ponies`, permissions: [] });
    for (const [query, expected] of [
      ["pony", reference],
      [" PONIES ", true],
      [`  ${suffix}   Ponies  `, true],
      ["%", reference],
      ["_", reference],
      ["nothing-matches-m14", false],
    ] as const) {
      const response = await request(`/api/roles/users?query=${encodeURIComponent(query)}`);
      const matches = asBody<{ data: Array<{ id: number }> }>(await response.json()).data;
      check(
        matches.some((r) => r.id === ponies) === expected,
        `D31-search-${query === "%" ? "percent" : query === "_" ? "underscore" : query === "pony" ? "stemming" : query.includes(suffix) ? "whitespace" : query.includes("PONIES") ? "case" : "no-match"}`,
      );
    }
    const alpha = await create("users", { name: `sort-${suffix}-a`, permissions: [] });
    const zeta = await create("users", { name: `sort-${suffix}-z`, permissions: [] });
    for (const [order, expected] of [
      ["asc", [alpha, zeta]],
      ["desc", [zeta, alpha]],
      ["invalid", [zeta, alpha]],
    ] as const) {
      const sorted = await request(
        `/api/roles/users?query=sort-${suffix}&order_by=name&order=${order}`,
      );
      const ids = asBody<{ data: Array<{ id: number }> }>(await sorted.json()).data.map(
        (r) => r.id,
      );
      check(JSON.stringify(ids) === JSON.stringify(expected), `role-sort-${order}`);
    }
    for (const [query, expected] of [
      ["order_by=invalid&order=desc", [zeta, alpha]],
      ["order_by=invalid", [alpha, zeta]],
    ] as const) {
      const sorted = await request(`/api/roles/users?query=sort-${suffix}&${query}`);
      const ids = asBody<{ data: Array<{ id: number }> }>(await sorted.json()).data.map(
        (r) => r.id,
      );
      check(
        JSON.stringify(ids) === JSON.stringify(expected),
        `role-sort-default-${query.includes("desc") ? "desc" : "asc"}`,
      );
    }
    const trimmed = await request(`/api/roles/users/${alpha}`, "PUT", {
      name: `  sort-${suffix}-a  `,
      permissions: [],
    });
    check(
      trimmed.status === 200 &&
        asBody<{ data: { name: string } }>(await trimmed.json()).data.name === `sort-${suffix}-a`,
      "role-update-trim",
    );
    const longName = await request("/api/roles/users", "POST", {
      name: "é".repeat(1001),
      permissions: [],
    });
    check(longName.status === 400, "role-utf8-byte-length");
    for (const body of [{}, { name: "" }, { name: "invalid-permissions", permissions: [42] }]) {
      const rejected = await request("/api/roles/users", "POST", body);
      check(rejected.status === 400, "role-malformed-or-missing-fields");
    }
    for (const id of ["0", "-1", "not-an-id"]) {
      const rejected = await request(`/api/roles/users/${id}`, "PUT", {
        name: "Invalid ID",
        permissions: [],
      });
      check(rejected.status === 400, "role-invalid-id");
    }
    const overflow = await request("/api/roles/users/9223372036854775808", "PUT", {
      name: "Overflow",
      permissions: [],
    });
    check(overflow.status === (reference ? 500 : 400), "D17-role-overflow");
    const missing = await request("/api/roles/users/2147483647", "PUT", {
      name: "Missing",
      permissions: [],
    });
    check(
      missing.status === 500 &&
        (await missing.text()) ===
          errorBytes(
            reference
              ? "Error updating User role: sql: no rows in result set"
              : "Error updating User role",
            "internal_error",
          ),
      "D31-missing-role",
    );
    const primordial = await request("/api/roles/users/1", "PUT", {
      name: "ignored",
      permissions: [],
    });
    check(primordial.status === 400, "role-primordial-protected");
    const invalidChild = await request(`/api/roles/lists/${list}`, "PUT", {
      name: `changed-child-${suffix}`,
      lists: [{ id: 2_147_483_647, permissions: ["list:get"] }],
    });
    check(
      invalidChild.status === 500 &&
        (await invalidChild.text()) ===
          errorBytes(
            reference
              ? `Error creating List role: code=500, message=Error creating Role: ${childDetail}`
              : "Error creating List role",
            "internal_error",
          ),
      "D31-invalid-child-update-message",
    );
    const currentLists = await request("/api/roles/lists");
    const currentListRoles = asBody<{ data: Array<{ id: number; name: string }> }>(
      await currentLists.json(),
    ).data;
    check(
      currentListRoles.find((r) => r.id === list)?.name ===
        (target.mode === "reference" ? `changed-child-${suffix}` : `m14-list-${suffix}`),
      "D30-invalid-child-atomicity",
    );
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
    human = asBody<{ data: { id: number } }>(await created.json()).data.id;
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
    const factor = asBody<{ data: { secret: string; qr: string } }>(await provisioning.json()).data;
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
    const profileData = asBody<{ data: Record<string, unknown> }>(await profile.json()).data;
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
    const assignedRole = await create("lists", { name: `m14-assigned-${suffix}`, lists: [] });
    const assigned = await request(`/api/users/${human}`, "PUT", {
      username,
      name: username,
      email: `${username}@example.test`,
      type: "user",
      status: "enabled",
      password_login: true,
      user_role_id: 1,
      list_role_id: assignedRole,
    });
    check(assigned.status === 200, "role-list-assignment");
    const deletion = await request(`/api/roles/${assignedRole}`, "DELETE");
    check(
      deletion.status === (target.mode === "reference" ? 200 : 400),
      "D30-assigned-list-role-delete",
    );
    const afterDelete = await request(`/api/users/${human}`);
    if (target.mode === "reference") {
      owned.splice(owned.indexOf(assignedRole), 1);
      human = 0;
    }
    check(
      afterDelete.status === (target.mode === "reference" ? 404 : 200),
      "D30-assigned-list-role-user-preserved",
    );
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
      if (response.status !== 200) {
        cleanupFailures += 1;
      }
    }
    for (const id of owned.reverse()) {
      const response = await request(`/api/roles/${id}`, "DELETE");
      if (response.status !== 200) {
        cleanupFailures += 1;
      }
    }
    if (realList && (await request(`/api/lists/${realList}`, "DELETE")).status !== 200) {
      cleanupFailures += 1;
    }
  }
  if (cleanupFailures > 0) {
    throw new Error("FAIL role-cleanup");
  }
}

if (import.meta.main) {
  try {
    if (process.argv[2] !== "reference") {
      throw new Error("Invalid mode");
    }
    const {
      REFERENCE_URL: baseUrl,
      REFERENCE_API_USER: user,
      REFERENCE_API_TOKEN: token,
    } = process.env;
    if (!baseUrl || !user || !token) {
      throw new Error("Missing reference credentials");
    }
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
