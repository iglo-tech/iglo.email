// B124 (D125): after a self-wipe, a public signup is not a marketing grant. A single opt-in list
// gets no membership; a double opt-in list gets an unconfirmed one and its opt-in mail. Only the
// person's own confirmation clears the suppression. Through HTTP, on the public fixture with the
// SMTP sink, the paired wipe (D126) and the subscribers API.
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

const address = "wiped@example.test";
const form = (values: [string, string][]) => new URLSearchParams(values).toString();

test("a public signup after a wipe grants nothing on single opt-in, and its own double opt-in confirmation clears the suppression", async () => {
  const f = await open();
  const news = await f.list("News");
  const double = await f.list("Double", "public", "double");
  const ada = await f.subscriber(address, "Ada", { lists: [news.id] });
  const camp = f.deliveredCampaign([ada], [news.id]);
  const uuid = (await f.json(`/api/subscribers/${ada}`)).body.data.uuid as string;
  const current = () => Number(f.owners.subscribers.byEmail(address)!.id);
  const suppressions = () =>
    Number((f.db.query("SELECT count(*) AS n FROM suppressions").get() as { n: bigint }).n);

  // The person wipes through the campaign they were delivered.
  expect((await f.fresh(`/subscription/${camp}/wipe/${uuid}`)).status).toBe(200);
  expect(suppressions()).toBe(1);

  // Single opt-in: the form answers as usual, and the person joins nothing.
  expect(
    (
      await f.fresh(
        "/subscription/form",
        form([
          ["email", address],
          ["name", "Ada"],
          ["l", news.uuid],
        ]),
      )
    ).status,
  ).toBe(200);
  expect(await f.status(current(), news.id)).toBeUndefined();

  // Double opt-in: the person joins unconfirmed and gets the opt-in mail, which is theirs to act on.
  expect(
    (
      await f.fresh(
        "/subscription/form",
        form([
          ["email", address],
          ["name", "Ada"],
          ["l", double.uuid],
        ]),
      )
    ).status,
  ).toBe(200);
  expect(await f.status(current(), double.id)).toBe("unconfirmed");
  await f.drain();
  expect(f.mailTo(address)).toHaveLength(1);
  // Still suppressed until confirmed.
  expect(suppressions()).toBe(1);

  // The person confirms from the opt-in mail's link: that is their own consent again.
  const confirm = await f.fresh(
    `/subscription/optin/${(await f.json(`/api/subscribers/${current()}`)).body.data.uuid}`,
    form([
      ["l", double.uuid],
      ["confirm", "true"],
    ]),
  );
  expect(confirm.status).toBe(200);
  expect(await f.status(current(), double.id)).toBe("confirmed");
  expect(suppressions()).toBe(0);
});

test("an import row of a suppressed address is imported with no list, and other rows keep theirs", async () => {
  const f = await open();
  const news = await f.list("News");
  const ada = await f.subscriber(address, "Ada", { lists: [news.id] });
  const camp = f.deliveredCampaign([ada], [news.id]);
  const uuid = (await f.json(`/api/subscribers/${ada}`)).body.data.uuid as string;
  expect((await f.fresh(`/subscription/${camp}/wipe/${uuid}`)).status).toBe(200);

  // The importer's batch is the store's own `importSubscribe`, which it calls for each batch of
  // rows. The importer's file path is covered by test/import, which cannot wipe a person first.
  const other = "other@example.test";
  f.owners.subscribers.importSubscribe(
    [
      { email: address, name: "Ada", attribs: "{}" },
      { email: other, name: "Other", attribs: "{}" },
    ],
    {
      listIds: [BigInt(news.id)],
      status: "confirmed",
      overwriteUserInfo: false,
      overwriteStatus: false,
    },
    { deliveries: 0 },
  );
  const row = f.owners.subscribers.byEmail(address)!;
  expect(await f.status(Number(row.id), news.id)).toBeUndefined();
  const kept = f.owners.subscribers.byEmail(other)!;
  expect(await f.status(Number(kept.id), news.id)).toBe("confirmed");
});
