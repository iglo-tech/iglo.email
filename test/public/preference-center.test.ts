// B149d (D167): the preference center's profile save, through HTTP on the public fixture. A campaign
// delivered to the subscriber pairs the manage view (D126); the fields come from the page's settings.
import { afterEach, expect, test } from "bun:test";
import type { PreferenceField } from "@/public/preference-fields";
import { EVENT_ATTRIBS_BYTES } from "@/subscribers/store";
import { publicFixture } from "@/test/public/fixture";
import type { PublicFixture } from "@/test/public/fixture";
import { asBody } from "@/test/read-body";

const fixtures: Array<PublicFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});

const field = (key: string, type: PreferenceField["type"]): PreferenceField => ({
  key,
  label: key === "born" ? "Born" : "Bio",
  type,
  editable: true,
  required: false,
  min: null,
  max: null,
  options: [],
});

async function managed(attribs: Record<string, string> = {}, bornLabel = "Born") {
  const f = await publicFixture();
  fixtures.push(f);
  Object.assign(f.overrides, {
    preferenceFields: [{ ...field("born", "date"), label: bornLabel }, field("bio", "text")],
  });
  const news = await f.list("News");
  const other = await f.list("Other");
  const ada = await f.subscriber("ada@example.test", "Ada", {
    lists: [news.id],
    attribs,
    preconfirm_subscriptions: true,
  });
  const uuid = asBody<string>((await f.json(`/api/subscribers/${ada}`)).body.data.uuid);
  const campaign = f.deliveredCampaign([ada], [news.id]);
  const page = `/subscription/${campaign}/${uuid}`;
  const read = async () => {
    const data = asBody<Record<string, any>>((await f.json(`/api/subscribers/${ada}`)).body.data);
    return {
      name: data.name,
      attribs: data.attribs,
      news: await f.status(ada, news.id),
      other: await f.status(ada, other.id),
    };
  };
  const save = (values: Array<[string, string]>) =>
    f.fresh(
      page,
      new URLSearchParams([
        ["manage", "true"],
        ["profile", "true"],
        ["name", "Ada Renamed"],
        ["l", other.uuid],
        ...values,
      ]).toString(),
    );
  return { read, save };
}

test("a date in the years 0000 to 0099 is a real calendar date; an impossible one is refused", async () => {
  const { read, save } = await managed();
  for (const date of ["0000-02-29", "0050-12-31", "0099-01-01", "1999-12-31"]) {
    const saved = await save([["attribs.born", date]]);
    expect({ date, status: saved.status }).toEqual({ date, status: 200 });
    expect((await read()).attribs.born).toBe(date);
  }
  // 0100 is not a leap year, 0000 is (proleptic Gregorian): only real dates are taken.
  const before = await read();
  for (const date of ["0100-02-29", "0001-02-29", "0050-13-01", "0050-00-10"]) {
    const refused = await save([["attribs.born", date]]);
    expect({ date, status: refused.status }).toEqual({ date, status: 400 });
    expect(await refused.text()).toContain("Born");
  }
  expect(await read()).toEqual(before);
});

test("attributes that would pass the size limit answer the page's 400, and nothing is written", async () => {
  // Stored attributes just under the limit, so the bio below pushes them past it.
  const filler = "x".repeat(EVENT_ATTRIBS_BYTES - 200);
  const { read, save } = await managed({ filler });
  const before = await read();
  expect(before).toMatchObject({ name: "Ada", news: "confirmed", other: undefined });
  const refused = await save([["attribs.bio", "y".repeat(500)]]);
  expect(refused.status).toBe(400);
  expect(refused.headers.get("content-type")).toContain("text/html");
  expect(await refused.text()).toContain("Your details could not be saved: they are too large.");
  // The rename, the unchecked News, the checked Other and the bio: none of it happened.
  expect(await read()).toEqual(before);
  // A save that fits still works.
  const saved = await save([["attribs.bio", "short"]]);
  expect(saved.status).toBe(200);
  expect(await read()).toMatchObject({ name: "Ada Renamed", news: "unsubscribed" });
});

test("B170 (D198): a field label with $ patterns appears in the invalid-fields message as written", async () => {
  const { save } = await managed({}, "Budget ($$ $& $')");
  const refused = await save([["attribs.born", "0050-13-01"]]);
  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain("Budget ($$ $&amp; $&#39;)");
});
