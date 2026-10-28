import { expect, test } from "bun:test";
import { provisionApiUser } from "@/test/contract/owned";
import { startListFixture } from "@/test/lists/fixture";

test("synthetic membership counts and campaign snapshots through HTTP", async () => {
  const fixture = await startListFixture();
  try {
    const credentials = await provisionApiUser(fixture.origin, fixture.admin);
    const auth = `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`;
    async function request(path: string, method = "GET", body?: unknown) {
      return fetch(`${fixture.origin}${path}`, {
        method,
        headers: {
          Authorization: auth,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    const create = async (name: string) =>
      ((await (await request("/api/lists", "POST", { name })).json()) as { data: { id: number } })
        .data.id;
    const first = await create("fixture-count-a"),
      second = await create("fixture-count-b");
    const role = (
      (await (
        await request("/api/roles/lists", "POST", {
          name: "fixture-grants",
          lists: [
            { id: first, permissions: ["list:get"] },
            { id: second, permissions: ["list:get"] },
          ],
        })
      ).json()) as { data: { id: number } }
    ).data;
    const user = (
      (await (
        await request("/api/users", "POST", {
          username: "fixture-preserved",
          type: "api",
          status: "enabled",
          user_role_id: 1,
          list_role_id: role.id,
        })
      ).json()) as { data: { id: number } }
    ).data;
    for (const [status, subscriberStatus] of [
      ["confirmed", "enabled"],
      ["unconfirmed", "blocklisted"],
      ["unsubscribed", "disabled"],
    ])
      expect(
        (await request("/fixture/membership", "POST", { list: first, status, subscriberStatus }))
          .status,
      ).toBe(200);
    expect(
      (
        await request("/fixture/membership", "POST", {
          list: second,
          status: "confirmed",
          subscriberStatus: "enabled",
        })
      ).status,
    ).toBe(200);
    expect(
      (await request("/fixture/campaign", "POST", { list: first, name: "fixture-count-a" })).status,
    ).toBe(200);
    const page = (await (
      await request(
        "/api/lists?query=fixture-count&order_by=subscriber_count&order=desc&per_page=1",
      )
    ).json()) as {
      data: {
        total: number;
        results: { id: number; subscriber_count: number; subscriber_statuses: unknown }[];
      };
    };
    expect(page.data.total).toBe(2);
    expect(page.data.results[0]).toMatchObject({
      id: first,
      subscriber_count: 3,
      subscriber_statuses: { confirmed: 1, unconfirmed: 1, unsubscribed: 1 },
    });
    const minimal = (await (await request("/api/lists?minimal=true")).json()) as {
      data: { results: { id: number; subscriber_statuses: unknown }[] };
    };
    expect(minimal.data.results.find((item) => item.id === first)?.subscriber_statuses).toBeNull();
    fixture.clock.advance(1000);
    expect((await request(`/api/lists/${first}`, "PUT", { name: "renamed fixture" })).status).toBe(
      200,
    );
    let projection = (await (await request("/fixture/references")).json()) as {
      data: { campaigns: unknown[]; subscribers: number; memberships: number };
    };
    expect(projection.data).toEqual({
      campaigns: [{ list_id: first, list_name: "renamed fixture" }],
      subscribers: 4,
      memberships: 4,
    });
    expect((await request(`/api/lists/${first}`, "DELETE")).status).toBe(200);
    projection = (await (await request("/fixture/references")).json()) as typeof projection;
    expect(projection.data).toEqual({
      campaigns: [{ list_id: null, list_name: "renamed fixture" }],
      subscribers: 4,
      memberships: 1,
    });
    expect((await request(`/api/users/${user.id}`)).status).toBe(200);
    const roleProjection = (
      (await (await request("/api/roles/lists?query=fixture-grants")).json()) as {
        data: { id: number; lists: { id: number }[] }[];
      }
    ).data.find((item) => item.id === role.id);
    expect(roleProjection?.lists.map((item) => item.id)).toEqual([second]);
    expect((await request(`/api/lists/${second}`)).status).toBe(200);
    const replacement = await create("replacement fixture");
    expect(replacement).toBeGreaterThan(first);
  } finally {
    await fixture.close();
  }
});
