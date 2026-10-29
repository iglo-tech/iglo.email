// Reference: listmonk cmd/subscribers.go (QuerySubscribers, ExportSubscribers, *ByQuery),
// internal/core/subscribers.go and queries/subscribers.sql at 6fcd95f.
// Cases labelled query-diff-* record declared M1.7 differences: each asserts the pinned
// reference result in reference mode and the iglo.email result in normal mode.
import type { Credentials, Mode } from "@/test/contract/types";

export async function runSubscriberQuery(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
}) {
  const normal = target.mode === "normal";
  const tag = `q${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const basic = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const resources: { kind: string; id: number }[] = [];
  let cleanupFailed = false;
  function check(value: unknown, label: string): asserts value {
    if (!value) throw new Error(`FAIL ${label}`);
  }
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = { Authorization: basic },
  ) =>
    fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (
    path: string,
    method = "GET",
    body?: unknown,
    headers?: Record<string, string>,
  ) => {
    const response = await request(path, method, body, headers);
    return { status: response.status, body: (await response.json()) as any };
  };
  async function create(path: string, kind: string, data: unknown) {
    const response = await json(path, "POST", data);
    if (response.status === 200 && typeof response.body.data?.id === "number")
      resources.push({ kind, id: response.body.data.id });
    check(response.status === 200, `subscriber-query-setup-${kind}`);
    return response.body.data;
  }
  const q = encodeURIComponent;
  const names = (body: any) =>
    ((body.data?.results ?? []) as { email: string }[]).map((row) => row.email.split("-")[0]);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  try {
    const listA = (await create("/api/lists", "lists", { name: `qa-${tag}`, optin: "single" })).id;
    const listB = (await create("/api/lists", "lists", { name: `qb-${tag}`, optin: "single" })).id;
    const alice = await create("/api/subscribers", "subscribers", {
      email: `alice-${tag}@example.test`,
      name: `Alice ${tag}`,
      lists: [listA],
      attribs: { city: "Bengaluru", zz: 1, a: { y: 2, b: 1 } },
      preconfirm_subscriptions: true,
    });
    const bob = await create("/api/subscribers", "subscribers", {
      email: `bob-${tag}@example.test`,
      name: `Bob, "${tag}"`,
      lists: [listA, listB],
    });
    const carol = await create("/api/subscribers", "subscribers", {
      email: `carol-${tag}@example.test`,
      name: `Carol ${tag}`,
      status: "disabled",
    });

    // Envelope, default order and paging.
    let r = await json(`/api/subscribers?search=${tag}&per_page=2`);
    check(
      r.status === 200 &&
        same(Object.keys(r.body.data), ["results", "search", "query", "total", "per_page", "page"]),
      "subscriber-query-envelope",
    );
    check(same(names(r.body), ["carol", "bob"]), "subscriber-query-default-order");
    check(
      r.body.data.total === 3 && r.body.data.per_page === 2 && r.body.data.page === 1,
      "subscriber-query-page-props",
    );
    r = await json(`/api/subscribers?search=${tag}&per_page=2&page=2`);
    check(same(names(r.body), ["alice"]), "subscriber-query-page-2");
    r = await json(`/api/subscribers?search=${tag}&per_page=all`);
    check(r.body.data.per_page === 0 && r.body.data.results.length === 3, "subscriber-query-all");
    r = await json(`/api/subscribers?search=${tag}&per_page=-5&page=-1`);
    check(r.body.data.per_page === 0 && r.body.data.page === 1, "subscriber-query-negative-paging");
    r = await json(`/api/subscribers?search=${tag}&per_page=abc&page=3`);
    check(
      r.body.data.results === null && r.body.data.total === 3 && r.body.data.per_page === 20,
      "subscriber-query-page-beyond-null",
    );
    r = await json(`/api/subscribers?search=none${tag}`);
    check(same(r.body.data.results, []) && r.body.data.total === 0, "subscriber-query-empty");
    check(r.body.data.search === `none${tag}` && r.body.data.query === "", "subscriber-query-echo");

    // Ordering.
    r = await json(`/api/subscribers?search=${tag}&order_by=name&order=asc`);
    check(same(names(r.body), ["alice", "bob", "carol"]), "subscriber-query-order-name");
    r = await json(`/api/subscribers?search=${tag}&order_by=email&order=ASC`);
    check(same(names(r.body), ["carol", "bob", "alice"]), "subscriber-query-order-case");
    r = await json(`/api/subscribers?search=${tag}&order_by=${q("name; select 1")}&order=asc`);
    check(same(names(r.body), ["alice", "bob", "carol"]), "subscriber-query-order-allowlist");

    // Search.
    for (const [search, expected, label] of [
      [`alice-${tag}@example.test`, ["alice"], "email"],
      [`ALICE-${tag.toUpperCase()}@EXAMPLE.TEST`, ["alice"], "email-case"],
      [`  Alice ${tag}  `, ["alice"], "words-trimmed"],
      [`Bob, "${tag}"`, ["bob"], "punctuation"],
      [`${tag}@example`, ["carol", "bob", "alice"], "domain-prefix"],
    ] as const) {
      r = await json(`/api/subscribers?search=${q(search)}`);
      check(same(names(r.body), expected), `subscriber-query-search-${label}`);
    }
    r = await json(`/api/subscribers?search=${q(`lice-${tag}`)}`);
    check(same(names(r.body), normal ? [] : ["alice"]), "query-diff-search-word-start");

    // Filters.
    r = await json(`/api/subscribers?search=${tag}&list_id=${listA}`);
    check(same(names(r.body), ["bob", "alice"]), "subscriber-query-list");
    r = await json(`/api/subscribers?search=${tag}&list_id=${listA}&list_id=${listB}`);
    check(r.body.data.total === 2, "subscriber-query-lists-distinct");
    r = await json(`/api/subscribers?search=${tag}&subscription_status=confirmed`);
    check(same(names(r.body), ["alice"]), "subscriber-query-subscription-status");
    r = await json(`/api/subscribers?search=${tag}&subscription_status=none`);
    check(same(names(r.body), ["carol"]), "subscriber-query-orphans");
    r = await json(`/api/subscribers?search=${tag}&status=disabled`);
    check(same(names(r.body), ["carol"]), "subscriber-query-status");
    r = await json(`/api/subscribers?list_id=${listA}&list_id=abc`);
    check(
      r.status === 400 && same(r.body, { message: "Invalid ID(s)" }),
      "subscriber-query-invalid-list",
    );
    r = await json(`/api/subscribers?search=${tag}&status=bogus`);
    check(
      r.status === 400 && r.body.message.startsWith("Error preparing subscriber query: "),
      "subscriber-query-invalid-status",
    );

    // Raw SQL.
    r = await json(
      `/api/subscribers?search=${tag}&query=${q("  subscribers.attribs->>'city' = 'Bengaluru';  ")}`,
    );
    check(
      same(names(r.body), ["alice"]) &&
        r.body.data.query === "subscribers.attribs->>'city' = 'Bengaluru'",
      "subscriber-query-sql",
    );
    r = await json(
      `/api/subscribers?list_id=${listA}&query=${q("subscriber_lists.status = 'confirmed'")}`,
    );
    check(same(names(r.body), ["alice"]), "subscriber-query-sql-joined");
    r = await json(
      `/api/subscribers?search=${tag}&query=${q("subscriber_lists.status = 'confirmed'")}`,
    );
    check(r.status === 200 && r.body.data.total === 0, "subscriber-query-sql-unjoined");
    r = await json(`/api/subscribers?query=${q("subscribers.id IN (SELECT id FROM users)")}`);
    check(
      r.status === 400 &&
        same(r.body, { message: "Error preparing subscriber query: table 'users' is not allowed" }),
      "subscriber-query-sql-table",
    );
    for (const [fragment, label] of [
      ["subscribers.id = 1; DELETE FROM subscribers", "statements"],
      ["1=1 -- comment", "comment"],
      ["syntax error here", "syntax"],
    ] as const) {
      r = await json(`/api/subscribers?query=${q(fragment)}`);
      check(
        r.status === 400 && r.body.message.startsWith("Error preparing subscriber query: "),
        `subscriber-query-sql-${label}`,
      );
    }
    r = await json(`/api/subscribers?search=${tag}&query=${q("1=1) OR (1=1")}`);
    check(normal ? r.status === 400 : r.status === 200, "query-diff-sql-parentheses");
    check(
      (await json(`/api/subscribers?search=${tag}`)).body.data.total === 3,
      "subscriber-query-sql-no-write",
    );

    // Permissions.
    const reader = await create("/api/roles/users", "roles", {
      name: `query-reader-${tag}`,
      permissions: ["subscribers:get_all"],
    });
    const readerUser = await create("/api/users", "users", {
      username: `query-reader-${tag}`,
      type: "api",
      status: "enabled",
      user_role_id: reader.id,
    });
    const readerAuth = {
      Authorization: `Basic ${btoa(`${readerUser.username}:${readerUser.password}`)}`,
    };
    r = await json(`/api/subscribers?search=${tag}`, "GET", undefined, readerAuth);
    check(r.status === 200 && r.body.data.total === 3, "subscriber-query-get-all");
    r = await json(`/api/subscribers?query=${q("1=1")}`, "GET", undefined, readerAuth);
    check(
      r.status === 403 && same(r.body, { message: "Permission denied: subscribers:sql_query" }),
      "subscriber-query-sql-permission",
    );
    const scopedRole = await create("/api/roles/users", "roles", {
      name: `query-scoped-${tag}`,
      permissions: ["subscribers:get", "subscribers:manage"],
    });
    const scopedLists = await create("/api/roles/lists", "roles", {
      name: `query-scoped-lists-${tag}`,
      lists: [{ id: listA, permissions: ["list:get", "list:manage"] }],
    });
    const scopedUser = await create("/api/users", "users", {
      username: `query-scoped-${tag}`,
      type: "api",
      status: "enabled",
      user_role_id: scopedRole.id,
      list_role_id: scopedLists.id,
    });
    const scoped = {
      Authorization: `Basic ${btoa(`${scopedUser.username}:${scopedUser.password}`)}`,
    };
    r = await json(`/api/subscribers?per_page=all`, "GET", undefined, scoped);
    const masked = r.body.data.results
      ?.find((row: any) => row.id === bob.id)
      ?.lists.find((list: any) => list.id === listB);
    check(
      same(names(r.body), ["bob", "alice"]) &&
        masked?.name === "*Unknown" &&
        masked?.restricted === true &&
        !("description" in masked),
      "subscriber-query-scoped",
    );
    r = await json(`/api/subscribers?list_id=${listB}`, "GET", undefined, scoped);
    check(r.body.data.total === 0, "subscriber-query-scoped-list");

    // Export.
    const exported = await request(`/api/subscribers/export?search=${tag}`, "GET", undefined, {
      Authorization: basic,
      "Accept-Encoding": "identity",
    });
    const lines = (await exported.text()).split("\n");
    check(
      exported.status === 200 &&
        exported.headers.get("content-type") === "text/csv" &&
        exported.headers.get("content-disposition") === "attachment; filename=subscribers.csv" &&
        exported.headers.get("cache-control") === "no-cache" &&
        exported.headers.get("content-transfer-encoding") === "binary",
      "subscriber-export-headers",
    );
    const time = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)? \+0000 UTC$/;
    const first = lines[1]!.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    check(
      lines[0] === "uuid,email,name,attributes,status,created_at,updated_at" &&
        lines.length === 5 &&
        lines[4] === "" &&
        first[0] === alice.uuid &&
        first[1] === alice.email &&
        first[3] === '"{""a"": {""b"": 1, ""y"": 2}, ""zz"": 1, ""city"": ""Bengaluru""}"' &&
        first[4] === "enabled" &&
        time.test(first[5]!) &&
        time.test(first[6]!) &&
        lines[2]!.includes(`,"Bob, ""${tag}""",`) &&
        lines[3]!.startsWith(`${carol.uuid},`),
      "subscriber-export-csv",
    );
    check(
      lines[2]!.includes(normal ? ",{},enabled," : ",null,enabled,"),
      "query-diff-export-empty-attributes",
    );
    const zipped = await request(`/api/subscribers/export?search=${tag}`, "GET", undefined, {
      Authorization: basic,
      "Accept-Encoding": "gzip",
    });
    check(
      zipped.headers.get("content-encoding") === "gzip" &&
        zipped.headers.get("vary") === "Accept-Encoding" &&
        (await zipped.text()).startsWith("uuid,"),
      "subscriber-export-gzip",
    );
    const byID = await request(`/api/subscribers/export?id=${bob.id}&id=${carol.id}`);
    check((await byID.text()).split("\n").length === 4, "subscriber-export-ids");
    const byList = await request(`/api/subscribers/export?list_id=${listB}`);
    check((await byList.text()).split("\n").length === 3, "subscriber-export-list");
    const byQuery = await request(
      `/api/subscribers/export?query=${q(`subscribers.email = '${carol.email}'`)}`,
    );
    check((await byQuery.text()).split("\n").length === 3, "subscriber-export-query");
    r = await json(`/api/subscribers/export?id=1&id=x`);
    check(
      r.status === 400 && same(r.body, { message: "Invalid ID(s)" }),
      "subscriber-export-invalid",
    );
    r = await json(`/api/subscribers/export?query=${q("1=1")}`, "GET", undefined, readerAuth);
    check(r.status === 403, "subscriber-export-sql-permission");

    // Query-selected actions.
    for (const [path, method, body, status, message, label] of [
      [
        "/api/subscribers/query/lists",
        "PUT",
        { search: tag, action: "add" },
        400,
        "No lists given.",
        "no-lists",
      ],
      [
        "/api/subscribers/query/lists",
        "PUT",
        { action: "add", target_list_ids: [listB] },
        400,
        "Invalid fields: query",
        "no-query",
      ],
      [
        "/api/subscribers/query/lists",
        "PUT",
        { search: tag, action: "bogus", target_list_ids: [listB] },
        400,
        "Invalid action.",
        "action",
      ],
      [
        "/api/subscribers/query/lists",
        "PUT",
        { search: tag, action: "add", target_list_ids: [listB], status: "bogus" },
        400,
        "Invalid fields: status",
        "status",
      ],
      ["/api/subscribers/query/delete", "POST", {}, 400, "Invalid fields: query", "delete-empty"],
      [
        "/api/subscribers/query/blocklist",
        "PUT",
        {},
        400,
        "Invalid fields: query",
        "blocklist-empty",
      ],
    ] as const) {
      r = await json(path, method, body);
      check(r.status === status && r.body.message === message, `subscriber-bulk-validate-${label}`);
    }
    r = await json("/api/subscribers/query/lists", "PUT", {
      search: tag,
      action: "add",
      target_list_ids: [listB, 2147483000],
    });
    check(
      r.status === 500 && r.body.message.startsWith("Error updating Subscribers: "),
      "subscriber-bulk-fk",
    );
    r = await json(`/api/subscribers?list_id=${listB}`);
    check(r.body.data.total === 1, "subscriber-bulk-fk-atomic");
    r = await json("/api/subscribers/query/lists", "PUT", {
      search: tag,
      action: "add",
      target_list_ids: [listB],
      status: "confirmed",
    });
    check(same(r.body, { data: true }), "subscriber-bulk-add");
    r = await json(
      `/api/subscribers?list_id=${listB}&subscription_status=confirmed&order_by=email&order=asc`,
    );
    check(same(names(r.body), ["alice", "carol"]), "subscriber-bulk-add-keeps-existing");
    await json("/api/subscribers/query/lists", "PUT", {
      query: `subscribers.email = '${carol.email}'`,
      action: "unsubscribe",
      target_list_ids: [listB],
    });
    r = await json(`/api/subscribers?list_id=${listB}&subscription_status=unsubscribed`);
    check(same(names(r.body), ["carol"]), "subscriber-bulk-unsubscribe");
    await json("/api/subscribers/query/lists", "PUT", {
      search: carol.email,
      action: "remove",
      target_list_ids: [listB],
    });
    r = await json(`/api/subscribers?search=${tag}&subscription_status=none`);
    check(same(names(r.body), ["carol"]), "subscriber-bulk-remove");
    r = await json("/api/subscribers/query/blocklist", "PUT", { search: bob.email });
    const blocked = (await json(`/api/subscribers/${bob.id}`)).body.data;
    check(
      same(r.body, { data: true }) &&
        blocked.status === "blocklisted" &&
        blocked.lists.every((l: any) => l.subscription_status === "unsubscribed"),
      "subscriber-bulk-blocklist",
    );
    // A list-scoped manager's all:true selects only subscribers in its lists.
    r = await json("/api/subscribers/query/delete", "POST", { all: true }, scoped);
    check(same(r.body, { data: true }), "subscriber-bulk-scoped-delete");
    r = await json(`/api/subscribers?search=${tag}`);
    check(same(names(r.body), ["carol"]), "subscriber-bulk-scoped-delete-scope");
    for (const sub of [alice, bob])
      resources.splice(
        resources.findIndex((x) => x.kind === "subscribers" && x.id === sub.id),
        1,
      );
    r = await json("/api/subscribers/query/delete", "POST", {
      query: `subscribers.email = '${carol.email}'`,
    });
    check(
      same(r.body, { data: true }) && (await json(`/api/subscribers/${carol.id}`)).status === 400,
      "subscriber-bulk-delete",
    );
    resources.splice(
      resources.findIndex((x) => x.kind === "subscribers" && x.id === carol.id),
      1,
    );

    if (normal) {
      // A raw query that never finishes is stopped at the production limit. SQLite only
      // evaluates the fragment for an existing row.
      await create("/api/subscribers", "subscribers", { email: `timeout-${tag}@example.test` });
      const started = performance.now();
      r = await json(
        `/api/subscribers?query=${q("(WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c) > 0")}`,
      );
      check(
        r.status === 500 &&
          r.body.message === "Error fetching Subscribers: query timed out" &&
          performance.now() - started < 20_000,
        "subscriber-query-timeout",
      );
    }
  } finally {
    for (const { kind, id } of resources.reverse())
      if ((await request(`/api/${kind}/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
  }
  if (cleanupFailed) throw new Error("FAIL subscriber-query-cleanup");
}
