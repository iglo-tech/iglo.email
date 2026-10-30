// POST /api/tx behavior through the HTTP boundary and a loopback SMTP sink.
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { imagePng } from "@/test/media/images";
import { txFixture, type TxFixture } from "@/test/tx/fixture";

const fixtures: TxFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open(options: Parameters<typeof txFixture>[0] = {}) {
  const f = await txFixture(options);
  fixtures.push(f);
  return f;
}
async function apiUser(f: TxFixture, permissions: string[]) {
  const role = await f.json("/api/roles/users", "POST", {
    name: `role-${crypto.randomUUID()}`,
    permissions,
  });
  expect(role.status).toBe(200);
  const user = await f.json("/api/users", "POST", {
    username: `api-${crypto.randomUUID().slice(0, 8)}`,
    type: "api",
    status: "enabled",
    user_role_id: role.body.data.id,
  });
  expect(user.status).toBe(200);
  return {
    id: user.body.data.id as number,
    headers: {
      authorization: `Basic ${btoa(`${user.body.data.username}:${user.body.data.password}`)}`,
    },
  };
}

test("sync send renders listmonk-compatible context and journals the outcome", async () => {
  const f = await open();
  const template = await f.template(
    "<p>{{ subscriber.first_name }}/{{ subscriber.last_name }} {{ subscriber.attribs.city }} {{ data.order }} {{ data.html }}</p>",
  );
  const id = await f.subscriber("ada@example.test", "Ada King Lovelace", {
    attribs: { city: "London" },
  });
  const response = await f.tx({
    subscriber_id: id,
    template_id: template,
    data: { order: 7, html: "<b>" },
    headers: [{ "x-custom": "one", "Message-ID": "<caller@example.test>" }, { "X-Custom": "two" }],
  });
  expect(response.status).toBe(200);
  const [row] = response.body.data.sends;
  expect(row.status).toBe("sent");
  expect(f.sink.messages).toHaveLength(1);
  const data = f.sink.messages[0]!.data;
  expect(f.sink.messages[0]!.to).toEqual(["ada@example.test"]);
  expect(data).toContain("Subject: Subject 7");
  expect(data).toContain("Ada/Lovelace London 7 &lt;b&gt;");
  expect(data).toMatch(/^X-Custom: one$/m);
  expect(data).not.toContain("two");
  // D53: the journal Message-ID replaces a caller-supplied one.
  expect(data).toContain(`Message-ID: ${row.smtp_message_id}`);
  expect(data).not.toContain("caller@example.test");
  const journal = await f.json(`/api/sends/${row.id}`);
  expect(journal.body.data).toMatchObject({
    source: "tx",
    kind: "transactional",
    subscriber_id: id,
    to_email: "ada@example.test",
    template_id: template,
    status: "sent",
    attempts: 1,
  });
});

test("SMTP rejection is journaled as failed in the sync response", async () => {
  const f = await open({ reject: () => true });
  const template = await f.template("<p>x</p>");
  const response = await f.tx({ subscriber_emails: ["x@example.test"], template_id: template });
  expect(response.status).toBe(200);
  expect(response.body.data.sends[0].status).toBe("failed");
  expect(f.sink.messages).toHaveLength(0);
});

test("async returns queued rows and the outbox delivers them", async () => {
  const f = await open();
  const template = await f.template("<p>x</p>");
  const response = await f.tx({
    subscriber_emails: ["a@example.test", "b@example.test"],
    template_id: template,
    async: true,
  });
  expect(response.status).toBe(200);
  expect(response.body.data.sends.map((s: { status: string }) => s.status)).toEqual([
    "queued",
    "queued",
  ]);
  for (let i = 0; i < 200 && f.sink.messages.length < 2; i++) {
    f.clock.advance(0);
    await Bun.sleep(5);
  }
  expect(f.sink.messages.map((m) => m.to[0]).sort()).toEqual(["a@example.test", "b@example.test"]);
});

test("idempotency returns the first rows under concurrency and rejects a different request", async () => {
  const f = await open();
  const template = await f.template("<p>{{ data.n }}</p>");
  const body = {
    subscriber_emails: ["a@example.test", "b@example.test"],
    template_id: template,
    data: { n: 1 },
    idempotency_key: "k1",
  };
  const results = await Promise.all(Array.from({ length: 5 }, () => f.tx(body)));
  expect(results.every((r) => r.status === 200)).toBe(true);
  const ids = new Set(
    results.map((r) => JSON.stringify(r.body.data.sends.map((s: { id: number }) => s.id))),
  );
  expect(ids.size).toBe(1);
  expect(f.count()).toBe(2);
  expect(f.sink.messages).toHaveLength(2);
  // `async` alone does not make it a different request.
  expect((await f.tx({ ...body, async: true })).body.data.sends).toEqual(
    results[0]!.body.data.sends,
  );
  const conflict = await f.tx({ ...body, data: { n: 2 } });
  expect(conflict.status).toBe(409);
  expect(f.count()).toBe(2);
  expect(f.sink.messages).toHaveLength(2);
  expect((await f.tx({ ...body, idempotency_key: "x".repeat(256) })).status).toBe(400);
});

test("render, recipient and validation failures are atomic", async () => {
  const f = await open();
  const template = await f.template("<p>{{ data.a }}</p>");
  const known = await f.subscriber("k@example.test");
  const cases: unknown[] = [
    { subscriber_ids: [known, 999], template_id: template },
    { subscriber_ids: [known], template_id: template, data: { a: "x".repeat(300 * 1024) } },
    { subscriber_ids: [known], template_id: template, subject: "{% if %}" },
    { subscriber_ids: [known], template_id: template, altbody: "{{ x | nope }}" },
    { subscriber_ids: [known], template_id: template, from_email: "not an address" },
    { subscriber_ids: [known], template_id: template, headers: [{ "Bad Name": "x" }] },
    {
      subscriber_ids: [known],
      template_id: template,
      headers: [{ "X-A": "a\r\nBcc: e@example.test" }],
    },
    `{"subscriber_ids":[${known}.0],"template_id":${template}}`,
    `{"subscriber_ids":[${known}],"template_id":9223372036854775808}`,
    `{"subscriber_ids":[${known}],"template_id":"${template}"}`,
    {
      subscriber_emails: Array.from({ length: 101 }, (_, i) => `r${i}@example.test`),
      template_id: template,
    },
    { subscriber_emails: ["a@example.test"], template_id: template, messenger: "postback" },
    { subscriber_emails: ["a@example.test"], template_id: template, kind: "marketing" },
    {
      subscriber_emails: ["a@example.test"],
      template_id: template,
      kind: "marketing",
      list_id: 999,
    },
    { subscriber_emails: ["a@example.test"], template_id: template, async: "yes" },
    { subscriber_external_id: "e", subscriber_emails: ["a@example.test"], template_id: template },
    [],
  ];
  for (const body of cases) {
    const response = await f.tx(body);
    expect([400, 413]).toContain(response.status);
  }
  // A literal __proto__ data key, as an ordinary JSON client would send it.
  expect(
    (
      await f.tx(
        `{"subscriber_ids":[${known}],"template_id":${template},"data":{"__proto__":{"a":1}}}`,
      )
    ).status,
  ).toBe(400);
  expect(f.count()).toBe(0);
  expect(f.sink.messages).toHaveLength(0);
  expect(f.errors).toEqual([]);
});

test("blocklisted subscribers and addresses never receive mail; marketing needs consent", async () => {
  const f = await open();
  const template = await f.template("<p>x</p>");
  const blocked = await f.subscriber("blocked@example.test", "Blocked", { status: "blocklisted" });
  for (const body of [
    { subscriber_id: blocked },
    { subscriber_emails: ["blocked@example.test"] },
    { subscriber_mode: "external", subscriber_emails: ["BLOCKED@example.test"] },
  ]) {
    const response = await f.tx({ ...body, template_id: template });
    expect(response.status).toBe(200);
    expect(response.body.data.sends[0].status).toBe("skipped");
  }
  const list = await f.json("/api/lists", "POST", {
    name: "news",
    type: "public",
    optin: "single",
  });
  const ada = await f.subscriber("ada@example.test", "Ada", {
    lists: [list.body.data.id],
    preconfirm_subscriptions: true,
  });
  const marketing = await f.tx({
    subscriber_id: ada,
    template_id: template,
    kind: "marketing",
    list_id: list.body.data.id,
  });
  expect(marketing.status).toBe(200);
  const row = (await f.json(`/api/sends/${marketing.body.data.sends[0].id}`)).body.data;
  // M2.4: a confirmed member receives it; a non-member is skipped (test/unsubscribe).
  expect(row).toMatchObject({
    status: "sent",
    skip_reason: null,
    kind: "marketing",
    list_id: list.body.data.id,
  });
  expect(f.sink.messages.map((m) => m.to[0])).toEqual(["ada@example.test"]);
  const stranger = await f.tx({
    subscriber_id: blocked,
    template_id: template,
    kind: "marketing",
    list_id: list.body.data.id,
  });
  expect(stranger.body.data.sends[0].status).toBe("skipped");
  expect(f.sink.messages).toHaveLength(1);
});

test("domain policy, external IDs and unknown addresses follow the native rules", async () => {
  const f = await open({ policy: { domainBlocklist: ["blocked.test"] } });
  const template = await f.template("<p>{{ subscriber.email }} {{ subscriber.external_id }}</p>");
  expect(
    (await f.tx({ subscriber_emails: ["x@blocked.test"], template_id: template })).status,
  ).toBe(400);
  await f.subscriber("linked@example.test", "Linked", { external_id: "app-1" });
  const linked = await f.tx({ subscriber_external_id: "app-1", template_id: template });
  expect(linked.status).toBe(200);
  expect(f.sink.messages[0]!.data).toContain("linked@example.test app-1");
  const stranger = await f.tx({ subscriber_email: "stranger@example.test", template_id: template });
  expect(stranger.status).toBe(200);
  expect(
    (await f.json(`/api/sends/${stranger.body.data.sends[0].id}`)).body.data.subscriber_id,
  ).toBeNull();
  expect(f.count()).toBe(2);
});

test("multipart attachments, limits and content types", async () => {
  const f = await open();
  const template = await f.template("<p>x</p>");
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    f.request("/api/tx", { method: "POST", headers: { ...f.sessionHeaders, ...headers }, body });
  const form = (
    files: File[],
    data = JSON.stringify({ subscriber_emails: ["a@example.test"], template_id: template }),
  ) => {
    const body = new FormData();
    body.set("data", data);
    for (const file of files) body.append("file", file);
    return body;
  };
  let response = await post(form([new File([new Uint8Array([0, 255, 10])], "dir/report.bin")]));
  expect(response.status).toBe(200);
  expect(f.sink.messages[0]!.data).toContain("filename=report.bin");
  expect(f.sink.messages[0]!.data).toContain("application/octet-stream");
  response = await post(form(Array.from({ length: 11 }, (_, i) => new File(["x"], `f${i}.txt`))));
  expect(response.status).toBe(400);
  response = await post(form([new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.bin")]));
  expect(response.status).toBe(413);
  response = await post(new Uint8Array(5 * 1024 * 1024 + 1), {
    "content-type": "application/json",
  });
  expect(response.status).toBe(413);
  const noData = new FormData();
  noData.append("file", new File(["x"], "a.txt"));
  expect((await post(noData)).status).toBe(400);
  expect((await post("<x/>", { "content-type": "application/xml" })).status).toBe(400);
  expect((await post("x", { "content-type": "text/plain" })).status).toBe(415);
  expect(
    (
      await post("subscriber_email=a@example.test", {
        "content-type": "application/x-www-form-urlencoded",
      })
    ).status,
  ).toBe(400);
  expect(f.count()).toBe(1);
});

test("a tx template embeds a stored image as an inline part, read for each request", async () => {
  const f = await open();
  const upload = async () => {
    const body = new FormData();
    body.append("file", new File([imagePng], "logo.png", { type: "image/png" }));
    const stored = await f.request("/api/media", {
      method: "POST",
      headers: f.sessionHeaders,
      body,
    });
    expect(stored.status).toBe(200);
    return (await stored.json()).data as { id: number };
  };
  const logo = await upload();
  const template = await f.template(
    `<img src="logo.png" data-embed="true"><img src="https://cdn.example.test/x.png" data-embed="true">`,
  );
  const send = () =>
    f.tx({
      subscriber_email: "receipt@example.test",
      subscriber_mode: "external",
      template_id: template,
    });
  expect((await send()).status).toBe(200);
  const text = f.sink.messages.at(-1)!.data.replace(/=\r\n/g, "").replace(/=3D/g, "=");
  const [cid] = [...text.matchAll(/^Content-ID: <([^>]+)>/gim)].map((m) => m[1]!);
  expect(text).toContain(`src="cid:${cid}"`);
  expect(text).toContain(`src="https://cdn.example.test/x.png"`);
  expect(text).toMatch(/^Content-Disposition: inline/im);

  // Nothing about a template is cached, so a deleted image stops being embedded at once.
  expect((await f.json(`/api/media/${logo.id}`, "DELETE")).status).toBe(200);
  expect((await send()).status).toBe(200);
  const after = f.sink.messages.at(-1)!.data.replace(/=\r\n/g, "").replace(/=3D/g, "=");
  expect(after).toContain(`src="logo.png"`);
  expect(after).not.toMatch(/^Content-ID:/im);

  // A row that lost its file refuses the request: nothing is journaled or sent.
  await upload();
  rmSync(join(f.directory, "uploads", "logo.png"));
  const sends = () => (f.db.query("SELECT count(*) AS n FROM sends").get() as { n: bigint }).n;
  const before = sends();
  expect((await send()).status).toBe(500);
  expect(sends()).toBe(before);
});

test("an embedded image counts toward what a durable send can hold", async () => {
  const f = await open();
  const body = new FormData();
  body.append("file", new File([new Uint8Array(5 * 1024 * 1024)], "large.png"));
  const stored = await f.request("/api/media", { method: "POST", headers: f.sessionHeaders, body });
  expect(stored.status).toBe(200);
  const template = await f.template(`<img src="large.png" data-embed="true">`);
  const refused = await f.tx({
    subscriber_email: "large@example.test",
    subscriber_mode: "external",
    template_id: template,
  });
  expect(refused.status).toBe(400);
  expect((f.db.query("SELECT count(*) AS n FROM sends").get() as { n: bigint }).n).toBe(0n);
});

test("permission, CSRF and origin use the existing authentication", async () => {
  const f = await open();
  const template = await f.template("<p>x</p>");
  const body = { subscriber_emails: ["a@example.test"], template_id: template };
  expect((await f.tx(body, {})).status).toBe(403);
  expect((await f.tx(body, { cookie: f.sessionHeaders.cookie })).status).toBe(403);
  expect((await f.tx(body, { ...f.sessionHeaders, origin: "https://evil.test" })).status).toBe(403);
  const denied = await apiUser(f, ["templates:get"]);
  expect((await f.tx(body, denied.headers)).status).toBe(403);
  const allowed = await apiUser(f, ["tx:send"]);
  expect((await f.tx(body, allowed.headers)).status).toBe(200);
  expect(f.count()).toBe(1);
});

test("a credential revoked while the body is held writes and sends nothing", async () => {
  const f = await open();
  const template = await f.template("<p>x</p>");
  const user = await apiUser(f, ["tx:send"]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const payload = JSON.stringify({ subscriber_emails: ["a@example.test"], template_id: template });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(payload.slice(0, 10)));
      await gate;
      controller.enqueue(new TextEncoder().encode(payload.slice(10)));
      controller.close();
    },
  });
  const pending = f.request("/api/tx", {
    method: "POST",
    headers: { ...user.headers, "content-type": "application/json" },
    body: stream,
  });
  await Bun.sleep(10);
  expect((await f.json(`/api/users/${user.id}`, "DELETE")).status).toBe(200);
  release();
  expect((await pending).status).toBe(403);
  expect(f.count()).toBe(0);
  expect(f.sink.messages).toHaveLength(0);
});

async function settle(f: TxFixture, done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) {
    f.clock.advance(0);
    await Bun.sleep(5);
  }
}

test("blocklisted Cc and Bcc from SMTP settings headers are removed too", async () => {
  const f = await open({
    emailHeaders: [
      { Cc: "Blocked <BLOCKED@example.test>, archive@example.test" },
      { Bcc: "blocked@example.test" },
    ],
  });
  const template = await f.template("<p>x</p>");
  await f.subscriber("blocked@example.test", "Blocked", { status: "blocklisted" });
  const response = await f.tx({ subscriber_email: "ok@example.test", template_id: template });
  expect(response.status).toBe(200);
  expect(response.body.data.sends[0].status).toBe("sent");
  expect(f.sink.messages.map((m) => m.to)).toEqual([["ok@example.test", "archive@example.test"]]);
  expect(f.sink.messages[0]!.data).toMatch(/^Cc: archive@example\.test$/m);
  expect(f.sink.messages[0]!.data.toLowerCase()).not.toContain("blocked@");
});

test("blocklisted Cc and Bcc addresses are removed from the envelope and headers", async () => {
  const f = await open();
  const template = await f.template("<p>x</p>");
  await f.subscriber("blocked@example.test", "Blocked", { status: "blocklisted" });
  const cc = await f.tx({
    subscriber_email: "ok@example.test",
    template_id: template,
    headers: [{ Cc: "Blocked <BLOCKED@example.test>, copy@example.test" }],
  });
  expect(cc.status).toBe(200);
  expect(cc.body.data.sends[0].status).toBe("sent");
  const bcc = await f.tx({
    subscriber_email: "ok2@example.test",
    template_id: template,
    headers: [{ bcc: "blocked@example.test" }],
  });
  expect(bcc.body.data.sends[0].status).toBe("sent");
  expect(f.sink.messages.map((m) => m.to)).toEqual([
    ["ok@example.test", "copy@example.test"],
    ["ok2@example.test"],
  ]);
  expect(f.sink.messages[0]!.data).toMatch(/^Cc: copy@example\.test$/m);
  for (const m of f.sink.messages) expect(m.data.toLowerCase()).not.toContain("blocked@");
  for (const response of [cc, bcc]) {
    const row = (await f.json(`/api/sends/${response.body.data.sends[0].id}`)).body.data;
    // A safe count, never the removed address.
    expect(row.skip_reason).toBe("copies_blocklisted:1");
    expect(JSON.stringify(row)).not.toContain("blocked@");
  }
  // A blocklisted primary recipient is still skipped as a whole.
  const primary = await f.tx({
    subscriber_email: "blocked@example.test",
    template_id: template,
    headers: [{ Cc: "copy@example.test" }],
  });
  expect(primary.body.data.sends[0].status).toBe("skipped");
  expect(f.sink.messages).toHaveLength(2);
});

test("queued unlinked recipients and copies blocklisted later are skipped after restart", async () => {
  const f = await open();
  const template = await f.template("<p>x</p>");
  const later = await f.subscriber("later@example.test");
  const copy = await f.subscriber("late-copy@example.test");
  await f.stopOutbox();
  const response = await f.tx({
    subscriber_mode: "external",
    subscriber_emails: ["first@example.test", "later@example.test"],
    template_id: template,
    headers: [{ Bcc: "late-copy@example.test" }],
    async: true,
  });
  expect(response.body.data.sends.map((s: { status: string }) => s.status)).toEqual([
    "queued",
    "queued",
  ]);
  for (const id of [later, copy])
    expect((await f.json(`/api/subscribers/${id}/blocklist`, "PUT", {})).status).toBe(200);
  f.restartOutbox();
  const [first, second] = response.body.data.sends as { id: number }[];
  const status = async (id: number) => (await f.json(`/api/sends/${id}`)).body.data;
  await settle(f, () => f.sink.messages.length > 0);
  await settle(f, () => false);
  expect(await status(first!.id)).toMatchObject({
    status: "sent",
    skip_reason: "copies_blocklisted:1",
  });
  expect(await status(second!.id)).toMatchObject({
    status: "skipped",
    skip_reason: "subscriber_blocklisted",
  });
  expect(f.sink.messages.map((m) => m.to)).toEqual([["first@example.test"]]);
});

test("manual resend rechecks the blocklist for unlinked recipients", async () => {
  let rejecting = true;
  const f = await open({ reject: () => rejecting });
  const template = await f.template("<p>x</p>");
  const id = await f.subscriber("stranger@example.test");
  const response = await f.tx({
    subscriber_mode: "external",
    subscriber_email: "stranger@example.test",
    template_id: template,
  });
  const row = response.body.data.sends[0];
  expect(row.status).toBe("failed");
  expect((await f.json(`/api/subscribers/${id}/blocklist`, "PUT", {})).status).toBe(200);
  rejecting = false;
  expect((await f.json(`/api/sends/${row.id}/resend`, "POST")).status).toBe(409);
  await settle(f, () => false);
  expect(f.sink.messages).toHaveLength(0);
  expect(f.count()).toBe(1);
});

test("an idempotent retry replays after its template or subscriber changes", async () => {
  const f = await open();
  const retry = async (body: object, mutate: () => Promise<number>) => {
    const first = await f.tx(body);
    expect(first.status).toBe(200);
    expect(first.body.data.sends[0].status).toBe("sent");
    const sent = f.sink.messages.length;
    const rows = f.count();
    expect(await mutate()).toBe(200);
    const again = await f.tx(body);
    expect(again.status).toBe(200);
    expect(again.body.data.sends).toEqual(first.body.data.sends);
    expect(f.sink.messages).toHaveLength(sent);
    expect(f.count()).toBe(rows);
    // A different request under the same key is still a conflict.
    expect((await f.tx({ ...body, data: { other: true } })).status).toBe(409);
  };
  const deleted = await f.template("<p>x</p>");
  await retry(
    { subscriber_email: "a@example.test", template_id: deleted, idempotency_key: "t-del" },
    async () => (await f.json(`/api/templates/${deleted}`, "DELETE")).status,
  );
  const template = await f.template("<p>x</p>");
  const person = await f.subscriber("gone@example.test");
  await retry(
    { subscriber_id: person, template_id: template, idempotency_key: "s-del" },
    async () => (await f.json(`/api/subscribers/${person}`, "DELETE")).status,
  );
  const changed = await f.template("<p>x</p>", "Hello");
  await retry(
    {
      subscriber_email: "c@example.test",
      template_id: changed,
      data: { nl: "\n" },
      idempotency_key: "t-change",
    },
    async () =>
      (
        await f.json(`/api/templates/${changed}`, "PUT", {
          name: "fixture",
          type: "tx",
          subject: "{{ data.nl }}",
          body: "<p>x</p>",
        })
      ).status,
  );
  // The changed template really no longer renders for a new request.
  expect(
    (await f.tx({ subscriber_email: "c@example.test", template_id: changed, data: { nl: "\n" } }))
      .status,
  ).toBe(400);
});
