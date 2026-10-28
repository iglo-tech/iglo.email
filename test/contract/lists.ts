// Reference: listmonk cmd/lists.go, internal/core/lists.go and queries/lists.sql at 6fcd95f.
import type { Credentials, Mode } from "@/test/contract/types";

export async function runListsContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
}) {
  const suffix = crypto.randomUUID();
  const owned: number[] = [];
  let cleanupFailed = false;
  const roles: number[] = [];
  const users: number[] = [];
  const auth = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const request = (path: string, method = "GET", body?: unknown, authorization = auth) =>
    fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  function check(condition: unknown, label: string): asserts condition {
    if (!condition) throw new Error(`FAIL ${label}`);
  }
  async function create(name: string, fields: Record<string, unknown> = {}) {
    const response = await request("/api/lists", "POST", { name, ...fields });
    const data = (await response.json()) as { data?: Record<string, any> };
    if (response.status === 200 && typeof data.data?.id === "number") owned.push(data.data.id);
    check(response.status === 200 && data.data, "list-create");
    return data.data;
  }
  async function search(query: string) {
    const response = await request(`/api/lists?query=${encodeURIComponent(query)}&status=`);
    check(response.status === 200, "list-search-status");
    return ((await response.json()) as { data: { results: Record<string, any>[] } }).data.results;
  }
  try {
    check(
      (await request("/api/lists", "GET", undefined, "")).status === 403,
      "list-unauthenticated",
    );
    const list = await create(`m15 ${suffix} Ponies`, {
      description: "description",
      tags: [" One Two ", "other"],
    });
    check(
      list.type === "private" && list.optin === "single" && list.status === "active",
      "list-defaults",
    );
    check(
      JSON.stringify(list.tags) === JSON.stringify(["One-Two", "other"]),
      "list-tags-normalized",
    );
    check(
      list.subscriber_count === 0 && JSON.stringify(list.subscriber_statuses) === "{}",
      "list-empty-counts",
    );
    check(
      typeof list.uuid === "string" &&
        typeof list.created_at === "string" &&
        typeof list.updated_at === "string",
      "list-identity-timestamps",
    );
    const read = await request(`/api/lists/${list.id}`);
    check(
      read.status === 200 &&
        ((await read.json()) as { data: { uuid: string } }).data.uuid === list.uuid,
      "list-read",
    );
    for (const [query, expected, label] of [
      ["pony", target.mode === "reference", "stemming"],
      ["%", target.mode === "reference", "percent"],
      ["_", target.mode === "reference", "underscore"],
      [`  ${suffix}   PONIES  `, true, "whitespace"],
    ] as const) {
      check(
        (await search(query)).some((item) => item.id === list.id) === expected,
        `D33-search-${label}`,
      );
    }
    const update = await request(`/api/lists/${list.id}`, "PUT", {
      name: list.name,
      description: "",
    });
    check(update.status === 200, "list-update");
    const changed = ((await update.json()) as { data: Record<string, unknown> }).data;
    check(
      changed.description === (target.mode === "reference" ? "description" : ""),
      "D33-description-clear",
    );
    check(JSON.stringify(changed.tags) === "[]", "list-omitted-tags-clear");
    const missing = await request("/api/lists/2147483647");
    check(missing.status === 400, "list-missing-get");
    for (const [field, value] of [
      ["type", "wrong"],
      ["optin", "wrong"],
      ["status", "wrong"],
    ] as const) {
      check(
        (await request(`/api/lists?${field}=${value}`)).status === 400,
        `list-invalid-${field}`,
      );
    }
    const minimal = await request(`/api/lists?minimal=true&status=archived`);
    check(
      minimal.status === 200 &&
        JSON.stringify(((await minimal.json()) as { data: unknown }).data) === "[]",
      "list-minimal-empty",
    );
    const second = await create(`m15 ${suffix} other`, {
      type: "public",
      optin: "double",
      status: "archived",
      tags: ["one", "two"],
    });
    const filtered = await request(`/api/lists?query=${suffix}&status=archived&tag=one&tag=two`);
    const result = (
      (await filtered.json()) as { data: { results: { id: number }[]; total: number } }
    ).data;
    check(
      filtered.status === 200 && result.total === 1 && result.results[0]?.id === second.id,
      "list-filters",
    );
    const emptyMinimal = await request(`/api/lists?minimal=true&status=archived`, "GET");
    const minimalData = (
      (await emptyMinimal.json()) as { data: { results: Record<string, unknown>[]; total: number } }
    ).data;
    check(
      minimalData.results.some(
        (entry) =>
          entry.id === second.id &&
          entry.subscriber_statuses === null &&
          entry.subscriber_count === 0,
      ),
      "list-minimal-projection",
    );
    for (const [param, page, perPage] of [
      ["", 1, 20],
      ["page=0&per_page=invalid", 1, 20],
      ["per_page=100", 1, 100],
      ["per_page=all", 1, 0],
      ["page=999", 999, 20],
    ] as const) {
      const response = await request(`/api/lists?query=${suffix}&${param}`);
      const pageData = (
        (await response.json()) as {
          data: { page: number; per_page: number; total: number; results: unknown[] };
        }
      ).data;
      check(
        response.status === 200 &&
          pageData.page === page &&
          pageData.per_page === perPage &&
          (page !== 999 || (pageData.total === 0 && pageData.results.length === 0)),
        `list-page-${page}-${perPage}`,
      );
    }
    for (const tags of [null, [], undefined]) {
      const filled = await request(`/api/lists/${list.id}`, "PUT", {
        name: list.name,
        description: "kept",
        tags: ["retain"],
      });
      check(filled.status === 200, "list-tag-setup");
      const replacement = await request(`/api/lists/${list.id}`, "PUT", {
        name: list.name,
        ...(tags === undefined ? {} : { tags }),
        description: null,
      });
      const replacementData = (
        (await replacement.json()) as { data: { tags: string[]; description: string } }
      ).data;
      check(
        replacement.status === 200 &&
          JSON.stringify(replacementData.tags) === "[]" &&
          replacementData.description === "kept",
        `list-tag-replace-${tags === null ? "null" : tags === undefined ? "omitted" : "empty"}`,
      );
    }
    check(
      (await request("/api/lists", "POST", { name: "é".repeat(1001) })).status === 400,
      "list-utf8-length",
    );
    check(
      (await request("/api/lists/2147483647", "PUT", { name: "missing" })).status === 400,
      "list-missing-update",
    );
    check((await request("/api/lists/2147483647", "DELETE")).status === 200, "list-missing-delete");
    check((await request("/api/lists", "DELETE")).status === 400, "list-empty-delete");
    check((await request("/api/lists?id=bad", "DELETE")).status === 400, "list-invalid-delete-id");
    const userRoleResponse = await request("/api/roles/users", "POST", {
      name: `m15-user-${suffix}`,
      permissions: [],
    });
    check(userRoleResponse.status === 200, "list-create-user-role");
    const userRole = ((await userRoleResponse.json()) as { data: { id: number } }).data.id;
    roles.push(userRole);
    const listRoleResponse = await request("/api/roles/lists", "POST", {
      name: `m15-list-${suffix}`,
      lists: [{ id: list.id, permissions: ["list:get"] }],
    });
    check(listRoleResponse.status === 200, "list-create-list-role");
    const listRole = ((await listRoleResponse.json()) as { data: { id: number } }).data.id;
    roles.push(listRole);
    const limitedResponse = await request("/api/users", "POST", {
      username: `m15-${suffix}`,
      type: "api",
      status: "enabled",
      user_role_id: userRole,
      list_role_id: listRole,
    });
    check(limitedResponse.status === 200, "list-create-limited-user");
    const limited = (
      (await limitedResponse.json()) as { data: { id: number; username: string; password: string } }
    ).data;
    users.push(limited.id);
    const limitedAuth = `Basic ${btoa(`${limited.username}:${limited.password}`)}`;
    check(
      (await request(`/api/lists/${list.id}`, "GET", undefined, limitedAuth)).status === 200,
      "list-granted-read",
    );
    check(
      (await request(`/api/lists/${second.id}`, "GET", undefined, limitedAuth)).status === 403,
      "list-denied-read",
    );
    check(
      (await request(`/api/lists/${list.id}`, "PUT", { name: list.name }, limitedAuth)).status ===
        403,
      "list-denied-write",
    );
    check(
      (await request("/api/lists", "POST", { name: `m15-denied-${suffix}` }, limitedAuth))
        .status === 403,
      "list-denied-create",
    );
    const visible = await request(
      `/api/lists?query=${suffix}&per_page=all`,
      "GET",
      undefined,
      limitedAuth,
    );
    const visibleData = (
      (await visible.json()) as { data: { total: number; results: { id: number }[] } }
    ).data;
    check(
      visibleData.total === 1 &&
        visibleData.results.length === 1 &&
        visibleData.results[0]?.id === list.id,
      "list-scoped-collection",
    );
    const minimalVisible = await request("/api/lists?minimal=true", "GET", undefined, limitedAuth);
    const minimalVisibleData = (
      (await minimalVisible.json()) as { data: { total: number; results: { id: number }[] } }
    ).data;
    check(
      minimalVisibleData.total === 1 && minimalVisibleData.results[0]?.id === list.id,
      "list-scoped-minimal",
    );
    const grantManage = await request(`/api/roles/lists/${listRole}`, "PUT", {
      name: `m15-list-${suffix}`,
      lists: [{ id: list.id, permissions: ["list:manage"] }],
    });
    check(grantManage.status === 200, "list-change-grant");
    check(
      (await request(`/api/lists/${list.id}`, "GET", undefined, limitedAuth)).status === 403,
      "list-revoked-read",
    );
    check(
      (await request(`/api/lists/${list.id}`, "PUT", { name: list.name }, limitedAuth)).status ===
        200,
      "list-granted-write",
    );
    check(
      (await request(`/api/lists?id=${list.id}&id=${second.id}`, "DELETE", undefined, limitedAuth))
        .status === 403,
      "list-bulk-all-or-nothing",
    );
    check(
      (await request(`/api/lists/${list.id}`)).status === 200 &&
        (await request(`/api/lists/${second.id}`)).status === 200,
      "list-bulk-denied-unchanged",
    );
    const managedTarget = await create(`m15 managed ${suffix}`, { tags: [`managed-${suffix}`] });
    const manageTwo = await request(`/api/roles/lists/${listRole}`, "PUT", {
      name: `m15-list-${suffix}`,
      lists: [
        { id: list.id, permissions: ["list:manage"] },
        { id: managedTarget.id, permissions: ["list:manage"] },
      ],
    });
    check(manageTwo.status === 200, "list-bulk-manage-grant");
    const bulk = await request(
      `/api/lists?all=true&tag=managed-${suffix}`,
      "DELETE",
      undefined,
      limitedAuth,
    );
    check(
      bulk.status === 200 &&
        (await request(`/api/lists/${managedTarget.id}`)).status === 400 &&
        (await request(`/api/lists/${list.id}`)).status === 200 &&
        (await request(`/api/lists/${second.id}`)).status === 200,
      "list-bulk-scoped-filter",
    );
    owned.splice(owned.indexOf(managedTarget.id), 1);
    const grantNothing = await request(`/api/roles/lists/${listRole}`, "PUT", {
      name: `m15-list-${suffix}`,
      lists: [],
    });
    check(
      grantNothing.status === 200 &&
        (await request(`/api/lists/${list.id}`, "DELETE", undefined, limitedAuth)).status === 403,
      "list-revoked-write",
    );
    const deletionTarget = await create(`m15 ${suffix} Ponies`, { tags: [`m15-${suffix}`] });
    const selection = await request(`/api/lists?query=pony&tag=m15-${suffix}`);
    const selected = (
      (await selection.json()) as { data: { results: { id: number }[] } }
    ).data.results.some((entry) => entry.id === deletionTarget.id);
    check(selected === (target.mode === "reference"), "D33-delete-preview-stemming");
    const deleteQuery = await request(`/api/lists?query=pony&tag=m15-${suffix}`, "DELETE");
    check(deleteQuery.status === 200, "D33-delete-query");
    const afterQuery = await request(`/api/lists/${deletionTarget.id}`);
    check(
      afterQuery.status === (target.mode === "reference" ? 400 : 200),
      "D33-delete-matches-preview",
    );
    if (target.mode === "reference") owned.splice(owned.indexOf(deletionTarget.id), 1);
    const deleted = await request(`/api/lists?id=${second.id}`, "DELETE");
    check(deleted.status === 200, "list-delete-ids");
    owned.splice(owned.indexOf(second.id), 1);
    check((await request(`/api/lists/${second.id}`)).status === 400, "list-deleted");
  } finally {
    for (const id of users.reverse())
      if ((await request(`/api/users/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    for (const id of roles.reverse())
      if ((await request(`/api/roles/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    for (const id of owned.reverse())
      if ((await request(`/api/lists/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
  }
  if (cleanupFailed) throw new Error("FAIL list-cleanup");
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
    await runListsContract({ mode: "reference", baseUrl, credentials: { user, token } });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-]+$/.test(error.message) ? error.message : "Lists contract failed"}\n`,
    );
    process.exitCode = 1;
  }
}
