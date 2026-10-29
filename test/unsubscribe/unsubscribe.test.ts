// M2.4 marketing consent, frequency cap, unsubscribe and tracking through POST /api/tx,
// the public /m/:sendUUID pages and a loopback SMTP sink.
import { afterEach, expect, test } from "bun:test";
import { permissions } from "@/roles/roles";
import { txFixture, type TxFixture } from "@/test/tx/fixture";

const fixtures: TxFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
/** A fixture whose default credentials are an API user, so clock advances keep working. */
async function open(options: Parameters<typeof txFixture>[0] = {}) {
  const f = await txFixture(options);
  fixtures.push(f);
  const role = await f.json("/api/roles/users", "POST", {
    name: "unsubscribe-fixture",
    permissions: [...permissions, "sends:get", "sends:manage"],
  });
  const user = await f.json("/api/users", "POST", {
    username: "unsubscribe-api",
    type: "api",
    status: "enabled",
    user_role_id: role.body.data.id,
  });
  const headers = f.sessionHeaders as Record<string, string>;
  for (const key of Object.keys(headers)) delete headers[key];
  headers.authorization = `Basic ${btoa(`unsubscribe-api:${user.body.data.password}`)}`;
  return f;
}
const day = 86_400_000;

/** Decoded message text: unfolded headers plus a quoted-printable-decoded body. */
function decoded(data: string) {
  const at = data.indexOf("\r\n\r\n");
  const headers = data.slice(0, at).replace(/\r\n[ \t]+/g, " ");
  const body = data
    .slice(at + 4)
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const header = (name: string) =>
    new RegExp(`^${name}: (.*)$`, "mi").exec(headers)?.[1]?.trim() ?? null;
  return { headers, body, header };
}

async function setup(
  f: TxFixture,
  body = '<p>{{ data.n }} <a href="{{ unsubscribe_url }}">unsub</a></p>',
) {
  const template = await f.template(body, "News {{ data.n }}");
  const list = async (name: string, optin = "single") =>
    (await f.json("/api/lists", "POST", { name, type: "public", optin })).body.data.id as number;
  return { template, list };
}
const marketing = (f: TxFixture, subscriber: number, template: number, list: number, n = "1") =>
  f.tx({
    subscriber_id: subscriber,
    template_id: template,
    kind: "marketing",
    list_id: list,
    data: { n },
  });
const status = (response: { body: any }) =>
  response.body.data.sends.map((row: { status: string }) => row.status);
const row = async (f: TxFixture, response: { body: any }, index = 0) =>
  (await f.json(`/api/sends/${response.body.data.sends[index].id}`)).body.data;
const membership = async (f: TxFixture, subscriber: number, list: number) =>
  (await f.json(`/api/subscribers/${subscriber}`)).body.data.lists.find(
    (l: { id: number }) => l.id === list,
  )?.subscription_status;

test("marketing consent follows list membership and opt-in type", async () => {
  const f = await open();
  const { template, list } = await setup(f);
  const single = await list("single");
  const double = await list("double", "double");
  const none = await f.subscriber("none@example.test", "None");
  const pending = await f.subscriber("pending@example.test", "Pending", { lists: [single] });
  const doubleUnconfirmed = await f.subscriber("du@example.test", "Du", { lists: [double] });
  const doubleConfirmed = await f.subscriber("dc@example.test", "Dc", {
    lists: [double],
    preconfirm_subscriptions: true,
  });
  const blocked = await f.subscriber("blocked@example.test", "Blocked", {
    lists: [single],
    status: "blocklisted",
  });
  f.marketing.minInterval = "";
  const expectations: Array<[number, number, string, string | null]> = [
    [none, single, "skipped", "not_subscribed"],
    [pending, single, "sent", null],
    [doubleUnconfirmed, double, "skipped", "unconfirmed"],
    [doubleConfirmed, double, "sent", null],
    [blocked, single, "skipped", "subscriber_blocklisted"],
  ];
  for (const [subscriber, target, expected, reason] of expectations) {
    const response = await marketing(f, subscriber, template, target);
    expect(response.status).toBe(200);
    expect(await row(f, response)).toMatchObject({
      status: expected,
      skip_reason: reason,
      kind: "marketing",
      list_id: target,
    });
  }
  // An address without a subscriber has no consent; no subscriber is created.
  const stranger = await f.tx({
    subscriber_email: "stranger@example.test",
    template_id: template,
    kind: "marketing",
    list_id: single,
  });
  expect(await row(f, stranger)).toMatchObject({
    status: "skipped",
    skip_reason: "not_subscribed",
  });
  // Unsubscribed members are skipped too.
  await f.json("/api/subscribers/lists", "PUT", {
    ids: [pending],
    action: "unsubscribe",
    target_list_ids: [single],
  });
  expect(await row(f, await marketing(f, pending, template, single))).toMatchObject({
    status: "skipped",
    skip_reason: "unsubscribed",
  });
  expect(f.sink.messages.map((m) => m.to[0])).toEqual(["pending@example.test", "dc@example.test"]);
});

test("marketing mail carries the scoped unsubscribe URL and RFC 8058 headers", async () => {
  const f = await open();
  const { template, list } = await setup(f);
  const news = await list("news");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news] });
  const adaUuid = (await f.json(`/api/subscribers/${ada}`)).body.data.uuid;
  const response = await marketing(f, ada, template, news);
  expect(status(response)).toEqual(["sent"]);
  const send = response.body.data.sends[0];
  const mail = decoded(f.sink.messages[0]!.data);
  const url = `http://fixture.test/m/${send.uuid}/unsubscribe/${adaUuid}`;
  expect(mail.body).toContain(`<a href="${url}">unsub</a>`);
  expect(mail.header("List-Unsubscribe")).toBe(`<${url}>`);
  expect(mail.header("List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
  expect(mail.header("Message-ID")).toBe(send.smtp_message_id);

  // Header setting off: the link stays, the headers go. Caller values are kept then.
  f.marketing.unsubscribeHeader = false;
  f.marketing.minInterval = "";
  const off = await f.tx({
    subscriber_id: ada,
    template_id: template,
    kind: "marketing",
    list_id: news,
    headers: [{ "List-Unsubscribe": "<mailto:caller@example.test>" }],
  });
  expect(status(off)).toEqual(["sent"]);
  const second = decoded(f.sink.messages[1]!.data);
  expect(second.header("List-Unsubscribe")).toBe("<mailto:caller@example.test>");
  expect(second.header("List-Unsubscribe-Post")).toBeNull();
  expect(second.body).toContain(`/m/${off.body.data.sends[0].uuid}/unsubscribe/${adaUuid}`);

  // Header setting on: the generated pair replaces a caller's value.
  f.marketing.unsubscribeHeader = true;
  const on = await f.tx({
    subscriber_id: ada,
    template_id: template,
    kind: "marketing",
    list_id: news,
    headers: [{ "list-unsubscribe": "<mailto:caller@example.test>" }],
  });
  expect(decoded(f.sink.messages[2]!.data).header("List-Unsubscribe")).toBe(
    `<http://fixture.test/m/${on.body.data.sends[0].uuid}/unsubscribe/${adaUuid}>`,
  );

  // Transactional sends get no unsubscribe link or headers.
  const tx = await f.tx({ subscriber_id: ada, template_id: template, data: { n: "tx" } });
  expect(status(tx)).toEqual(["sent"]);
  const plain = decoded(f.sink.messages[3]!.data);
  expect(plain.body).toContain('<a href="">unsub</a>');
  expect(plain.header("List-Unsubscribe")).toBeNull();
});

test("the frequency cap skips marketing inside min_interval and counts real sends", async () => {
  const f = await open();
  const { template, list } = await setup(f);
  const news = await list("news");
  const other = await list("other");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news, other] });
  expect(status(await marketing(f, ada, template, news, "1"))).toEqual(["sent"]);
  f.clock.advance(day);
  // The cap is per subscriber across lists; transactional mail neither counts nor is capped.
  expect(await row(f, await marketing(f, ada, template, other, "2"))).toMatchObject({
    status: "skipped",
    skip_reason: "frequency_cap",
  });
  expect(status(await f.tx({ subscriber_id: ada, template_id: template }))).toEqual(["sent"]);
  // Exactly min_interval after the last send is allowed again.
  f.clock.advance(6 * day - 1);
  expect(status(await marketing(f, ada, template, news, "3"))).toEqual(["skipped"]);
  f.clock.advance(1);
  expect(status(await marketing(f, ada, template, news, "4"))).toEqual(["sent"]);

  // One request naming the subscriber twice sends once.
  f.clock.advance(8 * day);
  const twice = await f.tx({
    subscriber_ids: [ada, ada],
    template_id: template,
    kind: "marketing",
    list_id: news,
  });
  expect(status(twice)).toEqual(["sent", "skipped"]);
  expect((await row(f, twice, 1)).skip_reason).toBe("frequency_cap");

  // Concurrent requests cannot both pass the cap.
  f.clock.advance(8 * day);
  const parallel = await Promise.all(
    Array.from({ length: 6 }, (_, i) => marketing(f, ada, template, news, `p${i}`)),
  );
  expect(parallel.flatMap(status).filter((s: string) => s === "sent")).toHaveLength(1);

  // An async queued send reserves the cap before it is delivered.
  f.clock.advance(8 * day);
  await f.stopOutbox();
  const queued = await f.tx({
    subscriber_id: ada,
    template_id: template,
    kind: "marketing",
    list_id: news,
    async: true,
  });
  expect(status(queued)).toEqual(["queued"]);
  expect(await row(f, await marketing(f, ada, template, news, "q2"))).toMatchObject({
    status: "skipped",
    skip_reason: "frequency_cap",
  });

  // An empty interval disables the cap; a different interval applies immediately.
  f.restartOutbox();
  f.marketing.minInterval = "";
  f.clock.advance(1);
  await Bun.sleep(50);
  expect(status(await marketing(f, ada, template, news, "e1"))).toEqual(["sent"]);
  f.marketing.minInterval = "PT1H";
  f.clock.advance(3_600_001);
  expect(status(await marketing(f, ada, template, news, "h1"))).toEqual(["sent"]);
});

test("failed marketing does not count; resend respects the cap and rechecks consent", async () => {
  let reject = false;
  const f = await open({ reject: () => reject });
  const { template, list } = await setup(f);
  const news = await list("news");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news] });
  reject = true;
  const failed = await marketing(f, ada, template, news, "f");
  expect(status(failed)).toEqual(["failed"]);
  reject = false;
  const failedId = failed.body.data.sends[0].id;
  // Proven non-acceptance is never retried for marketing, and does not use the cap.
  expect((await f.json(`/api/sends/${failedId}`)).body.data.attempts).toBe(1);
  // A manual resend is the same intended message, so its own lineage is not counted.
  const first = await f.json(`/api/sends/${failedId}/resend`, "POST");
  expect(first.status).toBe(200);
  await Bun.sleep(100);
  expect((await f.json(`/api/sends/${first.body.data.id}`)).body.data.status).toBe("sent");
  // Now a delivered marketing message is inside the window for any other send.
  expect(await row(f, await marketing(f, ada, template, news, "s"))).toMatchObject({
    status: "skipped",
    skip_reason: "frequency_cap",
  });
  f.clock.advance(8 * day);
  reject = true;
  const again = await marketing(f, ada, template, news, "g");
  expect(status(again)).toEqual(["failed"]);
  reject = false;
  // Consent is rechecked when the outbox admits a queued resend.
  await f.stopOutbox();
  const resend = await f.json(`/api/sends/${again.body.data.sends[0].id}/resend`, "POST");
  expect(resend.status).toBe(200);
  expect(resend.body.data.status).toBe("queued");
  await f.json("/api/subscribers/lists", "PUT", {
    ids: [ada],
    action: "unsubscribe",
    target_list_ids: [news],
  });
  f.restartOutbox();
  for (let i = 0; i < 50; i++) {
    if ((await f.json(`/api/sends/${resend.body.data.id}`)).body.data.status !== "queued") break;
    await Bun.sleep(20);
  }
  expect((await f.json(`/api/sends/${resend.body.data.id}`)).body.data).toMatchObject({
    status: "skipped",
    skip_reason: "unsubscribed",
  });
  expect(f.sink.messages).toHaveLength(1);
});

test("marketing has one SMTP recipient: request copies are 400, server copies are not applied", async () => {
  let reject = false;
  const f = await open({
    reject: () => reject,
    emailHeaders: [{ Cc: "server-cc@example.test", Bcc: "server-bcc@example.test" }],
  });
  f.marketing.minInterval = "";
  const { template, list } = await setup(f);
  const news = await list("news");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news] });
  await f.subscriber("bob@example.test", "Bob", { lists: [news] });
  // Request copies on a marketing send are rejected atomically: no rows, no SMTP.
  for (const headers of [
    [{ Cc: "eve@example.test" }],
    [{ bcc: "bob@example.test" }],
    [{ "X-Tag": "a" }, { cC: "eve@example.test" }],
  ]) {
    const response = await f.tx({
      subscriber_id: ada,
      template_id: template,
      kind: "marketing",
      list_id: news,
      headers,
    });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain("headers");
  }
  expect(f.count()).toBe(0);
  expect(f.sink.messages).toHaveLength(0);

  // Synchronous dispatch: server Cc/Bcc are not applied to marketing.
  expect(status(await marketing(f, ada, template, news, "sync"))).toEqual(["sent"]);
  // Outbox loop (async).
  const queued = await f.tx({
    subscriber_id: ada,
    template_id: template,
    kind: "marketing",
    list_id: news,
    async: true,
  });
  for (let i = 0; i < 50 && f.sink.messages.length < 2; i++) {
    // The loop's post-item pause runs on the injected clock.
    f.clock.advance(0);
    await Bun.sleep(20);
  }
  expect((await row(f, queued)).status).toBe("sent");
  // Manual resend.
  reject = true;
  const failed = await marketing(f, ada, template, news, "resend");
  expect(status(failed)).toEqual(["failed"]);
  reject = false;
  const resend = await f.json(`/api/sends/${failed.body.data.sends[0].id}/resend`, "POST");
  expect(resend.status).toBe(200);
  for (let i = 0; i < 50 && f.sink.messages.length < 3; i++) {
    // The loop's post-item pause runs on the injected clock.
    f.clock.advance(0);
    await Bun.sleep(20);
  }
  expect(f.sink.messages).toHaveLength(3);
  for (const message of f.sink.messages) {
    expect(message.to).toEqual(["ada@example.test"]);
    expect(decoded(message.data).header("Cc")).toBeNull();
  }

  // Transactional sends keep the server copies.
  expect(status(await f.tx({ subscriber_id: ada, template_id: template }))).toEqual(["sent"]);
  expect(f.sink.messages[3]!.to).toEqual([
    "ada@example.test",
    "server-cc@example.test",
    "server-bcc@example.test",
  ]);
});

test("one-click POST and the page form unsubscribe the send's list without login", async () => {
  const events: unknown[] = [];
  const f = await open({ effects: { unsubscribed: (event) => events.push(event) } });
  const { template, list } = await setup(f);
  const news = await list("news");
  const other = await list("other");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news, other] });
  const adaUuid = (await f.json(`/api/subscribers/${ada}`)).body.data.uuid;
  const response = await marketing(f, ada, template, news);
  const url = decoded(f.sink.messages[0]!.data).header("List-Unsubscribe")!.slice(1, -1);
  expect(url).toBe(
    `http://fixture.test/m/${response.body.data.sends[0].uuid}/unsubscribe/${adaUuid}`,
  );
  const path = new URL(url).pathname;

  const page = await f.request(path);
  expect(page.status).toBe(200);
  expect(page.headers.get("x-robots-tag")).toBe("noindex");
  expect(page.headers.get("content-type")).toBe("text/html; charset=UTF-8");
  const html = await page.text();
  expect(html).toContain('<form method="post" class="unsub-form">');
  expect(html).toContain('name="blocklist"');
  expect(html).toContain("Do you want to unsubscribe from this mailing list?");
  expect(html).toContain("<title>Unsubscribe from mailing list - Fixture list</title>");
  // Viewing the page changes nothing.
  expect(await membership(f, ada, news)).toBe("unconfirmed");

  // RFC 8058: no cookie, CSRF token, Origin or CAPTCHA.
  const oneClick = await f.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  expect(oneClick.status).toBe(200);
  expect(await oneClick.text()).toContain("You have unsubscribed successfully.");
  expect(await membership(f, ada, news)).toBe("unsubscribed");
  expect(await membership(f, ada, other)).toBe("unconfirmed");
  expect((await f.json(`/api/subscribers/${ada}`)).body.data.status).toBe("enabled");
  expect(events).toEqual([
    { subscriberId: BigInt(ada), listIds: [BigInt(news)], blocklisted: false },
  ]);
  // Repeating is harmless and reports no newly changed list.
  expect((await f.request(path, { method: "POST" })).status).toBe(200);
  expect(events[1]).toEqual({ subscriberId: BigInt(ada), listIds: [], blocklisted: false });
  // The next marketing send to that list is skipped.
  f.clock.advance(8 * day);
  expect(await row(f, await marketing(f, ada, template, news, "2"))).toMatchObject({
    status: "skipped",
    skip_reason: "unsubscribed",
  });
});

test("blocklist option follows privacy.allow_blocklist", async () => {
  const f = await open();
  const { template, list } = await setup(f);
  const news = await list("news");
  const other = await list("other");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news, other] });
  const bob = await f.subscriber("bob@example.test", "Bob", { lists: [news, other] });
  const pathFor = async (subscriber: number) => {
    const response = await marketing(f, subscriber, template, news);
    const uuid = (await f.json(`/api/subscribers/${subscriber}`)).body.data.uuid;
    return `/m/${response.body.data.sends[0].uuid}/unsubscribe/${uuid}`;
  };
  const form = (path: string, body: FormData | string) =>
    f.request(path, {
      method: "POST",
      ...(typeof body === "string"
        ? { headers: { "content-type": "application/x-www-form-urlencoded" } }
        : {}),
      body,
    });

  // Disallowed: the option is hidden and ignored; only the list is left.
  f.marketing.allowBlocklist = false;
  const bobPath = await pathFor(bob);
  expect(await (await f.request(bobPath)).text()).not.toContain('name="blocklist"');
  expect((await form(bobPath, "blocklist=true")).status).toBe(200);
  expect((await f.json(`/api/subscribers/${bob}`)).body.data.status).toBe("enabled");
  expect(await membership(f, bob, other)).toBe("unconfirmed");
  expect(await membership(f, bob, news)).toBe("unsubscribed");

  // Allowed: blocklist and leave every list (multipart, as browsers may send).
  f.marketing.allowBlocklist = true;
  const adaPath = await pathFor(ada);
  const multipart = new FormData();
  multipart.set("blocklist", "true");
  expect((await form(adaPath, multipart)).status).toBe(200);
  const after = (await f.json(`/api/subscribers/${ada}`)).body.data;
  expect(after.status).toBe("blocklisted");
  expect(after.lists.map((l: { subscription_status: string }) => l.subscription_status)).toEqual([
    "unsubscribed",
    "unsubscribed",
  ]);
  const page = await f.request(adaPath);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Permanently unsubscribed.");
  // Invalid form values are rejected without changes; preferences are not available.
  expect((await form(bobPath, "blocklist=maybe")).status).toBe(400);
  expect((await form(bobPath, "manage=true")).status).toBe(400);
  expect(
    (
      await f.request(bobPath, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "x",
      })
    ).status,
  ).toBe(400);
  expect((await f.json(`/api/subscribers/${bob}`)).body.data.status).toBe("enabled");
});

test("forged, mismatched and non-marketing UUIDs are safe 4xx and change nothing", async () => {
  const f = await open();
  const { template, list } = await setup(f);
  const news = await list("news");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news] });
  const eve = await f.subscriber("eve@example.test", "Eve", { lists: [news] });
  const adaUuid = (await f.json(`/api/subscribers/${ada}`)).body.data.uuid;
  const eveUuid = (await f.json(`/api/subscribers/${eve}`)).body.data.uuid;
  const sent = (await marketing(f, ada, template, news)).body.data.sends[0].uuid;
  const tx = (await f.tx({ subscriber_id: eve, template_id: template })).body.data.sends[0].uuid;
  const cases: Array<[string, number]> = [
    [`/m/${sent}/unsubscribe/${eveUuid}`, 404],
    [`/m/${crypto.randomUUID()}/unsubscribe/${adaUuid}`, 404],
    [`/m/${tx}/unsubscribe/${eveUuid}`, 404],
    [`/m/not-a-uuid/unsubscribe/${adaUuid}`, 400],
    [`/m/${sent}/unsubscribe/x`, 400],
  ];
  for (const [path, code] of cases) {
    expect((await f.request(path)).status).toBe(code);
    const post = await f.request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click&blocklist=true",
    });
    expect(post.status).toBe(code);
    expect(post.headers.get("content-type")).toBe("text/html; charset=UTF-8");
  }
  for (const id of [ada, eve]) {
    const data = (await f.json(`/api/subscribers/${id}`)).body.data;
    expect(data.status).toBe("enabled");
    expect(data.lists[0].subscription_status).toBe("unconfirmed");
  }
  // Upper-case UUIDs are accepted, as Postgres UUID comparison is case-insensitive.
  expect(
    (await f.request(`/m/${sent.toUpperCase()}/unsubscribe/${adaUuid.toUpperCase()}`)).status,
  ).toBe(200);
});

test("view pixel and tracked links follow the privacy settings without open redirects", async () => {
  const f = await open();
  const target = "https://example.test/path?a=1&b=2";
  const { template, list } = await setup(
    f,
    `<p><a href="{{ "${target}" | track_link }}">go</a> <a href="{{ data.url | track_link }}">data</a></p>{{ track_view }}`,
  );
  const news = await list("news");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news] });
  const bob = await f.subscriber("bob@example.test", "Bob");
  f.marketing.minInterval = "";
  const first = await f.tx({
    subscriber_id: ada,
    template_id: template,
    kind: "marketing",
    list_id: news,
    data: { url: "https://example.test/data" },
  });
  const send = first.body.data.sends[0];
  const mail = decoded(f.sink.messages[0]!.data).body;
  const links = [...mail.matchAll(/href="(http:\/\/fixture\.test\/m\/[^"]+\/link\/[^"]+)"/g)].map(
    (m) => m[1]!,
  );
  expect(links).toHaveLength(2);
  expect(links[0]!.startsWith(`http://fixture.test/m/${send.uuid}/link/`)).toBe(true);
  expect(mail).toContain(
    `<img src="http://fixture.test/m/${send.uuid}/px.png" width="1" height="1" style="display:none;max-height:0;max-width:0;opacity:0" alt="">`,
  );

  const redirect = await f.request(new URL(links[0]!).pathname);
  expect(redirect.status).toBe(307);
  expect(redirect.headers.get("location")).toBe(target);
  expect(redirect.headers.get("x-robots-tag")).toBe("noindex");
  const pixel = await f.request(`/m/${send.uuid}/px.png`);
  expect(pixel.status).toBe(200);
  expect(pixel.headers.get("content-type")).toBe("image/png");
  expect(pixel.headers.get("cache-control")).toBe("no-cache");
  const png = new Uint8Array(await pixel.arrayBuffer());
  expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const clicks = () =>
    f.db.query("SELECT send_id, subscriber_id, campaign_id FROM link_clicks ORDER BY id").all();
  const views = () =>
    f.db.query("SELECT send_id, subscriber_id, campaign_id FROM campaign_views ORDER BY id").all();
  // Individual tracking is off by default: the send is recorded, the subscriber is not.
  expect(clicks()).toEqual([{ send_id: BigInt(send.id), subscriber_id: null, campaign_id: null }]);
  expect(views()).toEqual([{ send_id: BigInt(send.id), subscriber_id: null, campaign_id: null }]);
  f.marketing.individualTracking = true;
  await f.request(new URL(links[1]!).pathname);
  await f.request(`/m/${send.uuid}/px.png`);
  expect(clicks()[1]).toEqual({
    send_id: BigInt(send.id),
    subscriber_id: BigInt(ada),
    campaign_id: null,
  });
  expect(views()[1]).toEqual({
    send_id: BigInt(send.id),
    subscriber_id: BigInt(ada),
    campaign_id: null,
  });

  // A link UUID only redirects for the send it was rendered into.
  const other = await f.tx({
    subscriber_id: bob,
    template_id: template,
    data: { url: "https://example.test/x" },
  });
  const otherUuid = other.body.data.sends[0].uuid;
  const linkUuid = links[0]!.split("/").pop()!;
  const dataLinkUuid = links[1]!.split("/").pop()!;
  const forged = await f.request(`/m/${otherUuid}/link/${dataLinkUuid}`);
  expect(forged.status).toBe(400);
  expect(forged.headers.get("location")).toBeNull();
  expect((await f.request(`/m/${crypto.randomUUID()}/link/${linkUuid}`)).status).toBe(400);
  expect((await f.request(`/m/${send.uuid}/link/${crypto.randomUUID()}`)).status).toBe(400);
  expect((await f.request(`/m/${send.uuid}/link/nope`)).status).toBe(400);
  expect((await f.request(`/m/nope/px.png`)).status).toBe(400);
  // Unknown sends still get the pixel and record nothing.
  expect((await f.request(`/m/${crypto.randomUUID()}/px.png`)).status).toBe(200);
  expect(clicks()).toHaveLength(2);
  expect(views()).toHaveLength(2);

  // Transactional sends are tracked too, against their own send.
  const txMail = decoded(f.sink.messages[1]!.data).body;
  const txLink = /href="http:\/\/fixture\.test(\/m\/[^"]+\/link\/[^"]+)"/.exec(txMail)![1]!;
  expect(txLink.startsWith(`/m/${otherUuid}/link/${linkUuid}`)).toBe(true);
  expect((await f.request(txLink)).status).toBe(307);

  // disable_tracking: plain URLs, no pixel, existing links redirect without recording.
  f.marketing.disableTracking = true;
  await f.tx({
    subscriber_id: bob,
    template_id: template,
    data: { url: "https://example.test/x" },
  });
  const untracked = decoded(f.sink.messages[2]!.data).body;
  expect(untracked).toContain(`<a href="https://example.test/path?a=1&amp;b=2">go</a>`);
  expect(untracked).not.toContain("px.png");
  const plain = await f.request(new URL(links[0]!).pathname);
  expect(plain.status).toBe(307);
  expect(plain.headers.get("location")).toBe(target);
  expect((await f.request(`/m/${send.uuid}/px.png`)).status).toBe(200);
  expect(clicks()).toHaveLength(3);
  expect(views()).toHaveLength(2);
});
