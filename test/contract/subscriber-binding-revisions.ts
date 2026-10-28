// Reference: listmonk subscriber binding and importer at 6fcd95f.
import type { Credentials, Mode } from "@/test/contract/types";

export async function runSubscriberBindingRevisions(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
}) {
  const suffix = crypto.randomUUID();
  const owned: { path: string; id: number }[] = [];
  const auth = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const request = (path: string, method = "GET", body?: string, type = "application/json") =>
    fetch(`${target.baseUrl}${path}`, {
      method,
      headers: { Authorization: auth, ...(body === undefined ? {} : { "Content-Type": type }) },
      ...(body === undefined ? {} : { body }),
    });
  function check(value: unknown, label: string): asserts value {
    if (!value) throw new Error(`FAIL binding-${label}`);
  }
  async function create(path: string, body: string, type = "application/json") {
    const response = await request(`/api/${path}`, "POST", body, type);
    const result = await response.json();
    if (response.status === 200 && typeof result.data?.id === "number")
      owned.push({ path, id: result.data.id });
    check(response.status === 200 && result.data, "create");
    return result.data;
  }
  async function get(id: number) {
    const r = await request(`/api/subscribers/${id}`);
    check(r.status === 200, "get");
    return (await r.json()).data;
  }
  let cleanupFailed = false;
  try {
    const list = await create("lists", JSON.stringify({ name: `binding-${suffix}` }));
    const sub = await create(
      "subscribers",
      `{"email":"binding-${suffix}@example.test","ids":"metadata","attribs":{"old":1},"lists":[${list.id}],"LISTS":[null]}`,
    );
    check(sub.lists.length === 1 && sub.lists[0].id === list.id, "slice-reuse");
    for (const [i, lists, expected] of [
      [0, `[${list.id},${list.id}],\"lists\":[0],\"lists\":[null,null]`, true],
      [1, `[${list.id}],\"lists\":null,\"lists\":[null]`, false],
      [2, `[${list.id}],\"lists\":[],\"lists\":[null]`, false],
    ] as const) {
      const item = await create(
        "subscribers",
        `{"email":"slice-${i}-${suffix}@example.test","lists":${lists}}`,
      );
      check(
        item.lists.some((entry: any) => entry.id === list.id) === expected,
        "slice-repetitions",
      );
      check(
        (await get(item.id)).lists.some((entry: any) => entry.id === list.id) === expected,
        "slice-repetitions-persisted",
      );
    }
    for (const raw of [
      '{"attribs":null,"attribs":{"b":2}}',
      '{"attribs":{"a":1},"ATTRIBS":null,"attribs":{"b":2}}',
    ]) {
      const r = await request(`/api/subscribers/${sub.id}`, "PATCH", raw);
      check(
        r.status === 200 && JSON.stringify((await r.json()).data.attribs) === '{"b":2}',
        "attrib-reset",
      );
      check(JSON.stringify((await get(sub.id)).attribs) === '{"b":2}', "attrib-reset-persisted");
    }
    const rawAttrs = '{"attribs":{"\\ud800":{"nested":["\\udfff",1,true,null]}}}';
    const attrs = await request(`/api/subscribers/${sub.id}`, "PATCH", rawAttrs);
    check(attrs.status === 200, "attrib-surrogates-status");
    const saved = (await get(sub.id)).attribs;
    check(
      saved["�"].nested[0] === "�" &&
        saved["�"].nested[1] === 1 &&
        saved["�"].nested[2] === true &&
        saved["�"].nested[3] === null,
      "attrib-surrogates",
    );
    const collision = await request(
      `/api/subscribers/${sub.id}`,
      "PATCH",
      '{"attribs":{"\\ud800":1,"�":2,"\\ud800":3}}',
    );
    check(
      collision.status === 200 && (await get(sub.id)).attribs["�"] === 3,
      "attrib-normalized-key-order",
    );
    for (const raw of ['{"attribs":{"n":1e400}}', '{"attribs":{"n":1e999,"n":1}}']) {
      const before = await get(sub.id);
      const r = await request(`/api/subscribers/${sub.id}`, "PATCH", raw);
      check(
        r.status === 400 && JSON.stringify(await get(sub.id)) === JSON.stringify(before),
        "attrib-overflow-no-write",
      );
    }
    for (const [address, expected] of [
      [`İ-${suffix}@example.test`, `i-${suffix}@example.test`],
      [`ΟΣ-${suffix}@example.test`, `οσ-${suffix}@example.test`],
      [`bom-${suffix}@a\ufeffb`, `bom-${suffix}@a\ufeffb`],
    ] as const) {
      const r = await request(
        `/api/subscribers/${sub.id}`,
        "PATCH",
        JSON.stringify({ email: address }),
      );
      check(
        r.status === 200 &&
          (await r.json()).data.email === expected &&
          (await get(sub.id)).email === expected,
        "email-normalization",
      );
    }
    const before = await get(sub.id);
    const invalid = await request(
      `/api/subscribers/${sub.id}`,
      "PATCH",
      JSON.stringify({ email: `bad-${suffix}@[garbage]` }),
    );
    check(
      invalid.status === 400 && JSON.stringify(await get(sub.id)) === JSON.stringify(before),
      "email-literal-no-write",
    );
    for (const method of ["PUT", "PATCH"]) {
      const address = `${method.toLowerCase()}-${suffix}@a\ufeffb`;
      const r = await request(
        `/api/subscribers/${sub.id}`,
        method,
        JSON.stringify({ email: address }),
      );
      check(
        r.status === 200 &&
          (await r.json()).data.email === address &&
          (await get(sub.id)).email === address,
        "email-update",
      );
      const prior = await get(sub.id);
      const bad = await request(
        `/api/subscribers/${sub.id}`,
        method,
        JSON.stringify({ email: `bad-${suffix}@[nonsense]` }),
      );
      check(
        bad.status === 400 && JSON.stringify(await get(sub.id)) === JSON.stringify(prior),
        "email-update-invalid",
      );
    }
    if (target.mode !== "reference") {
      const ext = await create(
        "subscribers",
        JSON.stringify({ email: `ext-${suffix}@example.test`, external_id: `binding-${suffix}` }),
      );
      const r = await request(
        `/api/subscribers/external?external_id=binding-${suffix}`,
        "PUT",
        JSON.stringify({ email: `İ-ext-${suffix}@example.test` }),
      );
      check(
        r.status === 200 &&
          (await r.json()).data.email === `i-ext-${suffix}@example.test` &&
          (await get(ext.id)).email === `i-ext-${suffix}@example.test`,
        "external-email",
      );
    }
    const form = await create(
      "subscribers",
      `email=first-${suffix}%40example.test&email=last-${suffix}%40example.test&name=First&name=Last`,
      "application/x-www-form-urlencoded",
    );
    check(form.email === `first-${suffix}@example.test` && form.name === "First", "form-first");
    const queryForm = await request(
      `/api/subscribers?email=query-${suffix}%40example.test&name=Query`,
      "POST",
      `email=body-${suffix}%40example.test&name=Body`,
      "application/x-www-form-urlencoded",
    );
    const queryResult = (await queryForm.json()).data;
    if (queryForm.status === 200) owned.push({ path: "subscribers", id: queryResult.id });
    check(
      queryForm.status === 200 &&
        queryResult.email === `body-${suffix}@example.test` &&
        queryResult.name === "Body",
      "form-query-precedence",
    );
    const badFormBefore = await get(sub.id);
    const badForm = await request(
      `/api/subscribers/${sub.id}`,
      "PATCH",
      "name=%ZZ",
      "application/x-www-form-urlencoded",
    );
    check(
      badForm.status === 400 && JSON.stringify(await get(sub.id)) === JSON.stringify(badFormBefore),
      "form-malformed-no-write",
    );
    const boundary = `test-${suffix}`;
    const multipart = [
      `--${boundary}\r\nContent-Disposition: form-data; name="email"\r\n\r\nmulti-${suffix}@example.test\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nMultipart\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nLater\r\n`,
      `--${boundary}--\r\n`,
    ].join("");
    const multi = await create(
      "subscribers",
      multipart,
      `multipart/form-data; boundary=${boundary}`,
    );
    check(
      multi.email === `multi-${suffix}@example.test` && multi.name === "Multipart",
      "multipart",
    );
    for (const [i, field] of [
      "<Lists/>",
      "<PreconfirmSubs/>",
      "<PreconfirmSubs> true </PreconfirmSubs>",
    ].entries()) {
      const xml = await create(
        "subscribers",
        `<Subscriber><Email>xml-${i}-${suffix}@example.test</Email>${field}</Subscriber>`,
        "application/xml",
      );
      check(xml.email === `xml-${i}-${suffix}@example.test`, "xml-default");
    }
    const xmlBad = await request(
      `/api/subscribers/${sub.id}`,
      "PATCH",
      `<Subscriber><PreconfirmSubs>no</PreconfirmSubs></Subscriber>`,
      "application/xml",
    );
    const xmlBefore = await get(sub.id);
    check(xmlBad.status === 400, "xml-invalid-bool");
    const xmlBadInt = await request(
      `/api/subscribers/${sub.id}`,
      "PATCH",
      `<Subscriber><Lists>1.0</Lists></Subscriber>`,
      "application/xml",
    );
    check(
      xmlBadInt.status === 400 && JSON.stringify(await get(sub.id)) === JSON.stringify(xmlBefore),
      "xml-invalid-no-write",
    );
    const unchanged = await get(sub.id);
    const malformed = await request(`/api/subscribers/${sub.id}`, "PATCH", '{"ignored":{"a":}}');
    check(
      malformed.status === 400 && JSON.stringify(await get(sub.id)) === JSON.stringify(unchanged),
      "ignored-invalid-document",
    );
    const seedPath = await request(`/api/subscribers/${sub.id}`, "PATCH", `{"lists":[${list.id}]}`);
    check(
      seedPath.status === 200 &&
        (await get(sub.id)).lists.some((entry: any) => entry.id === list.id),
      "path-seed",
    );
    const pathAction = await request(
      `/api/subscribers/lists/${sub.id}`,
      "PUT",
      `{"ids":"metadata","target_list_ids":[${list.id}],"action":"remove"}`,
    );
    check(pathAction.status === (target.mode === "reference" ? 400 : 200), "D38-path-owned-ids");
    check(
      (await get(sub.id)).lists.some((entry: any) => entry.id === list.id) ===
        (target.mode === "reference"),
      "D38-path-owned-ids-state",
    );
    const block = await request(
      "/api/subscribers/blocklist",
      "PUT",
      `{"ids":[${multi.id}],"email":1}`,
    );
    check(
      block.status === 200 && (await get(multi.id)).status === "blocklisted",
      "bulk-owned-fields",
    );
  } finally {
    for (const { path, id } of owned.reverse())
      if ((await request(`/api/${path}/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
  }
  if (cleanupFailed) throw new Error("FAIL binding-cleanup");
}
