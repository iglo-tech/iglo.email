// M2.5 behavior through the public HTTP boundary and the SMTP sink, on the injected clock.
// Upstream-compared results are in test/contract/public.ts.
import { afterEach, expect, test } from "bun:test";
import { createRateLimit } from "@/public/rate-limit";
import { publicFixture, type PublicFixture } from "@/test/public/fixture";
import { TestClock } from "@/test/server/fixture";

const fixtures: PublicFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await publicFixture();
  fixtures.push(f);
  return f;
}
const dummy = "00000000-0000-0000-0000-000000000000";
const minute = 60_000;
const signup = (email: string, uuid: string) => JSON.stringify({ email, list_uuids: [uuid] });
const api = (f: PublicFixture, email: string, uuid: string, peer = "203.0.113.9") =>
  f.peer("/api/public/subscription", peer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: signup(email, uuid),
  });
const form = (values: Record<string, string>) => new URLSearchParams(values).toString();

test("each limit is per peer, answers 429 and reopens on the clock", async () => {
  const f = await open();
  const list = await f.list("News");
  const bad = form({ email: "bad", l: list.uuid });
  for (let i = 0; i < 5; i++)
    expect((await f.post("/subscription/form", bad, "192.0.2.7")).status).toBe(400);
  const limited = await f.post("/subscription/form", bad, "192.0.2.7");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
  expect(limited.headers.get("content-type")).toContain("text/html");
  const json = await f.peer("/api/public/subscription", "192.0.2.7", { method: "POST" });
  expect(json.status).toBe(429);
  expect(await json.json()).toEqual({ message: "Too many requests" });
  // Another peer and the unsubscribe budget are unaffected.
  expect((await f.post("/subscription/form", bad, "192.0.2.8")).status).toBe(400);
  f.clock.advance(minute);
  expect((await f.post("/subscription/form", bad, "192.0.2.7")).status).toBe(400);
});

test("opt-in, unsubscribe and privacy POSTs are limited too", async () => {
  const f = await open();
  const missing = "11111111-1111-4111-8111-111111111111";
  for (const path of [
    `/subscription/optin/${missing}`,
    `/subscription/${dummy}/${missing}`,
    `/subscription/export/${missing}`,
  ]) {
    for (let i = 0; i < 5; i++) expect((await f.post(path)).status).toBe(404);
    expect((await f.post(path)).status).toBe(429);
  }
  // Export and wipe share their budget.
  expect((await f.post(`/subscription/wipe/${missing}`)).status).toBe(429);
});

test("the limiter stays bounded without locking out new peers", () => {
  const clock = new TestClock();
  const check = createRateLimit(clock, { limit: 1, windowMs: minute, maxPeers: 3 });
  expect(check("a")).toBe(0);
  expect(check("a")).toBeGreaterThan(0);
  for (const peer of ["b", "c", "d"]) expect(check(peer)).toBe(0);
  // "a" was evicted as the oldest, so a flood cannot grow the table or block anyone.
  expect(check("a")).toBe(0);
  expect(check("d")).toBeGreaterThan(0);
});

test("a double opt-in signup gets one mail, again after the throttle expires", async () => {
  const f = await open();
  const list = await f.list("Double", "public", "double");
  expect(await (await api(f, "ana@example.test", list.uuid)).json()).toEqual({
    data: { has_optin: true },
  });
  expect(await (await api(f, "ana@example.test", list.uuid)).json()).toEqual({
    data: { has_optin: true },
  });
  await f.drain();
  expect(f.mailTo("ana@example.test")).toHaveLength(1);
  f.clock.advance(10 * minute);
  await api(f, "ana@example.test", list.uuid, "203.0.113.10");
  await f.drain();
  expect(f.mailTo("ana@example.test")).toHaveLength(2);
  // The mail is a journaled transactional send.
  const rows = f.db.query("SELECT kind, source, status FROM sends").all();
  expect(rows).toEqual([
    { kind: "transactional", source: "tx", status: "sent" },
    { kind: "transactional", source: "tx", status: "sent" },
  ]);
});

test("a signup answer never reveals an existing subscriber", async () => {
  const f = await open();
  const list = await f.list("Double", "public", "double");
  const known = await f.subscriber("known@example.test", "Known", {
    lists: [list.id],
    preconfirm_subscriptions: true,
  });
  const blocked = await f.subscriber("blocked@example.test");
  await f.json(`/api/subscribers/${blocked}/blocklist`, "PUT");
  const answers = [];
  for (const email of ["new@example.test", "known@example.test", "blocked@example.test"]) {
    const response = await api(f, email, list.uuid);
    answers.push([response.status, await response.text()]);
  }
  expect(answers[1]).toEqual(answers[0]!);
  expect(answers[2]).toEqual(answers[0]!);
  const posts = [];
  for (const email of ["new2@example.test", "known@example.test"]) {
    const response = await f.fresh("/subscription/form", form({ email, l: list.uuid }));
    posts.push(await response.text());
  }
  expect(posts[1]).toBe(posts[0]!);
  expect(await f.status(known, list.id)).toBe("confirmed");
  await f.drain();
  expect(f.mailTo("blocked@example.test")).toHaveLength(0);
});

test("GET never confirms and a POST cannot reverse an unsubscribe", async () => {
  const f = await open();
  const double = await f.list("Double", "public", "double");
  const gone = await f.list("Gone", "public", "double");
  const id = await f.subscriber("mia@example.test", "Mia", { lists: [double.id, gone.id] });
  const { uuid } = (await f.json(`/api/subscribers/${id}`)).body.data;
  await f.json(`/api/subscribers/lists/${id}`, "PUT", {
    action: "unsubscribe",
    target_list_ids: [gone.id],
  });
  f.overrides.showOptinPage = false;
  for (const query of ["", "?confirm=true"]) {
    const page = await f.peer(`/subscription/optin/${uuid}${query}`, "192.0.2.20");
    expect(page.status).toBe(200);
    expect(await f.status(id, double.id)).toBe("unconfirmed");
  }
  const body = `confirm=true&l=${double.uuid}&l=${gone.uuid}`;
  expect((await f.fresh(`/subscription/optin/${uuid}`, body)).status).toBe(200);
  expect(await f.status(id, double.id)).toBe("confirmed");
  expect(await f.status(id, gone.id)).toBe("unsubscribed");
});

test("preferences commit with their effects, or not at all", async () => {
  const f = await open();
  const keep = await f.list("Keep");
  const drop = await f.list("Drop");
  const hidden = await f.list("Hidden", "private");
  const id = await f.subscriber("pat@example.test", "Pat", {
    lists: [keep.id, drop.id, hidden.id],
    preconfirm_subscriptions: true,
  });
  const { uuid } = (await f.json(`/api/subscribers/${id}`)).body.data;
  const path = `/subscription/${dummy}/${uuid}`;
  const body = form({ manage: "true", name: "Renamed", l: keep.uuid });
  f.failEffects(true);
  expect((await f.fresh(path, body)).status).toBe(500);
  expect((await f.json(`/api/subscribers/${id}`)).body.data.name).toBe("Pat");
  expect(await f.status(id, drop.id)).toBe("confirmed");
  f.failEffects(false);
  f.calls.length = 0;
  expect((await f.fresh(path, body)).status).toBe(200);
  expect((await f.json(`/api/subscribers/${id}`)).body.data.name).toBe("Renamed");
  expect(await f.status(id, drop.id)).toBe("unsubscribed");
  expect(await f.status(id, hidden.id)).toBe("confirmed");
  expect(f.calls).toEqual([{ inTransaction: true, listIds: [BigInt(drop.id)] }]);
});

test("send pages offer the same preferences, bound to their subscriber", async () => {
  const f = await open();
  const news = await f.list("News");
  const other = await f.list("Other");
  const id = await f.subscriber("sam@example.test", "Sam", {
    lists: [news.id, other.id],
    preconfirm_subscriptions: true,
  });
  const stranger = await f.subscriber("eve@example.test", "Eve");
  const { uuid } = (await f.json(`/api/subscribers/${id}`)).body.data;
  const eve = (await f.json(`/api/subscribers/${stranger}`)).body.data.uuid;
  const template = await f.template(`<a href="{{ unsubscribe_url }}">x</a>`, "Hi");
  const sent = await f.tx({
    subscriber_id: id,
    template_id: template,
    kind: "marketing",
    list_id: news.id,
    data: {},
  });
  const send = sent.body.data.sends[0].uuid;
  const path = `/m/${send}/unsubscribe/${uuid}`;
  const page = await f.peer(`${path}?manage=true`, "192.0.2.30");
  const text = await page.text();
  expect(text).toContain('class="manage-form"');
  expect(text).toContain(`value="${other.uuid}"`);
  const body = form({ manage: "true", name: "Sam Two", l: news.uuid });
  expect((await f.post(`/m/${send}/unsubscribe/${eve}`, body)).status).toBe(404);
  expect((await f.post(path, body)).status).toBe(200);
  expect(await f.status(id, other.id)).toBe("unsubscribed");
  expect(await f.status(id, news.id)).toBe("confirmed");
});

test("export mails native sections; the response holds nothing personal", async () => {
  const f = await open();
  const id = await f.subscriber("noa@example.test", "Noa");
  const { uuid } = (await f.json(`/api/subscribers/${id}`)).body.data;
  const response = await f.fresh(`/subscription/export/${uuid}`);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("noa@example.test");
  await f.drain();
  const [message] = f.mailTo("noa@example.test");
  expect(message?.data).toContain("filename=data.json");
  const part = /filename=data\.json\r\n\r\n([\s\S]*?)\r\n--/.exec(message!.data)![1]!;
  const data = JSON.parse(Buffer.from(part, "base64").toString("utf8"));
  expect(Object.keys(data).sort()).toEqual(
    ["campaign_views", "events", "link_clicks", "profile", "sends", "subscriptions"].sort(),
  );
  f.overrides.exportable = ["profile"];
  await f.fresh(`/subscription/export/${uuid}`);
  await f.drain();
  const second = f.mailTo("noa@example.test")[1]!;
  const only = /filename=data\.json\r\n\r\n([\s\S]*?)\r\n--/.exec(second.data)![1]!;
  expect(Object.keys(JSON.parse(Buffer.from(only, "base64").toString("utf8")))).toEqual([
    "profile",
  ]);
});

test("wipe removes the subscriber and memberships in one step", async () => {
  const f = await open();
  const list = await f.list("News");
  const id = await f.subscriber("oli@example.test", "Oli", { lists: [list.id] });
  const { uuid } = (await f.json(`/api/subscribers/${id}`)).body.data;
  expect((await f.fresh(`/subscription/wipe/${uuid}`)).status).toBe(200);
  expect((await f.json(`/api/subscribers/${id}`)).status).toBe(400);
  expect(
    f.db.query("SELECT count(*) AS n FROM subscriber_lists WHERE subscriber_id = ?").get(id),
  ).toEqual({ n: 0n });
});

test("view in browser writes nothing and escapes subscriber data", async () => {
  const f = await open();
  const list = await f.list("News");
  const email = "xss@example.test";
  await api(f, email, list.uuid);
  const row = f.owners.subscribers.byEmail(email)!;
  f.db.run("UPDATE subscribers SET name = ? WHERE id = ?", ["<script>x</script>", row.id]);
  const campaign = f.db
    .query(
      `INSERT INTO campaigns (uuid, name, subject, from_email, body, content_type, status, type, messenger, max_subscriber_id, last_subscriber_id, archive, archive_slug, archive_meta)
       VALUES (?, 'c', 'Hello', 'a@b.test', ?, 'html', 'finished', 'regular', 'email', 0, 0, 1, 'hello', ?) RETURNING id`,
    )
    .get(
      "22222222-2222-4222-8222-222222222222",
      `{{ subscriber.name }} {{ "https://example.test/a" | track_link }} {{ track_view }}`,
      JSON.stringify({ name: "Sample" }),
    ) as { id: bigint };
  const counts = () =>
    f.db
      .query(
        "SELECT (SELECT count(*) FROM links) AS links, (SELECT count(*) FROM campaign_views) AS views",
      )
      .get();
  const before = counts();
  const view = await f.peer(
    `/campaign/22222222-2222-4222-8222-222222222222/${row.uuid}`,
    "192.0.2.40",
  );
  expect(view.status).toBe(200);
  const body = await view.text();
  expect(body).not.toContain("<script>x");
  expect(body).toContain("&lt;script&gt;");
  expect(view.headers.get("content-security-policy")).toContain("sandbox");
  expect(counts()).toEqual(before);
  // The archive shows only the sample subscriber.
  const archived = await (await f.peer("/archive/hello", "192.0.2.40")).text();
  expect(archived).toContain("Sample");
  expect(archived).not.toContain(row.uuid);
  expect(archived).not.toContain("script&gt;");
  expect(counts()).toEqual(before);
  expect(campaign.id).toBeGreaterThan(0n);
});

test("malformed public input fails safely with no write", async () => {
  const f = await open();
  const list = await f.list("News");
  const count = () =>
    (f.db.query("SELECT count(*) AS n FROM subscribers").get() as { n: bigint }).n;
  const before = count();
  const post = (body: string, type: string) =>
    f.peer("/api/public/subscription", `192.0.2.${50 + before.toString().length}`, {
      method: "POST",
      headers: { "content-type": type },
      body,
    });
  const json = "application/json";
  for (const [body, type] of [
    ["{", json],
    ["[]", json],
    ['{"email":1,"list_uuids":["a"]}', json],
    ['{"email":"a@b.test","list_uuids":"x"}', json],
    ['{"email":"a@b.test","list_uuids":[1]}', json],
    ['{"email":"a@b.test","list_uuids":["not-a-uuid"]}', json],
    ["x", "text/plain"],
    ["--x\r\nbad", "multipart/form-data; boundary=x"],
  ] as const) {
    f.clock.advance(minute);
    expect((await post(body, type)).status).toBe(400);
  }
  f.clock.advance(minute);
  expect((await post("x".repeat(70_000), json)).status).toBe(413);
  f.clock.advance(minute);
  expect(
    (await f.fresh("/subscription/form", `email=a@b.test&name=%00&l=${list.uuid}`)).status,
  ).toBe(400);
  expect(count()).toBe(before);
  expect(f.errors).toEqual([]);
});

test("an enabled captcha fails closed on the form", async () => {
  const f = await open();
  const list = await f.list("News");
  f.overrides.captcha = true;
  const response = await f.fresh(
    "/subscription/form",
    form({ email: "bot@example.test", l: list.uuid }),
  );
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("Invalid CAPTCHA.");
});

test("a public signup never changes an existing stored profile", async () => {
  const f = await open();
  const list = await f.list("News");
  const id = await f.subscriber("ivy@example.test", "Ivy", { attribs: { a: 1 } });
  await f.fresh("/subscription/form", form({ email: "IVY@example.test", name: "Z", l: list.uuid }));
  const stored = (await f.json(`/api/subscribers/${id}`)).body.data;
  expect([stored.name, stored.attribs]).toEqual(["Ivy", { a: 1 }]);
  expect(await f.status(id, list.id)).toBe("unconfirmed");
});
