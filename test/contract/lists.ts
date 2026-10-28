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
    check(minimal.status === 200, "list-minimal");
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
    const deleted = await request(`/api/lists?id=${second.id}`, "DELETE");
    check(deleted.status === 200, "list-delete-ids");
    owned.splice(owned.indexOf(second.id), 1);
    check((await request(`/api/lists/${second.id}`)).status === 400, "list-deleted");
  } finally {
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
