// Reference: listmonk subscriber handlers/core/SQL at 6fcd95f; D41 corrections.
import type { Credentials, Mode } from "@/test/contract/types";

export async function runSubscriberStateRevisions(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
}) {
  const suffix = crypto.randomUUID();
  const owned: { path: string; id: number }[] = [];
  const auth = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(`${target.baseUrl}${path}`, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  function check(value: unknown, label: string): asserts value {
    if (!value) throw new Error(`FAIL ${label}`);
  }
  async function create(path: string, body: unknown) {
    const response = await request(`/api/${path}`, "POST", body);
    const data = (await response.json()).data;
    if (response.status === 200 && typeof data?.id === "number") owned.push({ path, id: data.id });
    check(response.status === 200 && data, "subscriber-state-seed");
    return data;
  }
  async function get(id: number) {
    const response = await request(`/api/subscribers/${id}`);
    check(response.status === 200, "subscriber-state-get");
    return (await response.json()).data;
  }
  let cleanupFailed = false;
  try {
    const list = await create("lists", { name: `state-list-${suffix}` });
    const tagged = await create("lists", { name: `state-tagged-${suffix}`, tags: ["kept"] });
    const sub = await create("subscribers", {
      email: `state-${suffix}@example.test`,
      lists: [list.id, tagged.id],
      preconfirm_subscriptions: true,
      external_id: `state-${suffix}`,
    });
    for (const result of [sub, await get(sub.id)]) {
      check(
        result.lists.find((l: any) => l.id === list.id).tags === null,
        "subscriber-projection-null-tags",
      );
      check(
        JSON.stringify(result.lists.find((l: any) => l.id === tagged.id).tags) === '["kept"]',
        "subscriber-projection-nonempty-tags",
      );
    }
    for (const [input, expected] of [
      ["\u0085Name\u0085", "Name"],
      ["\ufeffName\ufeff", "\ufeffName\ufeff"],
    ]) {
      const response = await request(`/api/subscribers/${sub.id}`, "PATCH", { name: input });
      check(
        response.status === 200 && (await response.json()).data.name === expected,
        "subscriber-update-Go-whitespace",
      );
      check((await get(sub.id)).name === expected, "subscriber-update-Go-whitespace-persisted");
    }
    const cases = [
      ["blocklist", { ids: [] }, "One or more IDs are invalid: ids"],
      ["lists", { ids: [], target_list_ids: [list.id], action: "add" }, "No IDs given."],
      ["lists", { ids: [sub.id], action: "add" }, "No lists given."],
      [
        "lists",
        { ids: [sub.id], target_list_ids: [list.id], action: "invalid" },
        "Invalid action.",
      ],
      [
        "lists",
        { ids: [sub.id], target_list_ids: [list.id], action: "add", status: "invalid" },
        "Invalid fields: status",
      ],
    ] as const;
    for (const [path, body, message] of cases) {
      const before = await get(sub.id);
      const response = await request(`/api/subscribers/${path}`, "PUT", body);
      check(
        response.status === 400 && (await response.json()).message === message,
        "subscriber-safe-bulk-error-envelope",
      );
      check(
        JSON.stringify(await get(sub.id)) === JSON.stringify(before),
        "subscriber-safe-bulk-error-no-write",
      );
    }
    const other = await create("subscribers", { email: `other-state-${suffix}@example.test` });
    const conflictPaths = [`/api/subscribers/${sub.id}`];
    if (target.mode !== "reference")
      conflictPaths.push(`/api/subscribers/external?external_id=state-${suffix}`);
    for (const path of conflictPaths) {
      for (const method of path.includes("?") ? ["PUT"] : ["PUT", "PATCH"]) {
        const before = await get(sub.id);
        const response = await request(path, method, {
          email: other.email,
          name: "must not persist",
          lists: [],
        });
        const result = await response.json();
        check(
          response.status === (target.mode === "reference" ? 500 : 409) &&
            (target.mode === "reference" || result.message === "E-mail already exists."),
          "D41-safe-duplicate-email",
        );
        check(
          JSON.stringify(await get(sub.id)) === JSON.stringify(before),
          "D41-duplicate-email-no-write",
        );
      }
    }
    for (const [ids, targets] of [
      [[sub.id, sub.id], [list.id]],
      [[sub.id], [list.id, list.id]],
      [
        [sub.id, sub.id],
        [list.id, list.id],
      ],
    ]) {
      check(
        (
          await request("/api/subscribers/lists", "PUT", {
            ids: [sub.id],
            target_list_ids: [list.id],
            action: "unsubscribe",
          })
        ).status === 200,
        "D41-duplicate-seed-unsubscribed",
      );
      const before = await get(sub.id);
      const response = await request("/api/subscribers/lists", "PUT", {
        ids,
        target_list_ids: targets,
        action: "add",
        status: "confirmed",
      });
      check(
        response.status === (target.mode === "reference" ? 500 : 200),
        "D41-duplicate-selector-status",
      );
      const after = await get(sub.id);
      check(
        after.lists.find((l: any) => l.id === list.id).subscription_status ===
          (target.mode === "reference" ? "unsubscribed" : "confirmed"),
        "D41-duplicate-selector-explicit-write",
      );
      check(
        after.lists.find((l: any) => l.id === tagged.id).subscription_status === "confirmed",
        "D41-unrelated-membership-retained",
      );
      if (target.mode === "reference")
        check(JSON.stringify(after) === JSON.stringify(before), "D41-reference-duplicate-no-write");
    }
    const blocked = await create("subscribers", {
      email: `blocked-state-${suffix}@example.test`,
      status: "blocklisted",
      lists: [list.id],
    });
    check(
      (
        await request("/api/subscribers/lists", "PUT", {
          ids: [blocked.id],
          target_list_ids: [list.id],
          action: "add",
          status: "confirmed",
        })
      ).status === 200,
      "subscriber-explicit-empty-status-seed",
    );
    const empty = await request(`/api/subscribers/${blocked.id}`, "PATCH", {
      status: "",
      lists: [list.id],
    });
    const data = (await empty.json()).data;
    check(
      empty.status === 200 &&
        data.status === "blocklisted" &&
        data.lists[0].subscription_status === "confirmed",
      "subscriber-explicit-empty-PATCH-status",
    );
    check(
      (await get(blocked.id)).lists[0].subscription_status === "confirmed",
      "subscriber-empty-status-history-persisted",
    );
  } finally {
    for (const { path, id } of owned.reverse())
      if ((await request(`/api/${path}/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
  }
  if (cleanupFailed) throw new Error("FAIL subscriber-state-revision-cleanup");
}
