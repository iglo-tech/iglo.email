// Campaigns API behavior beyond the shared contract (test/contract/campaigns.ts): injected
// clock, settings, atomic writes, input bounds, Liquid rendering and test-send delivery,
// through HTTP and mail received by a loopback SMTP sink.
import { afterEach, expect, test } from "bun:test";
import { campaignsFixture, type CampaignsFixture } from "@/test/campaigns/fixture";

const fixtures: CampaignsFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await campaignsFixture();
  fixtures.push(f);
  return f;
}
// The sink keeps latin1 octets; decode quoted-printable and then UTF-8.
const decode = (data: string) =>
  Buffer.from(
    data
      .replace(/=\r\n/g, "")
      .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
    "latin1",
  ).toString("utf8");

test("send_at must be after the injected clock, and timestamps use it", async () => {
  const f = await open();
  const news = await f.list("news");
  const soon = new Date(f.clock.now().getTime() + 60_000).toISOString();
  const created = await f.campaign({ name: "c", subject: "s", lists: [news], send_at: soon });
  expect(created.created_at).toBe(f.clock.now().toISOString());
  expect(created.send_at).toBe(soon);
  f.clock.advance(120_000);
  const late = await f.json(`/api/campaigns/${created.id}`, "PUT", { lists: [news] });
  expect(late.status).toBe(400);
  expect(late.body.message).toBe("Scheduled date should be in the future.");
  const updated = await f.json(`/api/campaigns/${created.id}`, "PUT", {
    lists: [news],
    send_at: null,
  });
  expect(updated.body.data.updated_at).toBe(f.clock.now().toISOString());
});

test("invalid updates and duplicate slugs write nothing", async () => {
  const f = await open();
  const news = await f.list("news");
  const a = await f.campaign({ name: "a", subject: "s", lists: [news], archive_slug: "Same" });
  const b = await f.campaign({ name: "b", subject: "s", lists: [news] });
  const before = (await f.json(`/api/campaigns/${b.id}`)).body.data;
  const duplicate = await f.json(`/api/campaigns/${b.id}`, "PUT", {
    name: "changed",
    lists: [news],
    archive_slug: "same",
  });
  expect(duplicate.status).toBe(409);
  const archive = await f.json(`/api/campaigns/${b.id}/archive`, "PUT", {
    archive: true,
    archive_slug: "SAME",
  });
  expect(archive.status).toBe(409);
  for (const body of [
    { name: "x", lists: [news], subject: "{% if %}" },
    { name: "x", lists: [news], headers: [{ "Bad Name": "v" }] },
    { name: "x", lists: [news], headers: [{ "X-Ok": "v\r\nBcc: evil@example.test" }] },
    { name: "x", lists: [news], from_email: "a@b.test\r\nBcc: evil@example.test" },
    { name: "x\0", lists: [news] },
    { name: "x", lists: [news], template_id: 999 },
    { name: "x", lists: [news], archive_meta: [1] },
  ]) {
    const response = await f.json(`/api/campaigns/${b.id}`, "PUT", body);
    expect(response.status).toBe(400);
  }
  expect((await f.json(`/api/campaigns/${b.id}`)).body.data).toEqual(before);
  expect((await f.json(`/api/campaigns/${a.id}`)).body.data.archive_slug).toBe("same");
});

test("request and source bounds are enforced before any write", async () => {
  const f = await open();
  const news = await f.list("news");
  const big = await f.json("/api/campaigns", "POST", {
    name: "big",
    subject: "s",
    lists: [news],
    body: "x".repeat(3 * 1024 * 1024),
  });
  expect(big.status).toBe(413);
  const source = await f.json("/api/campaigns", "POST", {
    name: "source",
    subject: "s",
    lists: [news],
    body: "x".repeat(70 * 1024),
  });
  expect(source.status).toBe(400);
  expect(source.body.message).toBe("Error compiling campaign body: invalid body");
  const wrongType = await f.request("/api/campaigns", {
    method: "POST",
    headers: { ...f.sessionHeaders, "content-type": "text/plain" },
    body: "name=x",
  });
  expect(wrongType.status).toBe(415);
  expect((await f.json("/api/campaigns")).body.data.total).toBe(0);
});

test("cookie sessions need the CSRF token for writes", async () => {
  const f = await open();
  const news = await f.list("news");
  const response = await f.json(
    "/api/campaigns",
    "POST",
    { name: "c", subject: "s", lists: [news] },
    { cookie: f.sessionHeaders.cookie },
  );
  expect(response.status).toBe(403);
  expect((await f.json("/api/campaigns")).body.data.total).toBe(0);
});

test("a test send renders Liquid per recipient with unsubscribe headers and tracking", async () => {
  const f = await open();
  const news = await f.list("news");
  const other = await f.list("other");
  const ada = await f.subscriber("ada@example.test", [news, other], {
    attribs: { city: "Kraków" },
  });
  await f.subscriber("blocked@example.test", [news], { status: "blocklisted" });
  const c = await f.campaign({ name: "Weekly", subject: "Stored", lists: [news] });
  const sent = await f.json(`/api/campaigns/${c.id}/test`, "POST", {
    name: "Weekly",
    subject: "Hi {{ subscriber.first_name }}",
    lists: [news],
    messenger: "email",
    content_type: "markdown",
    body: '# {{ campaign.name }}\n\n{{ subscriber.attribs.city }} [offer]({{ "https://example.test/o?a=1&b=2" | track_link }})',
    headers: [{ "X-Who": "{{ subscriber.email }}" }],
    subscribers: ["ADA@example.test", "blocked@example.test", "ada@example.test"],
  });
  expect(sent.status).toBe(200);
  const [message] = await f.mail(1);
  await Bun.sleep(50);
  expect(f.sink.messages).toHaveLength(1);
  // Marketing deliveries go to the subscriber only: server copy headers are dropped.
  expect(message!.to).toEqual(["ada@example.test"]);
  const data = decode(message!.data).replace(/\r\n[ \t]+/g, " ");
  expect(data).toContain("Subject: Hi Ada");
  expect(data).toContain("X-Who: ada@example.test");
  expect(data).toContain(`X-Listmonk-Campaign: ${c.uuid}`);
  expect(data).toContain(
    `List-Unsubscribe: <http://fixture.test/subscription/${c.uuid}/${ada.uuid}>`,
  );
  expect(data).toContain("<h1>Weekly</h1>");
  expect(data).toContain("Kraków");
  const link = new RegExp(
    `http://fixture\\.test/link/([0-9a-f-]{36})/${c.uuid}/0{8}-0{4}-0{4}-0{4}-0{12}`,
  ).exec(data);
  expect(link).not.toBeNull();
  expect(data).toContain(
    `http://fixture.test/campaign/${c.uuid}/00000000-0000-0000-0000-000000000000/px.png`,
  );
  const redirect = await f.request(new URL(link![0]).pathname);
  expect(redirect.status).toBe(307);
  expect(redirect.headers.get("location")).toBe("https://example.test/o?a=1&b=2");
  const after = (await f.json(`/api/campaigns/${c.id}`)).body.data;
  expect([after.sent, after.to_send, after.clicks, after.status, after.subject]).toEqual([
    0,
    0,
    1,
    "draft",
    "Stored",
  ]);
});

test("disabled tracking and headers follow the privacy settings", async () => {
  const f = await open();
  const news = await f.list("news");
  await f.subscriber("ada@example.test", [news]);
  f.settings.disableTracking = true;
  f.settings.unsubscribeHeader = false;
  const c = await f.campaign({ name: "c", subject: "s", lists: [news] });
  const sent = await f.json(`/api/campaigns/${c.id}/test`, "POST", {
    name: "c",
    subject: "s",
    lists: [news],
    messenger: "email",
    content_type: "html",
    body: '<a href="{{ "https://example.test/x" | track_link }}">x</a>{{ track_view }}',
    subscribers: ["ada@example.test"],
  });
  expect(sent.status).toBe(200);
  const data = decode((await f.mail(1))[0]!.data);
  expect(data).toContain('href="https://example.test/x"');
  expect(data).not.toContain("px.png");
  expect(data).not.toContain("List-Unsubscribe");
  const pixel = await f.request(`/campaign/${c.uuid}/${crypto.randomUUID()}/px.png`);
  expect(pixel.status).toBe(200);
  expect((await f.json(`/api/campaigns/${c.id}`)).body.data.views).toBe(0);
});

test("campaign unsubscribe changes only the campaign's lists, or blocklists", async () => {
  const f = await open();
  const news = await f.list("news");
  const other = await f.list("other");
  const ada = await f.subscriber("ada@example.test", [news, other]);
  const c = await f.campaign({ name: "c", subject: "s", lists: [news] });
  const path = `/subscription/${c.uuid}/${ada.uuid}`;
  const manage = await f.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "manage=true",
  });
  expect(manage.status).toBe(400);
  const statuses = async () =>
    ((await f.json(`/api/subscribers/${ada.id}`)).body.data.lists as any[]).map(
      (l) => l.subscription_status,
    );
  expect(await statuses()).toEqual(["unconfirmed", "unconfirmed"]);
  const unknown = await f.request(`/subscription/${crypto.randomUUID()}/${ada.uuid}`, {
    method: "POST",
  });
  expect(unknown.status).toBe(200);
  expect(await statuses()).toEqual(["unconfirmed", "unconfirmed"]);
  expect((await f.request(path, { method: "POST" })).status).toBe(200);
  expect(await statuses()).toEqual(["unsubscribed", "unconfirmed"]);
  expect(f.unsubscribed).toHaveLength(1);
  const block = await f.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "blocklist=true",
  });
  expect(block.status).toBe(200);
  const after = (await f.json(`/api/subscribers/${ada.id}`)).body.data;
  expect(after.status).toBe("blocklisted");
  expect(after.lists.map((l: any) => l.subscription_status)).toEqual([
    "unsubscribed",
    "unsubscribed",
  ]);
  const page = await f.request(path);
  expect(await page.text()).toContain("No subscriptions");
});

test("content conversion keeps Liquid expressions intact", async () => {
  const f = await open();
  const news = await f.list("news");
  const c = await f.campaign({ name: "c", subject: "s", lists: [news] });
  const converted = await f.json(`/api/campaigns/${c.id}/content`, "POST", {
    from: "markdown",
    to: "html",
    body: '[x]({{ "https://a.test/?a=1&b=2" | track_link }}) {% if a > b %}y{% endif %}',
  });
  expect(converted.body.data).toBe(
    '<p><a href="{{ "https://a.test/?a=1&b=2" | track_link }}">x</a> {% if a > b %}y{% endif %}</p>\n',
  );
});

test("opt-in campaigns store a Liquid body listing the double opt-in lists", async () => {
  const f = await open();
  const single = await f.list("single");
  const double = await f.list("double <b>", "double");
  const c = await f.campaign({ name: "o", subject: "s", lists: [single, double], type: "optin" });
  expect(c.body).toContain("{{ subscriber.first_name }}");
  expect(c.body).toContain("<li>{% raw %}double &#60;b&#62;{% endraw %}</li>");
  const preview = await f.json(`/api/campaigns/${c.id}/preview`);
  expect(preview.status).toBe(200);
  expect(preview.body).toContain("Demo");
  expect(preview.body).toContain("double &#60;b&#62;");
});

test("archive settings keep stored metadata when omitted", async () => {
  const f = await open();
  const news = await f.list("news");
  const c = await f.campaign({ name: "c", subject: "s", lists: [news], archive_meta: { a: 1 } });
  const off = await f.json(`/api/campaigns/${c.id}/archive`, "PUT", { archive: false });
  expect(off.status).toBe(200);
  expect((await f.json(`/api/campaigns/${c.id}`)).body.data.archive_meta).toEqual({ a: 1 });
  const missing = await f.json(`/api/campaigns/${c.id}/archive`, "PUT", {
    archive: true,
    archive_template_id: 999,
  });
  expect(missing.status).toBe(400);
});

test("deleting a campaign removes its list links; deleted lists keep the name", async () => {
  const f = await open();
  const news = await f.list("news");
  const other = await f.list("other");
  const c = await f.campaign({ name: "c", subject: "s", lists: [news, other] });
  expect((await f.json(`/api/lists/${other}`, "DELETE")).status).toBe(200);
  expect((await f.json(`/api/campaigns/${c.id}`)).body.data.lists).toEqual([
    { id: news, name: "news" },
    { id: 0, name: "other" },
  ]);
  const updated = await f.json(`/api/campaigns/${c.id}`, "PUT", { lists: [news] });
  expect(updated.body.data.lists).toEqual([
    { id: news, name: "news" },
    { id: 0, name: "other" },
  ]);
  expect((await f.json(`/api/campaigns/${c.id}`, "DELETE")).status).toBe(200);
  expect((await f.json(`/api/campaigns/${c.id}`)).status).toBe(400);
});

test("the campaign redirect follows only links that campaign's content registered", async () => {
  const f = await open();
  const news = await f.list("news");
  await f.subscriber("ada@example.test", [news]);
  const send = async (name: string, url: string) => {
    const c = await f.campaign({ name, subject: name, lists: [news] });
    const sent = await f.json(`/api/campaigns/${c.id}/test`, "POST", {
      name,
      subject: name,
      lists: [news],
      messenger: "email",
      content_type: "html",
      body: `<a href="{{ "${url}" | track_link }}">x</a>`,
      subscribers: ["ada@example.test"],
    });
    expect(sent.status).toBe(200);
    return c;
  };
  const own = await send("own", "https://example.test/own");
  const other = await send("other", "https://attacker.example/phish");
  const links = (await f.mail(2)).map((m) =>
    /http:\/\/fixture\.test(\/link\/([0-9a-f-]{36})\/[0-9a-f-]{36}\/[0-9a-f-]{36})/.exec(
      decode(m.data),
    )!,
  );
  const [ownLink, otherLink] = links[0]![1]!.includes(own.uuid) ? links : [links[1]!, links[0]!];
  const dummy = "00000000-0000-0000-0000-000000000000";
  const replayed = `/link/${otherLink![2]}/${own.uuid}/${dummy}`;
  for (const disabled of [false, true]) {
    f.settings.disableTracking = disabled;
    const followed = await f.request(ownLink![1]!);
    expect(followed.status).toBe(307);
    expect(followed.headers.get("location")).toBe("https://example.test/own");
    // Another campaign's link UUID with this campaign's UUID: no redirect, no click.
    const refused = await f.request(replayed);
    expect(refused.status).toBe(404);
    expect(refused.headers.get("location")).toBeNull();
  }
  expect((await f.json(`/api/campaigns/${own.id}`)).body.data.clicks).toBe(1);
  expect((await f.json(`/api/campaigns/${other.id}`)).body.data.clicks).toBe(0);
});

test("all parts of a test message share one render budget", async () => {
  const f = await open();
  const news = await f.list("news");
  await f.subscriber("ada@example.test", [news]);
  const c = await f.campaign({ name: "c", subject: "s", lists: [news] });
  // Each 512 KiB header alone fits a fresh budget; ten together exceed one message budget.
  const header = `{% for i in (1..512) %}${"x".repeat(1024)}{% endfor %}`;
  const sent = await f.json(`/api/campaigns/${c.id}/test`, "POST", {
    name: "c",
    subject: "s",
    lists: [news],
    messenger: "email",
    content_type: "html",
    body: "<p>hi</p>",
    headers: Array.from({ length: 10 }, (_, i) => ({ [`X-Big-${i}`]: header })),
    subscribers: ["ada@example.test"],
  });
  expect(sent.status).toBe(500);
  expect(sent.body.message).toBe("Error sending test: invalid template");
  await Bun.sleep(100);
  expect(f.sink.messages).toHaveLength(0);
});

test("a test send has an aggregate size limit across recipients and sends nothing past it", async () => {
  const f = await open();
  const news = await f.list("news");
  const emails = Array.from({ length: 40 }, (_, i) => `r${i}@example.test`);
  for (const email of emails) await f.subscriber(email, [news]);
  const c = await f.campaign({ name: "c", subject: "s", lists: [news] });
  const send = (to: string[]) =>
    f.json(`/api/campaigns/${c.id}/test`, "POST", {
      name: "c",
      subject: "s",
      lists: [news],
      messenger: "email",
      content_type: "html",
      body: `{% for i in (1..900) %}${"x".repeat(1024)}{% endfor %}`,
      subscribers: to,
    });
  // About 900 KiB fits one message's budget; forty messages exceed the request's 32 MiB.
  const tooLarge = await send(emails);
  expect(tooLarge.status).toBe(400);
  expect(tooLarge.body.message).toBe(
    "The test send is too large: send it to fewer recipients or reduce the rendered size.",
  );
  await Bun.sleep(100);
  expect(f.sink.messages).toHaveLength(0);
  expect((await send(emails.slice(0, 2))).status).toBe(200);
  expect(await f.mail(2)).toHaveLength(2);
});

test("custom header values are limited in number", async () => {
  const f = await open();
  const news = await f.list("news");
  const headers = (n: number) => Array.from({ length: n }, (_, i) => ({ [`X-H-${i}`]: "v" }));
  const create = (name: string, value: object[]) =>
    f.json("/api/campaigns", "POST", { name, subject: "s", lists: [news], headers: value });
  expect((await create("ok", headers(32))).status).toBe(200);
  const many = await create("many", [{ "X-A": "v", "X-B": "v" }, ...headers(31)]);
  expect(many.status).toBe(400);
  expect(many.body.message).toBe("Invalid fields: headers");
});

test("the emitted view pixel counts as an anonymous view without individual tracking", async () => {
  const f = await open();
  const news = await f.list("news");
  await f.subscriber("ada@example.test", [news]);
  const c = await f.campaign({ name: "c", subject: "s", lists: [news] });
  const sent = await f.json(`/api/campaigns/${c.id}/test`, "POST", {
    name: "c",
    subject: "s",
    lists: [news],
    messenger: "email",
    content_type: "html",
    body: "<p>hi</p>{{ track_view }}",
    subscribers: ["ada@example.test"],
  });
  expect(sent.status).toBe(200);
  const pixel = new RegExp(
    `http://fixture\\.test(/campaign/${c.uuid}/[0-9a-f-]{36}/px\\.png)`,
  ).exec(decode((await f.mail(1))[0]!.data))![1]!;
  expect(pixel).toBe(`/campaign/${c.uuid}/00000000-0000-0000-0000-000000000000/px.png`);
  expect((await f.request(pixel)).status).toBe(200);
  expect((await f.json(`/api/campaigns/${c.id}`)).body.data.views).toBe(1);
  // The dummy campaign (previews) never records; with individual tracking the dummy
  // subscriber is a preview hit and records nothing either.
  const dummy = "00000000-0000-0000-0000-000000000000";
  expect((await f.request(`/campaign/${dummy}/${dummy}/px.png`)).status).toBe(200);
  f.settings.individualTracking = true;
  expect((await f.request(pixel)).status).toBe(200);
  expect((await f.json(`/api/campaigns/${c.id}`)).body.data.views).toBe(1);
});

test("campaign search and query deletion fold Unicode case", async () => {
  const f = await open();
  const news = await f.list("news");
  const krakow = await f.campaign({ name: "Kraków", subject: "Wiosna", lists: [news] });
  const other = await f.campaign({ name: "Gdańsk", subject: "s", lists: [news] });
  const found = async (query: string) =>
    (
      await f.json(`/api/campaigns?query=${encodeURIComponent(query)}&per_page=all`)
    ).body.data.results.map((c: { id: number }) => c.id);
  expect(await found("KRAKÓW")).toEqual([krakow.id]);
  expect(await found("kraków")).toEqual([krakow.id]);
  expect(await found("ów wIOSNA")).toEqual([krakow.id]);
  expect(await found("krakow")).toEqual([]);
  expect(await found("*")).toEqual([]);
  const deleted = await f.json(`/api/campaigns?query=${encodeURIComponent("KRAKÓW")}`, "DELETE");
  expect(deleted.status).toBe(200);
  expect((await f.json(`/api/campaigns/${krakow.id}`)).status).toBe(400);
  expect((await f.json(`/api/campaigns/${other.id}`)).status).toBe(200);
});

test("campaign search lowercases both sides like upstream ILIKE (İstanbul, ẞ)", async () => {
  const f = await open();
  const news = await f.list("news");
  const istanbul = await f.campaign({ name: "\u0130stanbul", subject: "Bahar", lists: [news] });
  const gross = await f.campaign({ name: "GRO\u1E9E", subject: "s", lists: [news] });
  const other = await f.campaign({ name: "Izmir", subject: "s", lists: [news] });
  const found = async (query: string) =>
    (
      await f.json(`/api/campaigns?query=${encodeURIComponent(query)}&per_page=all`)
    ).body.data.results.map((c: { id: number }) => c.id);
  expect(await found("istanbul")).toEqual([istanbul.id]);
  expect(await found("\u0130STANBUL")).toEqual([istanbul.id]);
  expect(await found("gro\u00DF")).toEqual([gross.id]);
  expect(await found("gross")).toEqual([]);
  const deleted = await f.json(`/api/campaigns?query=istanbul`, "DELETE");
  expect(deleted.status).toBe(200);
  expect((await f.json(`/api/campaigns/${istanbul.id}`)).status).toBe(400);
  expect((await f.json(`/api/campaigns/${other.id}`)).status).toBe(200);
});

test("order_by=status follows upstream's status enum rank across pages", async () => {
  const f = await open();
  const news = await f.list("news");
  const later = new Date(f.clock.now().getTime() + 86_400_000).toISOString();
  const status = async (id: number, value: string) =>
    expect((await f.json(`/api/campaigns/${id}/status`, "PUT", { status: value })).status).toBe(
      200,
    );
  // Created so that neither creation order nor text order matches the enum rank.
  const make = async (name: string, ...steps: string[]) => {
    const c = await f.campaign({
      name,
      subject: "s",
      lists: [news],
      ...(steps[0] === "scheduled" ? { send_at: later } : {}),
    });
    for (const step of steps) await status(c.id, step);
    return c;
  };
  await make("finished", "finished");
  await make("cancelled", "running", "cancelled");
  await make("paused", "running", "paused");
  await make("scheduled", "scheduled");
  await make("running", "running");
  await make("draft");
  const page = async (order: string, n: number) =>
    (
      await f.json(`/api/campaigns?order_by=status&order=${order}&per_page=2&page=${n}`)
    ).body.data.results.map((c: { status: string }) => c.status);
  const rank = ["draft", "running", "scheduled", "paused", "cancelled", "finished"];
  const asc = [...(await page("asc", 1)), ...(await page("asc", 2)), ...(await page("asc", 3))];
  expect(asc).toEqual(rank);
  const desc = [...(await page("desc", 1)), ...(await page("desc", 2)), ...(await page("desc", 3))];
  expect(desc).toEqual([...rank].reverse());
});
