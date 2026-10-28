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
    const form = await create(
      "subscribers",
      `email=first-${suffix}%40example.test&email=last-${suffix}%40example.test&name=First&name=Last`,
      "application/x-www-form-urlencoded",
    );
    check(form.email === `first-${suffix}@example.test` && form.name === "First", "form-first");
    const boundary = `test-${suffix}`;
    const multipart = [
      `--${boundary}\r\nContent-Disposition: form-data; name="email"\r\n\r\nmulti-${suffix}@example.test\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nMultipart\r\n`,
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
