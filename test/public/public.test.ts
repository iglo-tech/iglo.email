// M2.5 behavior through the public HTTP boundary and the SMTP sink, on the injected clock.
// Upstream-compared results are in test/contract/public.ts.
import { afterEach, expect, test } from "bun:test";
import { createRateLimit, createThrottle } from "@/public/rate-limit";
import { createClientAddress } from "@/server/client-address";
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
  const json = await f.peer("/api/public/subscription", "192.0.2.7", {
    method: "POST",
  });
  expect(json.status).toBe(429);
  expect(json.headers.get("retry-after")).toBe("60");
  expect(await json.json()).toEqual({ message: "Too many requests" });
  // Another peer and the unsubscribe budget are unaffected.
  expect((await f.post("/subscription/form", bad, "192.0.2.8")).status).toBe(400);
  f.clock.advance(minute);
  expect((await f.post("/subscription/form", bad, "192.0.2.7")).status).toBe(400);
});

const forwarded = (f: PublicFixture, peer: string, chain: string) =>
  f.peer("/api/public/subscription", peer, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": chain },
    body: "{}",
  });

test("a forwarded header from an untrusted peer is ignored, however it varies", async () => {
  const f = await open();
  f.overrides.trustedProxies = ["10.0.0.0/8"];
  for (let i = 0; i < 5; i++)
    expect((await forwarded(f, "192.0.2.50", `203.0.113.${i}`)).status).toBe(400);
  expect((await forwarded(f, "192.0.2.50", "203.0.113.99")).status).toBe(429);
  expect((await forwarded(f, "192.0.2.51", "203.0.113.99")).status).toBe(400);
});

test("behind trusted proxies one visitor exhausts only their own budget", async () => {
  const f = await open();
  f.overrides.trustedProxies = ["10.0.0.0/8", "2001:db8::/32"];
  for (let i = 0; i < 5; i++)
    expect((await forwarded(f, "10.0.0.1", "203.0.113.1")).status).toBe(400);
  expect((await forwarded(f, "10.0.0.1", "203.0.113.1")).status).toBe(429);
  // Another visitor through the same proxy still has theirs.
  expect((await forwarded(f, "10.0.0.1", "203.0.113.2")).status).toBe(400);
  // A visitor can't escape by prepending entries: the walk stops at the first untrusted hop.
  expect((await forwarded(f, "10.0.0.1", "8.8.8.8, 203.0.113.1")).status).toBe(429);
  // Several trusted hops, in either family, and an IPv4-mapped transport peer.
  expect((await forwarded(f, "10.0.0.2", "203.0.113.1, 10.0.0.1")).status).toBe(429);
  expect((await forwarded(f, "2001:db8::1", "203.0.113.1, 10.9.9.9")).status).toBe(429);
  expect((await forwarded(f, "::ffff:10.0.0.3", "203.0.113.1")).status).toBe(429);
});

test("the client is the nearest valid hop when a chain is unusable", () => {
  const client = createClientAddress(() => ["10.0.0.0/8"]);
  const at = (peer: string, chain: string | null) =>
    client({
      peerAddress: peer,
      request: new Request(
        "http://x/",
        chain === null ? {} : { headers: { "x-forwarded-for": chain } },
      ),
    });
  expect(at("10.0.0.1", null)).toBe("10.0.0.1");
  expect(at("10.0.0.1", "")).toBe("10.0.0.1");
  expect(at("10.0.0.1", "203.0.113.1, nonsense")).toBe("10.0.0.1");
  expect(at("10.0.0.1", "nonsense, 203.0.113.1")).toBe("203.0.113.1");
  expect(at("10.0.0.1", "203.0.113.1, nonsense, 10.0.0.2")).toBe("10.0.0.2");
  expect(at("10.0.0.1", "10.0.0.3, 10.0.0.2")).toBe("10.0.0.3");
  expect(at("10.0.0.1", "2001:DB8::1")).toBe("2001:db8::1");
  expect(at("::ffff:192.0.2.1", "203.0.113.1")).toBe("192.0.2.1");
  expect(at("unknown", "203.0.113.1")).toBe("unknown");
});

test("trusted origins can read and post to the public API, as upstream", async () => {
  const f = await open();
  const origin = { origin: "https://website.example.test" };
  const preflight = {
    ...origin,
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  };
  const cors = (response: Response) =>
    Object.fromEntries(
      [...response.headers].filter(([name]) => /^(vary|access-control-)/.test(name)),
    );
  // Nothing without a trusted URL.
  expect(
    (await f.peer("/api/public/lists", "192.0.2.1", { headers: origin })).headers.get("vary"),
  ).toBeNull();
  expect(
    (
      await f.peer("/api/public/subscription", "192.0.2.1", {
        method: "OPTIONS",
        headers: preflight,
      })
    ).status,
  ).toBe(404);

  f.overrides.trustedUrls = [
    "https://website.example.test/subscribe",
    "http://Other.example:8080/x",
  ];
  const read = await f.peer("/api/public/lists", "192.0.2.1", { headers: origin });
  expect(read.status).toBe(200);
  expect(cors(read)).toEqual({
    "access-control-allow-origin": "https://website.example.test",
    vary: "Origin",
  });
  const allowed = await f.peer("/api/public/subscription", "192.0.2.1", {
    method: "OPTIONS",
    headers: preflight,
  });
  expect(allowed.status).toBe(204);
  expect(cors(allowed)).toEqual({
    "access-control-allow-origin": "https://website.example.test",
    "access-control-allow-methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
    "access-control-allow-headers": "Origin,Content-Type,Accept,Authorization",
    vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  });
  // Origins match case-insensitively and answer in their configured spelling.
  const spelled = await f.peer("/api/public/lists", "192.0.2.1", {
    headers: { origin: "http://other.example:8080" },
  });
  expect(spelled.headers.get("access-control-allow-origin")).toBe("http://Other.example:8080");
  // A rejected request still carries the headers, so a browser can read the error.
  const rejected = await f.peer("/api/public/subscription", "192.0.2.1", {
    method: "POST",
    headers: { ...origin, "content-type": "application/json" },
    body: "{}",
  });
  expect(rejected.status).toBe(400);
  expect(rejected.headers.get("access-control-allow-origin")).toBe("https://website.example.test");
  // Foreign and origin-less requests get no grant.
  const foreign = await f.peer("/api/public/subscription", "192.0.2.1", {
    method: "OPTIONS",
    headers: { ...preflight, origin: "https://evil.example" },
  });
  expect(foreign.status).toBe(204);
  expect(cors(foreign)).toEqual({ vary: "Origin" });
  expect(cors(await f.peer("/api/public/lists", "192.0.2.1"))).toEqual({ vary: "Origin" });
  // An OPTIONS that is not a preflight is routed normally.
  expect(
    (await f.peer("/api/public/lists", "192.0.2.1", { method: "OPTIONS", headers: origin })).status,
  ).toBe(404);
  f.overrides.trustedUrls = ["*"];
  expect(
    (await f.peer("/api/public/lists", "192.0.2.1", { headers: origin })).headers.get(
      "access-control-allow-origin",
    ),
  ).toBe("*");
  // Scoped to the public API: other routes gain no cross-origin surface.
  expect(cors(await f.peer("/health", "192.0.2.1", { headers: origin }))).toEqual({});
  expect(cors(await f.peer("/api/sends", "192.0.2.1", { headers: origin }))).toEqual({});
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
  const check = createRateLimit(clock, {
    limit: 1,
    windowMs: minute,
    maxPeers: 3,
  });
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

test("one address gets one opt-in mail per window, however many lists it joins", async () => {
  const f = await open();
  const address = "flood@example.test";
  for (let i = 0; i < 8; i++) {
    const list = await f.list(`Flood ${i}`, "public", "double");
    expect((await api(f, address, list.uuid, `203.0.113.${20 + i}`)).status).toBe(200);
  }
  await f.drain();
  expect(f.mailTo(address)).toHaveLength(1);
  // Letter case is the same address, and the budget reopens on the clock.
  const late = await f.list("Late", "public", "double");
  await api(f, "FLOOD@example.test", late.uuid, "203.0.113.40");
  await f.drain();
  expect(f.mailTo(address)).toHaveLength(1);
  f.clock.advance(10 * minute);
  await api(f, address, late.uuid, "203.0.113.41");
  await f.drain();
  expect(f.mailTo(address)).toHaveLength(2);
});

test("every subscriber state answers alike and mail is prepared after the response", async () => {
  const f = await open();
  const list = await f.list("Double", "public", "double");
  await f.subscriber("confirmed@example.test", "Confirmed", {
    lists: [list.id],
    preconfirm_subscriptions: true,
  });
  await f.subscriber("pending@example.test", "Pending", { lists: [list.id] });
  const blocked = await f.subscriber("blocked@example.test");
  await f.json(`/api/subscribers/${blocked}/blocklist`, "PUT");
  await f.drain();
  const before = f.count();
  const answers = [];
  for (const email of [
    "fresh@example.test",
    "pending@example.test",
    "confirmed@example.test",
    "blocked@example.test",
  ]) {
    const response = await api(f, email, list.uuid);
    answers.push(await response.text());
    // Nothing state-dependent ran before the answer: no state has a send yet.
    expect(f.count()).toBe(before);
  }
  expect(new Set(answers).size).toBe(1);
  expect(f.mail.queued()).toBe(4);
  await f.drain();
  expect(f.mail.queued()).toBe(0);
  expect(f.mailTo("fresh@example.test")).toHaveLength(1);
  expect(f.mailTo("pending@example.test")).toHaveLength(1);
  expect(f.mailTo("confirmed@example.test")).toHaveLength(0);
  expect(f.mailTo("blocked@example.test")).toHaveLength(0);
});

test("the opt-in queue is bounded and a wipe beats a queued signup", async () => {
  const f = await open();
  const list = await f.list("Double", "public", "double");
  await api(f, "gone@example.test", list.uuid);
  await f.fresh(`/subscription/wipe/${f.owners.subscribers.byEmail("gone@example.test")!.uuid}`);
  await f.drain();
  expect(f.mailTo("gone@example.test")).toHaveLength(0);
  for (let id = 1n; id <= 6000n; id++) f.mail.acceptSignup(id);
  expect(f.mail.queued()).toBe(5000);
});

test("a full opt-in budget refuses new keys instead of mailing unrecorded", () => {
  const clock = new TestClock();
  const allow = createThrottle(clock, 10 * minute, 2);
  expect(allow("a")).toBe(true);
  expect(allow("b")).toBe(true);
  for (let i = 0; i < 3; i++) expect(allow("c")).toBe(false);
  expect(allow("a")).toBe(false);
  clock.advance(10 * minute);
  expect(allow("c")).toBe(true);
  expect(allow("c")).toBe(false);
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
  const id = await f.subscriber("mia@example.test", "Mia", {
    lists: [double.id, gone.id],
  });
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
  const id = await f.subscriber("oli@example.test", "Oli", {
    lists: [list.id],
  });
  const { uuid } = (await f.json(`/api/subscribers/${id}`)).body.data;
  expect((await f.fresh(`/subscription/wipe/${uuid}`)).status).toBe(200);
  expect((await f.json(`/api/subscribers/${id}`)).status).toBe(400);
  expect(
    f.db.query("SELECT count(*) AS n FROM subscriber_lists WHERE subscriber_id = ?").get(id),
  ).toEqual({ n: 0n });
});

const insertSend = (f: PublicFixture, status: string, to: string, subscriber: number | null) =>
  (
    f.db
      .query(
        `INSERT INTO sends(uuid, source, kind, subscriber_id, to_email, status, smtp_message_id, payload, created_at)
         VALUES (?, 'tx', 'transactional', ?, ?, ?, '<m@fixture.test>', ?, ?) RETURNING id`,
      )
      .get(
        crypto.randomUUID(),
        subscriber,
        to,
        status,
        JSON.stringify({ message: { to: [to], subject: "Personal" } }),
        f.clock.now().toISOString(),
      ) as { id: bigint }
  ).id;
const sendCounts = (f: PublicFixture) =>
  f.db.query("SELECT status, count(*) AS n FROM sends GROUP BY status ORDER BY status").all();

test("wipe anonymizes retained sends and cancels queued ones in its transaction", async () => {
  const f = await open();
  const address = "wipe@example.test";
  const id = await f.subscriber(address, "Wipe Me");
  const { uuid } = (await f.json(`/api/subscribers/${id}`)).body.data;
  const other = insertSend(f, "sent", "kept@example.test", null);
  const rows = Object.fromEntries(
    ["queued", "sending", "sent", "failed", "skipped", "unknown"].map((status) => [
      status,
      insertSend(f, status, address, id),
    ]),
  );
  // An unlinked transactional recipient with the same address, in any letter case.
  const unlinked = insertSend(f, "sent", "Wipe@Example.Test", null);

  // A failed deletion leaves everything as it was.
  f.db.run(
    "CREATE TRIGGER wipe_fails BEFORE DELETE ON subscribers BEGIN SELECT RAISE(ABORT, 'no'); END",
  );
  const before = f.db.query("SELECT * FROM sends ORDER BY id").all();
  expect((await f.fresh(`/subscription/wipe/${uuid}`)).status).toBe(500);
  expect(f.db.query("SELECT * FROM sends ORDER BY id").all()).toEqual(before);
  f.db.run("DROP TRIGGER wipe_fails");

  const counts = sendCounts(f) as { status: string; n: bigint }[];
  expect((await f.fresh(`/subscription/wipe/${uuid}`)).status).toBe(200);
  for (const send of [...Object.values(rows), unlinked]) {
    const { data } = (await f.json(`/api/sends/${send}`)).body;
    expect(data.to_email).toBe("");
    expect(data.subscriber_id).toBeNull();
    expect(JSON.stringify(data)).not.toContain("xample.test");
  }
  expect(
    f.db.query("SELECT count(*) AS n FROM sends WHERE payload IS NOT NULL AND id != ?").get(other),
  ).toEqual({ n: 0n });
  // Row counts and settled statuses stay; only queued mail is cancelled.
  const after = f.db.query("SELECT id, status, skip_reason FROM sends ORDER BY id").all() as {
    id: bigint;
    status: string;
    skip_reason: string | null;
  }[];
  expect(after).toHaveLength(before.length);
  expect(after.find((row) => row.id === rows.queued)).toEqual({
    id: rows.queued!,
    status: "skipped",
    skip_reason: "subscriber_unavailable",
  });
  expect(sendCounts(f)).toEqual(
    counts
      .map((row) =>
        row.status === "queued"
          ? { status: "skipped", n: 0n }
          : row.status === "skipped"
            ? { status: "skipped", n: row.n + 1n }
            : row,
      )
      .filter((row) => row.n > 0n),
  );
  expect((await f.json(`/api/sends/${other}`)).body.data.to_email).toBe("kept@example.test");
  // Nothing wiped can go out again.
  for (const send of [rows.failed!, rows.unknown!])
    expect((await f.json(`/api/sends/${send}/resend`, "POST", {})).status).toBe(409);
  await f.drain();
  expect(f.sink.messages).toHaveLength(0);
});

test("a send in flight during a wipe settles without its payload and never retries", async () => {
  const f = await open();
  const id = await f.subscriber("flight@example.test");
  const { uuid } = (await f.json(`/api/subscribers/${id}`)).body.data;
  const send = insertSend(f, "queued", "flight@example.test", id);
  const lease = new Date(f.clock.now().getTime() + minute);
  f.db.run("UPDATE sends SET status='sending', attempts=1, claimed_until=? WHERE id=?", [
    lease.toISOString(),
    send,
  ]);
  expect((await f.fresh(`/subscription/wipe/${uuid}`)).status).toBe(200);
  const row = f.db.query("SELECT * FROM sends WHERE id = ?").get(send) as never;
  expect((await f.json(`/api/sends/${send}`)).body.data.status).toBe("sending");
  f.sends.finish(row, {
    status: "proven-not-accepted",
    retry: "transient",
  } as never);
  await f.drain();
  const { data } = (await f.json(`/api/sends/${send}`)).body;
  expect(data).toMatchObject({
    status: "failed",
    error: "payload_unavailable",
    to_email: "",
  });
  expect(f.sink.messages).toHaveLength(0);
});

test("admin subscriber deletion anonymizes sends as a wipe does", async () => {
  const f = await open();
  for (const remove of [
    (id: number) => f.json(`/api/subscribers/${id}`, "DELETE"),
    (id: number) => f.json(`/api/subscribers?id=${id}`, "DELETE"),
  ]) {
    const address = `admin-${crypto.randomUUID()}@example.test`;
    const id = await f.subscriber(address);
    const send = insertSend(f, "sent", address, id);
    expect((await remove(id)).status).toBe(200);
    const { data } = (await f.json(`/api/sends/${send}`)).body;
    expect(data).toMatchObject({
      status: "sent",
      to_email: "",
      subscriber_id: null,
    });
  }
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
  const id = await f.subscriber("ivy@example.test", "Ivy", {
    attribs: { a: 1 },
  });
  await f.fresh("/subscription/form", form({ email: "IVY@example.test", name: "Z", l: list.uuid }));
  const stored = (await f.json(`/api/subscribers/${id}`)).body.data;
  expect([stored.name, stored.attribs]).toEqual(["Ivy", { a: 1 }]);
  expect(await f.status(id, list.id)).toBe("unconfirmed");
});
