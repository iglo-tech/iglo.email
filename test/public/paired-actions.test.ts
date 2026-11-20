// B123 (D126): a public action that changes a subscriber needs a pairing the server issued: a
// campaign the runner delivered to that subscriber, a marketing send to them, or the placeholder
// campaign of the mail the server sent them (opt-in and preferences). A subscriber UUID alone
// blocklists, exports or wipes nobody. Through HTTP, on the public fixture with the SMTP sink and
// the effects spy; the campaign deliveries come from the runner's own claim.
import { afterEach, expect, test } from "bun:test";
import { publicFixture, type PublicFixture } from "@/test/public/fixture";

const fixtures: PublicFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
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
const form = (values: [string, string][]) => new URLSearchParams(values).toString();

/** A POST from a new peer, so the per-peer limits stay out of the way. */
const act = (f: PublicFixture, path: string, body = "") => f.fresh(path, body);
const visit = (f: PublicFixture, path: string) => f.peer(path, `198.51.100.${++peers}`);

/** A campaign the runner has delivered to each of these subscribers: the pairing D126 names. */
const delivered = (f: PublicFixture, list: number, subscribers: number[]) => ({
  uuid: f.deliveredCampaign(subscribers, [list]),
});

const uuidOf = async (f: PublicFixture, id: number) =>
  (await f.json(`/api/subscribers/${id}`)).body.data.uuid as string;
const subscriberOf = async (f: PublicFixture, id: number) =>
  (await f.json(`/api/subscribers/${id}`)).body.data;

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
  const attacks: [string, string][] = [
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
  const answers: string[] = [];
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

  // The control: Ada's own link from her delivery blocklists her, and the effect runs once.
  const real = await act(f, `/subscription/${weekly.uuid}/${adaUuid}`, "blocklist=true");
  expect(real.status).toBe(200);
  expect((await subscriberOf(f, ada)).status).toBe("blocklisted");
  expect(f.calls).toHaveLength(1);
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

  expect((await act(f, `/subscription/${weekly.uuid}/wipe/${adaUuid}`)).status).toBe(200);
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
  expect((await subscriberOf(f, ada)).name).toBe("Ada Two");
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
  expect(manage).toContain('name="name"');
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
  const send = (await f.json(`/api/sends/${sent.body.data.sends[0].id}`)).body.data.uuid as string;

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

  expect((await act(f, `/m/${send}/wipe/${adaUuid}`)).status).toBe(200);
  expect((await f.json(`/api/subscribers/${ada}`)).status).toBe(400);
  expect((await subscriberOf(f, bob)).status).toBe("enabled");
});
