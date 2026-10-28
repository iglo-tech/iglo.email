// Reference: listmonk subscriber/importer handlers at 6fcd95f; D43 validation.
import type { Credentials, Mode } from "@/test/contract/types";

export async function runSubscriberCouncilRevisions(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
}) {
  const suffix = crypto.randomUUID();
  const owned: { path: string; id: number }[] = [];
  const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const request = (path: string, method = "GET", body?: unknown, raw = false) =>
    fetch(target.baseUrl + path, {
      method,
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: raw ? String(body) : JSON.stringify(body) }),
    });
  function check(value: unknown, label: string): asserts value {
    if (!value) throw new Error(`FAIL council-${label}`);
  }
  async function create(path: string, body: unknown, raw = false) {
    const response = await request(`/api/${path}`, "POST", body, raw);
    const result = await response.json();
    if (response.status === 200 && typeof result.data?.id === "number")
      owned.push({ path, id: result.data.id });
    check(response.status === 200 && result.data, "create");
    return result.data;
  }
  async function get(path: string) {
    const response = await request(path);
    check(response.status === 200, "get");
    return (await response.json()).data;
  }
  const subscribers = "/api/subscribers";
  let cleanupFailed = false;
  try {
    for (const [i, local, expected] of [
      [0, "ǳuro", "ǲuro"],
      [1, "ǆuro", "ǅuro"],
      [2, "ǉuro", "ǈuro"],
      [3, "ǌuro", "ǋuro"],
      [4, "ᾀbc", "ᾈbc"],
      [5, "ᾷbc", "Α\u0342\u0345bc"],
      [6, "ﬃeld", "Ffield"],
      [7, "ŉame", "ʼName"],
      [8, "ևan", "Եւan"],
      [9, "ქართული", "ქართული"],
      [10, "\u0345alpha", "Ιalpha"],
      [11, "ⅷe", "Ⅷe"],
      [12, "o'connor.a+b", "O'connor A+B"],
      [13, "a中b", "A中B"],
      [14, "aカb", "AカB"],
      [15, "a''b", "A''B"],
    ] as const) {
      const sub = await create("subscribers", { email: `${local}@title-${i}-${suffix}.test` });
      check(sub.name === expected, `titlecase-${i}`);
      check((await get(`${subscribers}/${sub.id}`)).name === expected, `titlecase-${i}-persisted`);
    }
    const list = await create("lists", { name: `council-${suffix}`, optin: "double" });
    const sub = await create("subscribers", {
      email: `stable-${suffix}@example.test`,
      name: "Stable",
      attribs: { keep: { a: 1 } },
      lists: [list.id],
      preconfirm_subscriptions: true,
      ...(target.mode === "normal" ? { external_id: `council-${suffix}` } : {}),
    });
    for (const [query, detail] of [
      ["", "ids"],
      ["?id=0", "0 is not a valid ID"],
      ["?id=-1", "-1 is not a valid ID"],
      ["?id=%2B000", "0 is not a valid ID"],
      [`?id=${sub.id}&id=0`, "0 is not a valid ID"],
    ]) {
      const response = await request(subscribers + query, "DELETE");
      check(
        response.status === 400 &&
          JSON.stringify(await response.json()) ===
            JSON.stringify({ message: `One or more IDs are invalid: ${detail}` }),
        `delete-context-${query}`,
      );
      check((await get(`${subscribers}/${sub.id}`)).uuid === sub.uuid, "delete-no-write");
    }
    const badFields = [
      { name: "A\0B" },
      { attribs: { s: "A\0B" } },
      { attribs: { nested: [{ s: "A\0B" }] } },
      { attribs: { "A\0B": 1 } },
      { attribs: { nested: [{ "A\0B": 1 }] } },
    ];
    for (const [i, fields] of badFields.entries()) {
      const email = `nul-${i}-${suffix}@example.test`;
      const countBefore = await get(`/api/lists/${list.id}`);
      const response = await request(subscribers, "POST", {
        email,
        lists: [list.id],
        preconfirm_subscriptions: true,
        ...fields,
      });
      const result = await response.json();
      if (response.status === 200 && typeof result.data?.id === "number")
        owned.push({ path: "subscribers", id: result.data.id });
      check(response.status === (target.mode === "normal" ? 400 : 500), `D43-create-${i}`);
      if (target.mode === "normal")
        check(
          result.message === ("name" in fields ? "Invalid name" : "Invalid attributes."),
          "D43-safe-message",
        );
      check(
        (await get(`/api/lists/${list.id}`)).subscriber_count === countBefore.subscriber_count,
        "D43-create-memberships-unchanged",
      );
      const retry = await create("subscribers", { email, name: "Valid retry" });
      check(retry.email === email && retry.name === "Valid retry", "D43-create-no-write");
      for (const method of ["PUT", "PATCH"]) {
        const before = await get(`${subscribers}/${sub.id}`);
        const rejected = await request(`${subscribers}/${sub.id}`, method, {
          email: `rekey-${i}-${method}-${suffix}@example.test`,
          name: "Changed",
          lists: [],
          preconfirm_subscriptions: false,
          ...fields,
        });
        check(rejected.status === (target.mode === "normal" ? 400 : 500), `D43-${method}-${i}`);
        check(
          JSON.stringify(await get(`${subscribers}/${sub.id}`)) === JSON.stringify(before),
          `D43-${method}-atomic`,
        );
      }
      if (target.mode === "normal") {
        const path = `${subscribers}/external?external_id=council-${suffix}`;
        const before = await get(path);
        const rejected = await request(path, "PUT", {
          email: `external-${i}-${suffix}@example.test`,
          external_id: `changed-${i}-${suffix}`,
          lists: [],
          ...fields,
        });
        check(rejected.status === 400, `D43-external-${i}`);
        check(JSON.stringify(await get(path)) === JSON.stringify(before), "D43-external-atomic");
      }
    }
    const overwritten = await create(
      "subscribers",
      `{"email":"overwritten-${suffix}@example.test","name":"A\\u0000B","name":"Safe","attribs":{"x":"A\\u0000B","x":"safe"},"metadata":{"nul":"A\\u0000B"}}`,
      true,
    );
    check(
      overwritten.name === "Safe" && overwritten.attribs.x === "safe",
      "D43-final-bound-values",
    );
    const reset = await create(
      "subscribers",
      `{"email":"reset-${suffix}@example.test","name":"Safe","attribs":{"x":"A\\u0000B"},"attribs":null,"attribs":{"safe":1}}`,
      true,
    );
    check(JSON.stringify(reset.attribs) === '{"safe":1}', "D43-bound-reset");
  } finally {
    for (const item of owned.reverse())
      if ((await request(`/api/${item.path}/${item.id}`, "DELETE")).status !== 200)
        cleanupFailed = true;
  }
  if (cleanupFailed) throw new Error("FAIL council-cleanup");
}
