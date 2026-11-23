// B123 (D126): a public action that changes a subscriber needs a pairing the server issued: a
// campaign the runner delivered to that subscriber, a marketing send to them, or the placeholder
// campaign of the mail the server sent them (opt-in and preferences). A subscriber UUID alone
// blocklists, exports or wipes nobody. Through HTTP, on the public fixture with the SMTP sink and
// the effects spy; the campaign deliveries come from the runner's own claim.
import { afterEach, expect, test } from "bun:test";
import { publicFixture } from "@/test/public/fixture";
import type { PublicFixture } from "@/test/public/fixture";
import { asBody } from "@/test/read-body";

const fixtures: Array<PublicFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function open() {
  const f = await publicFixture();
  fixtures.push(f);
  return f;
}

const placeholder = "00000000-0000-0000-0000-000000000000";
/** A well-formed campaign UUID that no campaign has. */
const unknownCampaign = "3f6b1c2d-8e4a-4b7c-9d1e-2a5f6b7c8d9e";
const unknownSend = "9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
let peers = 0;
const form = (values: Array<[string, string]>) => new URLSearchParams(values).toString();

/** A POST from a new peer, so the per-peer limits stay out of the way. */
const act = (f: PublicFixture, path: string, body = "") => f.fresh(path, body);
const visit = (f: PublicFixture, path: string) => f.peer(path, `198.51.100.${++peers}`);

/** A campaign the runner has delivered to each of these subscribers: the pairing D126 names. */
const delivered = (f: PublicFixture, list: number, subscribers: Array<number>) => ({
  uuid: f.deliveredCampaign(subscribers, [list]),
});

const uuidOf = async (f: PublicFixture, id: number) =>
  asBody<string>((await f.json(`/api/subscribers/${id}`)).body.data.uuid);
const subscriberOf = async (f: PublicFixture, id: number) =>
  asBody<Record<string, any>>((await f.json(`/api/subscribers/${id}`)).body.data);

test("a random campaign, the placeholder campaign and the retired sub-only routes write nothing", async () => {
  const f = await open();
  const news = await f.list("News");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id] });
  const bob = await f.subscriber("bob@example.test", "Bob", { lists: [news.id] });
  const adaUuid = await uuidOf(f, ada);
  const before = await subscriberOf(f, ada);
  const weekly = delivered(f, news.id, [bob]);
  // Blocklisting through an unpaired campaign, and through the placeholder one.
  const blocklist = "blocklist=true";
  const attacks: Array<[string, string]> = [
    [`/subscription/${unknownCampaign}/${adaUuid}`, blocklist],
    [
      `/subscription/${unknownCampaign}/${adaUuid}?manage=true`,
      form([
        ["manage", "true"],
        ["blocklist", "true"],
      ]),
    ],
    [`/subscription/${placeholder}/${adaUuid}`, blocklist],
    [
      `/subscription/${placeholder}/${adaUuid}?manage=true`,
      form([
        ["manage", "true"],
        ["blocklist", "true"],
      ]),
    ],
    // Ada was never delivered this campaign, so Bob's campaign does not pair her.
    [`/subscription/${weekly.uuid}/${adaUuid}`, blocklist],
    // The retired sub-only export and wipe, and the same calls under an unpaired campaign.
    [`/subscription/export/${adaUuid}`, ""],
    [`/subscription/wipe/${adaUuid}`, ""],
    [`/subscription/${unknownCampaign}/export/${adaUuid}`, ""],
    [`/subscription/${unknownCampaign}/wipe/${adaUuid}`, ""],
    [`/subscription/${placeholder}/export/${adaUuid}`, ""],
    [`/subscription/${placeholder}/wipe/${adaUuid}`, ""],
  ];
  const answers: Array<string> = [];
  for (const [path, body] of attacks) {
    const response = await act(f, path, body);
    expect([path, response.status]).toEqual([path, 404]);
    answers.push(await response.text());
  }
  // An unknown subscriber under an unpaired campaign answers the same page as Ada does: no oracle.
  const absent = await act(f, `/subscription/${unknownCampaign}/${crypto.randomUUID()}`, blocklist);
  expect(absent.status).toBe(404);
  expect(await absent.text()).toBe(answers[0]!);
  await f.drain();
  expect(f.mailTo("ada@example.test")).toHaveLength(0);
  expect(await subscriberOf(f, ada)).toEqual(before);
  expect((await subscriberOf(f, bob)).status).toBe("enabled");
  expect(f.calls).toEqual([]);
});

test("a campaign pairs only the subscribers the runner delivered it to", async () => {
  const f = await open();
  const news = await f.list("News");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id] });
  const bob = await f.subscriber("bob@example.test", "Bob", { lists: [news.id] });
  const adaUuid = await uuidOf(f, ada);
  const bobUuid = await uuidOf(f, bob);
  const weekly = delivered(f, news.id, [ada]);

  const refused = await act(f, `/subscription/${weekly.uuid}/${bobUuid}`, "blocklist=true");
  expect(refused.status).toBe(404);
  expect((await subscriberOf(f, bob)).status).toBe("enabled");
  expect(f.calls).toEqual([]);

  // The control: Ada's own link from her delivery unsubscribes her from every list (B130, D128). The
  // status stays enabled, so this is not a blocklist, and the all-lists effect runs once.
  const real = await act(f, `/subscription/${weekly.uuid}/${adaUuid}`, "blocklist=true");
  expect(real.status).toBe(200);
  expect((await subscriberOf(f, ada)).status).toBe("enabled");
  expect(await f.status(ada, news.id)).toBe("unsubscribed");
  expect(f.calls).toHaveLength(1);
});

test("the all-lists option on a delivered campaign's link ends every list, keeps the status, and says so when revisited", async () => {
  const f = await open();
  const news = await f.list("News");
  const other = await f.list("Other");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id, other.id] });
  const adaUuid = await uuidOf(f, ada);
  const weekly = delivered(f, news.id, [ada]);

  const chosen = await act(f, `/subscription/${weekly.uuid}/${adaUuid}`, "blocklist=true");
  expect(chosen.status).toBe(200);
  expect(await chosen.text()).toContain("You have unsubscribed successfully.");
  // Every list ends, not only the campaign's; the status stays, so this is not a blocklist (B130, D128).
  expect(await f.status(ada, news.id)).toBe("unsubscribed");
  expect(await f.status(ada, other.id)).toBe("unsubscribed");
  expect((await subscriberOf(f, ada)).status).toBe("enabled");
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.listIds).toEqual([]);

  // The same link revisited: every list is already ended, so the page says so.
  const revisit = await (await visit(f, `/subscription/${weekly.uuid}/${adaUuid}`)).text();
  expect(revisit).toContain("already unsubscribed");
});

test("a delivered campaign's manage page exports and wipes its subscriber through that campaign", async () => {
  const f = await open();
  const news = await f.list("News");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id] });
  const adaUuid = await uuidOf(f, ada);
  const weekly = delivered(f, news.id, [ada]);

  const page = await visit(f, `/subscription/${weekly.uuid}/${adaUuid}?manage=true`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain(`/subscription/${weekly.uuid}/export/${adaUuid}`);
  expect(html).toContain(`/subscription/${weekly.uuid}/wipe/${adaUuid}`);
  expect(html).not.toContain("/subscription/export/");

  expect((await act(f, `/subscription/${unknownCampaign}/export/${adaUuid}`)).status).toBe(404);
  expect((await act(f, `/subscription/${weekly.uuid}/export/${adaUuid}`)).status).toBe(200);
  await f.drain();
  expect(f.mailTo("ada@example.test")).toHaveLength(1);

  expect((await act(f, `/subscription/${weekly.uuid}/wipe/${adaUuid}?confirm=true`)).status).toBe(
    200,
  );
  expect((await f.json(`/api/subscribers/${ada}`)).status).toBe(400);
});

test("the placeholder campaign keeps opt-in and preferences, and refuses blocklist and privacy", async () => {
  const f = await open();
  const news = await f.list("News");
  const double = await f.list("Double", "public", "double");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [double.id] });
  // News is confirmed by an administrator, so the one-click below must keep it.
  const confirmed = await f.json("/api/subscribers/lists", "PUT", {
    ids: [ada],
    action: "add",
    target_list_ids: [news.id],
    status: "confirmed",
  });
  expect(confirmed.status).toBe(200);
  const adaUuid = await uuidOf(f, ada);
  await f.drain();
  const mailed = f.mailTo("ada@example.test").length;

  // The opt-in mail's one-click ends the unconfirmed subscription and keeps the confirmed one.
  const oneClick = await act(
    f,
    `/subscription/${placeholder}/${adaUuid}`,
    "List-Unsubscribe=One-Click",
  );
  expect(oneClick.status).toBe(200);
  expect(await f.status(ada, double.id)).toBe("unsubscribed");
  expect(await f.status(ada, news.id)).toBe("confirmed");

  // The tx preference link saves the name and keeps the list it names.
  const saved = await act(
    f,
    `/subscription/${placeholder}/${adaUuid}?manage=true`,
    form([
      ["manage", "true"],
      ["name", "Ada Two"],
      ["l", (await f.json(`/api/lists/${news.id}`)).body.data.uuid],
    ]),
  );
  expect(saved.status).toBe(200);
  // The placeholder's save changes no name and no confirmed list (r1).
  expect((await subscriberOf(f, ada)).name).toBe("Ada");
  expect(await f.status(ada, news.id)).toBe("confirmed");

  // Blocklist and privacy need a pairing: refused, nothing written.
  const before = await subscriberOf(f, ada);
  expect((await act(f, `/subscription/${placeholder}/${adaUuid}`, "blocklist=true")).status).toBe(
    404,
  );
  expect((await act(f, `/subscription/${placeholder}/export/${adaUuid}`)).status).toBe(404);
  expect((await act(f, `/subscription/${placeholder}/wipe/${adaUuid}`)).status).toBe(404);
  expect(await subscriberOf(f, ada)).toEqual(before);
  await f.drain();
  expect(f.mailTo("ada@example.test")).toHaveLength(mailed);

  // Its page offers no blocklist and no privacy forms.
  const manage = await (
    await visit(f, `/subscription/${placeholder}/${adaUuid}?manage=true`)
  ).text();
  expect(manage).not.toContain('name="name"');
  expect(manage).not.toContain('name="blocklist"');
  expect(manage).not.toContain("/export/");
  expect(manage).not.toContain("/wipe/");
});

test("a marketing send's manage page exports and wipes through its send, for its subscriber only", async () => {
  const f = await open();
  const template = await f.template('<p><a href="{{ unsubscribe_url }}">u</a></p>', "Offer");
  const list = await f.list("News");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [list.id] });
  const bob = await f.subscriber("bob@example.test", "Bob", { lists: [list.id] });
  const adaUuid = await uuidOf(f, ada);
  const bobUuid = await uuidOf(f, bob);
  const sent = await f.tx({
    subscriber_id: ada,
    template_id: template,
    kind: "marketing",
    list_id: list.id,
    data: {},
  });
  expect(sent.status).toBe(200);
  const send = asBody<string>(
    (await f.json(`/api/sends/${sent.body.data.sends[0].id}`)).body.data.uuid,
  );

  const page = await visit(f, `/m/${send}/unsubscribe/${adaUuid}?manage=true`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain(`/m/${send}/export/${adaUuid}`);
  expect(html).toContain(`/m/${send}/wipe/${adaUuid}`);

  // Bob is not this send's subscriber, and an unknown send pairs nobody.
  expect((await act(f, `/m/${send}/export/${bobUuid}`)).status).toBe(404);
  expect((await act(f, `/m/${send}/wipe/${bobUuid}`)).status).toBe(404);
  expect((await act(f, `/m/${unknownSend}/export/${adaUuid}`)).status).toBe(404);
  expect((await act(f, `/m/${unknownSend}/wipe/${adaUuid}`)).status).toBe(404);
  expect((await subscriberOf(f, bob)).status).toBe("enabled");
  await f.drain();
  const exports = f.mailTo("ada@example.test").length;
  expect(exports).toBe(1);

  expect((await act(f, `/m/${send}/export/${adaUuid}`)).status).toBe(200);
  await f.drain();
  expect(f.mailTo("ada@example.test")).toHaveLength(exports + 1);

  expect((await act(f, `/m/${send}/wipe/${adaUuid}?confirm=true`)).status).toBe(200);
  expect((await f.json(`/api/subscribers/${ada}`)).status).toBe(400);
  expect((await subscriberOf(f, bob)).status).toBe("enabled");
});

// r1 (D126): the placeholder campaign writes only pending opt-ins; a transactional send pairs its
// subscriber through the journal; view in browser answers only a delivered subscriber.
const decoded = (data: string) =>
  data
    .replaceAll("=\r\n", "")
    .replaceAll(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
/** Admin confirmation of each list, as an administrator's list change makes it. */
const confirm = (f: PublicFixture, id: number, lists: Array<number>) =>
  f.json("/api/subscribers/lists", "PUT", {
    ids: [id],
    action: "add",
    target_list_ids: lists,
    status: "confirmed",
  });

test("the placeholder campaign's manage save renames nobody and leaves confirmed lists alone", async () => {
  const f = await open();
  const news = await f.list("News");
  const double = await f.list("Double", "public", "double");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [double.id] });
  expect((await confirm(f, ada, [news.id])).status).toBe(200);
  const adaUuid = await uuidOf(f, ada);

  // The page offers pending lists only: no name field, and the confirmed list is not listed.
  const manage = await (
    await visit(f, `/subscription/${placeholder}/${adaUuid}?manage=true`)
  ).text();
  expect(manage).toContain(`value="${double.uuid}"`);
  expect(manage).not.toContain(`value="${news.uuid}"`);
  expect(manage).not.toContain('name="name"');

  // The reviewer's repro: a rename and no lists. Nothing confirmed is touched, and the name stays.
  const saved = await act(
    f,
    `/subscription/${placeholder}/${adaUuid}?manage=true`,
    form([
      ["manage", "true"],
      ["name", "Hacked"],
    ]),
  );
  expect(saved.status).toBe(200);
  expect((await subscriberOf(f, ada)).name).toBe("Ada");
  expect(await f.status(ada, news.id)).toBe("confirmed");
  // The pending list was not kept, so the save ends it.
  expect(await f.status(ada, double.id)).toBe("unsubscribed");
});

test("an old opt-in link still confirms a pending subscription", async () => {
  const f = await open();
  const double = await f.list("Double", "public", "double");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [double.id] });
  const adaUuid = await uuidOf(f, ada);
  expect(await f.status(ada, double.id)).toBe("unconfirmed");
  const confirmed = await act(
    f,
    `/subscription/optin/${adaUuid}`,
    form([
      ["confirm", "true"],
      ["l", double.uuid],
    ]),
  );
  expect(confirmed.status).toBe(200);
  expect(await f.status(ada, double.id)).toBe("confirmed");
});

test("a transactional preference link manages confirmed lists through its own send", async () => {
  const f = await open();
  const template = await f.template('<p><a href="{{ manage_url }}">manage</a></p>', "Receipt");
  const news = await f.list("News");
  const other = await f.list("Other");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id, other.id] });
  await confirm(f, ada, [news.id, other.id]);
  const adaUuid = await uuidOf(f, ada);
  expect((await f.tx({ subscriber_id: ada, template_id: template })).status).toBe(200);
  await f.drain();
  const mail = f.mailTo("ada@example.test").at(-1)!;
  const link =
    /http:\/\/fixture\.test(\/m\/[0-9a-f-]+\/unsubscribe\/[0-9a-f-]+\?manage=true)/i.exec(
      decoded(mail.data),
    )![1]!;
  expect(link).toContain(`/unsubscribe/${adaUuid}?manage=true`);

  const page = await visit(f, link);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain(`value="${news.uuid}"`);
  expect(html).toContain(`value="${other.uuid}"`);
  // B117b (D137 item 1): the transactional manage view has no name field.
  expect(html).not.toContain('name="name"');
  expect(html).not.toContain('name="blocklist"');
  // B126 (D123 item 8): the page's export acts through its own send; its wipe is not offered.
  expect(html).toContain(`/export/${adaUuid}`);
  expect(html).not.toContain(`/wipe/${adaUuid}`);

  const saved = await act(
    f,
    link,
    form([
      ["manage", "true"],
      ["name", "Ada Two"],
      ["l", news.uuid],
    ]),
  );
  expect(saved.status).toBe(200);
  // A name sent to the transactional manage view changes nothing (D137 item 1); the list change applies.
  expect((await subscriberOf(f, ada)).name).toBe("Ada");
  expect(await f.status(ada, news.id)).toBe("confirmed");
  expect(await f.status(ada, other.id)).toBe("unsubscribed");
  // A transactional send cannot blocklist: that is refused and writes nothing.
  expect((await act(f, link, "blocklist=true")).status).toBe(404);
  expect((await subscriberOf(f, ada)).status).toBe("enabled");
});

test("an old transactional link (the placeholder) can only end pending opt-ins", async () => {
  const f = await open();
  const news = await f.list("News");
  const double = await f.list("Double", "public", "double");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id, double.id] });
  await confirm(f, ada, [news.id]);
  const adaUuid = await uuidOf(f, ada);
  const before = await subscriberOf(f, ada);

  // A save with no lists and a new name: the pending list ends, the confirmed one stays.
  const saved = await act(
    f,
    `/subscription/${placeholder}/${adaUuid}?manage=true`,
    form([
      ["manage", "true"],
      ["name", "Hacked"],
    ]),
  );
  expect(saved.status).toBe(200);
  expect((await subscriberOf(f, ada)).name).toBe(before.name);
  expect(await f.status(ada, news.id)).toBe("confirmed");
  expect(await f.status(ada, double.id)).toBe("unsubscribed");
  // The one-click ends pending subscriptions, as before, and touches nothing confirmed.
  expect(
    (await act(f, `/subscription/${placeholder}/${adaUuid}`, "List-Unsubscribe=One-Click")).status,
  ).toBe(200);
  expect(await f.status(ada, news.id)).toBe("confirmed");
});

test("the placeholder's one-click and manage save end a pending double opt-in, and keep an active single opt-in", async () => {
  // B117b (D137 item 3): the opt-in mail's one-click POST ended every unconfirmed row, so an active single
  // opt-in membership (created by the API without preconfirm_subscriptions, or by import) went with them.
  const f = await open();
  const weekly = await f.list("Weekly", "public", "single");
  const double = await f.list("Double", "public", "double");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [weekly.id, double.id] });
  const bob = await f.subscriber("bob@example.test", "Bob", { lists: [weekly.id, double.id] });
  expect(await f.status(ada, weekly.id)).toBe("unconfirmed");
  expect(await f.status(ada, double.id)).toBe("unconfirmed");

  const adaUuid = await uuidOf(f, ada);
  const oneClick = await act(
    f,
    `/subscription/${placeholder}/${adaUuid}`,
    "List-Unsubscribe=One-Click",
  );
  expect(oneClick.status).toBe(200);
  expect(await f.status(ada, double.id)).toBe("unsubscribed");
  expect(await f.status(ada, weekly.id)).toBe("unconfirmed");

  const bobUuid = await uuidOf(f, bob);
  const saved = await act(
    f,
    `/subscription/${placeholder}/${bobUuid}?manage=true`,
    form([["manage", "true"]]),
  );
  expect(saved.status).toBe(200);
  expect(await f.status(bob, double.id)).toBe("unsubscribed");
  expect(await f.status(bob, weekly.id)).toBe("unconfirmed");
});

test("the placeholder's one-click says so when nothing was pending, and says it unsubscribed when it ended a double opt-in (B117f)", async () => {
  // B117b left the one-click answer "You have unsubscribed successfully." for a subscriber whose only memberships are
  // active single opt-ins, which nothing ends. The page says there is nothing to manage instead.
  const f = await open();
  const weekly = await f.list("Weekly", "public", "single");
  const double = await f.list("Double", "public", "double");
  const cy = await f.subscriber("cy@example.test", "Cy", { lists: [weekly.id] });
  const dee = await f.subscriber("dee@example.test", "Dee", { lists: [double.id] });
  const cyUuid = await uuidOf(f, cy);
  const none = await act(f, `/subscription/${placeholder}/${cyUuid}`, "List-Unsubscribe=One-Click");
  expect(none.status).toBe(200);
  const noneText = await none.text();
  expect(noneText).toContain("There is nothing to manage here.");
  expect(noneText).not.toContain("You have unsubscribed successfully.");
  expect(await f.status(cy, weekly.id)).toBe("unconfirmed");

  const deeUuid = await uuidOf(f, dee);
  const ended = await act(
    f,
    `/subscription/${placeholder}/${deeUuid}`,
    "List-Unsubscribe=One-Click",
  );
  expect(ended.status).toBe(200);
  expect(await ended.text()).toContain("You have unsubscribed successfully.");
  expect(await f.status(dee, double.id)).toBe("unsubscribed");
  // The second one-click finds nothing pending any more.
  const again = await act(
    f,
    `/subscription/${placeholder}/${deeUuid}`,
    "List-Unsubscribe=One-Click",
  );
  expect(await again.text()).toContain("There is nothing to manage here.");
});

test("the placeholder's manage view lists and ends pending double opt-ins only, never an active single opt-in", async () => {
  // B117b (D137 item 3): an unconfirmed membership of a single opt-in list is an active subscription
  // (an API create without preconfirm_subscriptions), so the opt-in mail's manage page neither lists it
  // nor ends it.
  const f = await open();
  const news = await f.list("News");
  const weekly = await f.list("Weekly", "public", "single");
  const double = await f.list("Double", "public", "double");
  const ada = await f.subscriber("ada@example.test", "Ada", {
    lists: [news.id, weekly.id, double.id],
  });
  await confirm(f, ada, [news.id]);
  const adaUuid = await uuidOf(f, ada);
  expect(await f.status(ada, weekly.id)).toBe("unconfirmed");

  const manage = await visit(f, `/subscription/${placeholder}/${adaUuid}?manage=true`);
  const html = await manage.text();
  expect(html).toContain("Double");
  expect(html).not.toContain("Weekly");
  expect(html).not.toContain("News");

  // A save that keeps nothing ends the pending double opt-in, and leaves the single opt-in alone.
  const saved = await act(
    f,
    `/subscription/${placeholder}/${adaUuid}?manage=true`,
    form([["manage", "true"]]),
  );
  expect(saved.status).toBe(200);
  expect(await f.status(ada, double.id)).toBe("unsubscribed");
  expect(await f.status(ada, weekly.id)).toBe("unconfirmed");
  expect(await f.status(ada, news.id)).toBe("confirmed");
});

test("view in browser answers a subscriber the campaign was delivered to, and no one else", async () => {
  const f = await open();
  const news = await f.list("News");
  const ada = await f.subscriber("ada@example.test", "Ada", { lists: [news.id] });
  const bob = await f.subscriber("bob@example.test", "Bob", { lists: [news.id] });
  const adaUuid = await uuidOf(f, ada);
  const bobUuid = await uuidOf(f, bob);
  const weekly = delivered(f, news.id, [ada]);

  const view = await visit(f, `/campaign/${weekly.uuid}/${adaUuid}`);
  expect(view.status).toBe(200);
  expect(await view.text()).toContain("Hello");

  // Bob was never delivered this campaign, and an absent subscriber is the same answer.
  const unpaired = await visit(f, `/campaign/${weekly.uuid}/${bobUuid}`);
  const absent = await visit(f, `/campaign/${weekly.uuid}/${crypto.randomUUID()}`);
  expect(unpaired.status).toBe(404);
  expect(absent.status).toBe(404);
  const unpairedText = await unpaired.text();
  expect(unpairedText).toBe(await absent.text());
  expect(unpairedText).not.toContain("Hello");

  // The test placeholder keeps its test page (D117).
  const testView = await visit(f, `/campaign/00000000-0000-0000-0000-000000000001/${adaUuid}`);
  expect(testView.status).toBe(200);
  expect(await testView.text()).toContain("This link is from a test send.");
});
