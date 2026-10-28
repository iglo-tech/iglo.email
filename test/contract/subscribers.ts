// Reference: listmonk cmd/subscribers.go, internal/core/subscribers.go,
// internal/core/subscriptions.go and queries/subscribers.sql at 6fcd95f.
import { runSubscriberScope } from "@/test/contract/subscriber-scope";
import type { Credentials, Mode } from "@/test/contract/types";

export async function runSubscribersContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
}) {
  const suffix = crypto.randomUUID();
  const subscribers: number[] = [];
  const lists: number[] = [];
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
    async function raw(body: string | ArrayBuffer, contentType: string) {
      const response = await fetch(`${target.baseUrl}/api/subscribers`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": contentType },
        body,
      });
      const value = await response.json();
      if (response.status === 200 && typeof value.data?.id === "number")
        subscribers.push(value.data.id);
      return { response, value };
    }
    for (const [local, domain, accepted] of [
      [".dot", "example.test", false],
      ["dot.", "example.test", false],
      ["double..dot", "example.test", false],
      ["local", ".example.test", false],
      ["local", "example.test.", false],
      ["quoted", "localhost", true],
      ["with+plus", "example.test", true],
      ["δοκιμή", "example.test", true],
      ["local", "[127.0.0.1]", true],
      ['"quoted"', "example.test", false],
      ["bad\u0000local", "example.test", false],
    ] as const) {
      const part = local.endsWith(".") ? `${suffix}${local}` : `${local}-${suffix}`;
      const candidate = `${part}@${domain}`;
      const result = await raw(
        JSON.stringify({ email: candidate, name: "Known" }),
        "application/json",
      );
      check(
        result.response.status === (accepted ? 200 : 400),
        `subscriber-email-boundary-${accepted}`,
      );
    }
    const aliases = await raw(
      `{"email":"wrong-${suffix}@example.test","EMAIL":"alias-${suffix}@example.test","name":"A","NAME":null,"attribs":{"n":1}}`,
      "application/json",
    );
    check(
      aliases.response.status === 200 &&
        aliases.value.data.email === `alias-${suffix}@example.test` &&
        aliases.value.data.name === "A",
      "subscriber-json-alias-null",
    );
    for (const body of [
      `{"email":"bad-${suffix}@example.test","attribs":[]}`,
      `{"email":23,"Email":"bad-${suffix}@example.test"}`,
      `{"email":"bad-${suffix}@example.test","lists":[false]}`,
      "[1]",
      "{broken",
    ]) {
      check(
        (await raw(body, "application/json")).response.status === 400,
        "subscriber-json-invalid",
      );
    }
    const highID = await raw(
      `{"email":"high-${suffix}@example.test","lists":[9223372036854775807]}`,
      "application/json",
    );
    check(highID.response.status === 500, "subscriber-json-int64-id-reference-width");
    for (const token of ["1.0", "1e0", "9223372036854775808", "-9223372036854775809"]) {
      check(
        (
          await raw(
            `{"email":"invalid-id-${suffix}@example.test","lists":[${token}]}`,
            "application/json",
          )
        ).response.status === 400,
        "subscriber-json-invalid-int64",
      );
    }
    const nullList = await raw(
      `{"email":"null-list-${suffix}@example.test","lists":[null]}`,
      "application/json",
    );
    check(
      nullList.response.status === 200 && nullList.value.data.lists.length === 0,
      "subscriber-json-null-list-element",
    );
    const xml = await raw(
      `<Subscriber attr="&amp;"><Email>xml-${suffix}@example.test</Email><Name> <![CDATA[x<y]]> &amp; &#00000000000000000000000065;</Name><!-- valid --></Subscriber><unused`,
      "application/xml",
    );
    check(
      xml.response.status === 200 && xml.value.data.name === "x<y & A",
      "subscriber-xml-document",
    );
    for (const body of [
      `<Subscriber><Email>bad-${suffix}@example.test</Subscriber>`,
      `<Subscriber bad="&broken"><Email>bad-${suffix}@example.test</Email></Subscriber>`,
      `<Subscriber><Email>bad-${suffix}@example.test</Email><Ignored>\u0000</Ignored></Subscriber>`,
    ]) {
      check((await raw(body, "application/xml")).response.status === 400, "subscriber-xml-invalid");
    }
    const form = await raw(
      new URLSearchParams({
        email: `form-${suffix}@example.test`,
        name: "  Form Name  ",
      }).toString(),
      "application/x-www-form-urlencoded",
    );
    check(
      form.response.status === 200 && form.value.data.name === "Form Name",
      "subscriber-form-fields",
    );
    const bytes = (prefix: string, byte: number, tail: string) =>
      new Uint8Array([...new TextEncoder().encode(prefix), byte, ...new TextEncoder().encode(tail)])
        .buffer;
    const replacement = await raw(
      bytes(`{"email":"bytes-${suffix}@example.test","name":"`, 255, '"}'),
      "application/json",
    );
    check(
      replacement.response.status === 200 && replacement.value.data.name === "\ufffd",
      "subscriber-json-replacement-utf8",
    );
    const invalidXML = await raw(
      bytes(
        `<Subscriber><Email>bad-${suffix}@example.test</Email><Ignored>`,
        255,
        "</Ignored></Subscriber>",
      ),
      "application/xml",
    );
    check(invalidXML.response.status === 400, "subscriber-xml-invalid-utf8");
    const suffixXML = await raw(
      bytes(`<Subscriber><Email>suffix-${suffix}@example.test</Email></Subscriber>`, 255, ""),
      "application/xml",
    );
    check(suffixXML.response.status === 200, "subscriber-xml-unused-invalid-suffix");
    const doctype = await raw(
      `<!DOCTYPE Subscriber><Subscriber><Email>doctype-${suffix}@example.test</Email></Subscriber>`,
      "application/xml",
    );
    check(
      doctype.response.status === (target.mode === "reference" ? 200 : 400),
      "D37-subscriber-xml-doctype",
    );
    const semantics = await create({
      email: `semantics-${suffix}@example.test`,
      attribs: { first: 1, nested: { one: 1, two: 2 } },
      lists: [list],
    });
    let semanticsResponse = await request(`/api/subscribers/${semantics.id}`, "PATCH", {
      attribs: { nested: { one: 3 } },
    });
    let semanticsData = (await semanticsResponse.json()).data;
    check(
      semanticsResponse.status === 200 &&
        semanticsData.attribs.first === 1 &&
        semanticsData.attribs.nested.one === 3 &&
        semanticsData.attribs.nested.two === undefined,
      "subscriber-patch-attribs-shallow-binding",
    );
    semanticsResponse = await request(`/api/subscribers/${semantics.id}`, "PATCH", { attribs: {} });
    semanticsData = (await semanticsResponse.json()).data;
    check(
      semanticsResponse.status === 200 && semanticsData.attribs.first === 1,
      "subscriber-patch-empty-map",
    );
    semanticsResponse = await request(`/api/subscribers/${semantics.id}`, "PATCH", {
      attribs: null,
      email: null,
      name: null,
    });
    semanticsData = (await semanticsResponse.json()).data;
    check(
      semanticsResponse.status === 200 &&
        Object.keys(semanticsData.attribs).length === 0 &&
        semanticsData.email === semantics.email &&
        semanticsData.name === semantics.name,
      "subscriber-patch-null-fields",
    );
    const xmlAction = await fetch(`${target.baseUrl}/api/subscribers/lists`, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/xml" },
      body: `<Request><SubscriberIDs>${semantics.id}</SubscriberIDs><TargetListIDs>${list}</TargetListIDs><Action>unsubscribe</Action></Request>`,
    });
    check(
      xmlAction.status === 200 &&
        (await get(semantics.id)).lists[0]?.subscription_status === "unsubscribed",
      "subscriber-xml-bulk-action",
    );
    check(
      (await request(`/api/subscribers/${semantics.id}`, "PUT", {})).status === 400,
      "subscriber-put-email-required",
    );
    semanticsResponse = await request(`/api/subscribers/${semantics.id}`, "PUT", {
      email: semantics.email,
    });
    semanticsData = (await semanticsResponse.json()).data;
    check(
      semanticsResponse.status === 200 &&
        semanticsData.name === semantics.name &&
        semanticsData.lists.length === 0 &&
        Object.keys(semanticsData.attribs).length === 0,
      "subscriber-put-defaults",
    );
    for (const selector of ["", "0", "-1", "garbage", "9223372036854775808"]) {
      check(
        (await request(`/api/subscribers?id=${selector}`, "DELETE")).status === 400,
        "subscriber-delete-selector-invalid",
      );
    }
    check(
      (
        await request("/api/subscribers/lists", "PUT", {
          ids: [semantics.id],
          target_list_ids: [2147483647],
          action: "add",
        })
      ).status === 500,
      "subscriber-add-missing-list",
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
    for (const id of subscribers.reverse())
      if ((await request(`/api/subscribers/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    for (const id of lists.reverse())
      if ((await request(`/api/lists/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
  }
  if (cleanupFailed) throw new Error("FAIL subscriber-cleanup");
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
    await runSubscriberScope({ mode: "reference", baseUrl, credentials: { user, token } });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-]+$/.test(error.message) ? error.message : "Subscribers contract failed"}\n`,
    );
    process.exitCode = 1;
  }
}
