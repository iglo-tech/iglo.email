// Reference: listmonk cmd/subscribers.go, internal/core/subscribers.go,
// internal/core/subscriptions.go and queries/subscribers.sql at 6fcd95f.
import type { Credentials, Mode } from "@/test/contract/types";

export async function runSubscribersContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
}) {
  const suffix = crypto.randomUUID();
  const subscribers: number[] = [];
  const lists: number[] = [];
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
  async function createList(name: string) {
    const response = await request("/api/lists", "POST", { name, optin: "single" });
    const data = (await response.json()).data;
    check(response.status === 200 && typeof data?.id === "number", "subscriber-list-create");
    lists.push(data.id);
    return data.id as number;
  }
  async function create(body: Record<string, unknown>) {
    const response = await request("/api/subscribers", "POST", body);
    const data = (await response.json()).data;
    if (response.status === 200 && typeof data?.id === "number") subscribers.push(data.id);
    check(response.status === 200 && typeof data?.id === "number", "subscriber-create");
    return data;
  }
  async function get(id: number) {
    const response = await request(`/api/subscribers/${id}`);
    check(response.status === 200, "subscriber-get");
    return (await response.json()).data;
  }
  try {
    check(
      (await request("/api/subscribers/1", "GET", undefined, "")).status === 403,
      "subscriber-unauthenticated",
    );
    const list = await createList(`subscriber-${suffix}`);
    const secondList = await createList(`subscriber-second-${suffix}`);
    const email = `first.last-${suffix}@example.test`;
    const sub = await create({
      email: `  ${email.toUpperCase()}  `,
      lists: [list],
      attribs: { nested: { n: 1 }, array: [true, null] },
      preconfirm_subscriptions: true,
    });
    check(
      sub.email === email && sub.name.startsWith("First Last-") && sub.status === "enabled",
      "subscriber-sanitize-defaults",
    );
    check(
      sub.lists.length === 1 &&
        sub.lists[0].id === list &&
        sub.lists[0].subscription_status === "confirmed",
      "subscriber-create-membership",
    );
    check(sub.attribs.nested.n === 1 && sub.attribs.array[1] === null, "subscriber-attribs");
    check(
      (await request("/api/subscribers", "POST", { email })).status === 409,
      "subscriber-duplicate-email",
    );
    check(
      (await request("/api/subscribers", "POST", { email: "invalid" })).status === 400,
      "subscriber-invalid-email",
    );
    check(
      (
        await request("/api/subscribers", "POST", {
          email: `bad-${suffix}@example.test`,
          status: "unknown",
        })
      ).status === 400,
      "subscriber-invalid-status",
    );
    const before = await get(sub.id);
    check(before.uuid === sub.uuid && before.email === sub.email, "subscriber-read-identity");
    let response = await request(`/api/subscribers/${sub.id}`, "PATCH", {
      name: "Changed",
      attribs: { replacement: 2 },
    });
    check(response.status === 200, "subscriber-patch");
    let value = (await response.json()).data;
    check(
      value.name === "Changed" &&
        value.email === email &&
        value.attribs.replacement === 2 &&
        value.attribs.nested.n === 1 &&
        value.lists.length === 1,
      "subscriber-patch-replacement",
    );
    response = await request(`/api/subscribers/${sub.id}`, "PATCH", {
      lists: [list, secondList],
      preconfirm_subscriptions: true,
    });
    check(response.status === 200, "subscriber-patch-lists");
    value = (await response.json()).data;
    check(
      value.lists.length === 2 &&
        value.lists.every((l: any) => l.subscription_status === "confirmed"),
      "subscriber-patch-confirmed",
    );
    response = await request(`/api/subscribers/lists/${sub.id}`, "PUT", {
      action: "unsubscribe",
      target_list_ids: [list],
    });
    // D38: the path is sufficient in production; pinned upstream requires redundant ids.
    check(
      response.status === (target.mode === "reference" ? 400 : 200),
      "D38-membership-path-no-ids",
    );
    response = await request(`/api/subscribers/lists/${sub.id}`, "PUT", {
      ids: [sub.id],
      action: "unsubscribe",
      target_list_ids: [list],
    });
    check(response.status === 200, "subscriber-unsubscribe");
    value = await get(sub.id);
    check(
      value.lists.find((l: any) => l.id === list)?.subscription_status === "unsubscribed",
      "subscriber-unsubscribed",
    );
    response = await request(`/api/subscribers/${sub.id}`, "PATCH", {
      lists: [list, secondList],
      preconfirm_subscriptions: true,
    });
    check(response.status === 200, "subscriber-patch-after-unsubscribe");
    value = (await response.json()).data;
    check(
      value.lists.find((l: any) => l.id === list)?.subscription_status === "unsubscribed",
      "subscriber-unsubscribe-preserved",
    );
    response = await request(`/api/subscribers/${sub.id}/blocklist`, "PUT");
    check(response.status === 200, "subscriber-blocklist");
    value = await get(sub.id);
    check(
      value.status === "blocklisted" &&
        value.lists.every((l: any) => l.subscription_status === "unsubscribed"),
      "subscriber-blocklist-memberships",
    );
    response = await request(`/api/subscribers/${sub.id}`, "PATCH", {
      status: "enabled",
      lists: [list, secondList],
    });
    check(response.status === 200, "subscriber-reenable");
    value = (await response.json()).data;
    check(
      value.status === "enabled" &&
        value.lists.every((l: any) => l.subscription_status === "unsubscribed"),
      "subscriber-reenable-retains-consent",
    );
    check(
      (
        await request("/api/subscribers/lists", "PUT", {
          action: "remove",
          target_list_ids: [list],
        })
      ).status === 400,
      "subscriber-bulk-ids-required",
    );
    check(
      (await request("/api/subscribers/blocklist", "PUT", { ids: [] })).status === 400,
      "subscriber-blocklist-ids-required",
    );
    check(
      (await request("/api/subscribers", "DELETE")).status === 400,
      "subscriber-delete-ids-required",
    );
    check(
      (await request(`/api/subscribers?id=${sub.id}&id=invalid`, "DELETE")).status === 400,
      "subscriber-delete-invalid-atomic",
    );
    check((await get(sub.id)).uuid === sub.uuid, "subscriber-delete-invalid-keeps-row");
    check(
      (await request(`/api/subscribers?id=${sub.id}`, "DELETE")).status === 200,
      "subscriber-delete",
    );
    subscribers.splice(subscribers.indexOf(sub.id), 1);
    check((await request(`/api/subscribers/${sub.id}`)).status === 400, "subscriber-deleted");
  } finally {
    let failed = false;
    for (const id of subscribers.reverse())
      if ((await request(`/api/subscribers/${id}`, "DELETE")).status !== 200) failed = true;
    for (const id of lists.reverse())
      if ((await request(`/api/lists/${id}`, "DELETE")).status !== 200) failed = true;
    if (failed) throw new Error("FAIL subscriber-cleanup");
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
    await runSubscribersContract({ mode: "reference", baseUrl, credentials: { user, token } });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-]+$/.test(error.message) ? error.message : "Subscribers contract failed"}\n`,
    );
    process.exitCode = 1;
  }
}
