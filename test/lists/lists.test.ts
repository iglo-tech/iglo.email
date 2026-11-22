import { expect, test } from "bun:test";
import { provisionApiUser } from "@/test/contract/owned";
import { startListFixture } from "@/test/lists/fixture";
import { readJson } from "@/test/read-body";

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
      (await readJson<{ data: { id: number } }>(await request("/api/lists", "POST", { name }))).data
        .id;
    const first = await create("fixture-count-a"),
      second = await create("fixture-count-b");
    const role = (
      await readJson<{ data: { id: number } }>(
        await request("/api/roles/lists", "POST", {
          name: "fixture-grants",
          lists: [
            { id: first, permissions: ["list:get"] },
            { id: second, permissions: ["list:get"] },
          ],
        }),
      )
    ).data;
    const user = (
      await readJson<{ data: { id: number } }>(
        await request("/api/users", "POST", {
          username: "fixture-preserved",
          type: "api",
          status: "enabled",
          user_role_id: 1,
          list_role_id: role.id,
        }),
      )
    ).data;
    for (const [status, subscriberStatus] of [
      ["confirmed", "enabled"],
      ["unconfirmed", "blocklisted"],
      ["unsubscribed", "disabled"],
    ]) {
      expect(
        (await request("/fixture/membership", "POST", { list: first, status, subscriberStatus }))
          .status,
      ).toBe(200);
    }
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
    const page = await readJson<{
      data: {
        total: number;
        results: Array<{ id: number; subscriber_count: number; subscriber_statuses: unknown }>;
      };
    }>(
      await request(
        "/api/lists?query=fixture-count&order_by=subscriber_count&order=desc&per_page=1",
      ),
    );
    expect(page.data.total).toBe(2);
    expect(page.data.results[0]).toMatchObject({
      id: first,
      subscriber_count: 3,
      subscriber_statuses: { confirmed: 1, unconfirmed: 1, unsubscribed: 1 },
    });
    const minimal = await readJson<{
      data: { results: Array<{ id: number; subscriber_statuses: unknown }> };
    }>(await request("/api/lists?minimal=true"));
    expect(minimal.data.results.find((item) => item.id === first)?.subscriber_statuses).toBeNull();
    const beforeRejected = (await readJson<{ data: unknown }>(await request(`/api/lists/${first}`)))
      .data;
    fixture.clock.advance(1000);
    for (const [contentType, body] of [
      [
        "application/json",
        JSON.stringify({
          Name: "should not rename",
          tags: ["é".repeat(101)],
          description: "should not change",
        }),
      ],
      [
        "application/xml",
        `<List><Name>should not rename</Name><Tags>${"é".repeat(101)}</Tags></List>`,
      ],
    ] as const) {
      const rejected = await fetch(`${fixture.origin}/api/lists/${first}`, {
        method: "PUT",
        headers: { Authorization: auth, "Content-Type": contentType },
        body,
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        message: "Invalid fields: tags",
        code: "invalid_fields",
      });
      expect(
        (await readJson<{ data: unknown }>(await request(`/api/lists/${first}`))).data,
      ).toEqual(beforeRejected);
      expect(
        (await readJson<{ data: { campaigns: unknown } }>(await request("/fixture/references")))
          .data.campaigns,
      ).toEqual([{ list_id: first, list_name: "fixture-count-a" }]);
      const grants = (
        await readJson<{ data: Array<{ id: number; lists: Array<{ id: number }> }> }>(
          await request("/api/roles/lists?query=fixture-grants"),
        )
      ).data.find((x) => x.id === role.id);
      expect(grants?.lists.map((x) => x.id)).toEqual([first, second]);
    }
    fixture.clock.advance(1000);
    expect((await request(`/api/lists/${first}`, "PUT", { name: "renamed fixture" })).status).toBe(
      200,
    );
    let projection = await readJson<{
      data: { campaigns: Array<unknown>; subscribers: number; memberships: number };
    }>(await request("/fixture/references"));
    expect(projection.data).toEqual({
      campaigns: [{ list_id: first, list_name: "renamed fixture" }],
      subscribers: 4,
      memberships: 4,
    });
    expect((await request(`/api/lists/${first}`, "DELETE")).status).toBe(200);
    projection = await readJson<typeof projection>(await request("/fixture/references"));
    expect(projection.data).toEqual({
      campaigns: [{ list_id: null, list_name: "renamed fixture" }],
      subscribers: 4,
      memberships: 1,
    });
    expect((await request(`/api/users/${user.id}`)).status).toBe(200);
    const roleProjection = (
      await readJson<{ data: Array<{ id: number; lists: Array<{ id: number }> }> }>(
        await request("/api/roles/lists?query=fixture-grants"),
      )
    ).data.find((item) => item.id === role.id);
    expect(roleProjection?.lists.map((item) => item.id)).toEqual([second]);
    expect((await request(`/api/lists/${second}`)).status).toBe(200);
    const replacement = await create("replacement fixture");
    expect(replacement).toBeGreaterThan(first);
    expect((await request("/fixture/list-sequence", "POST")).status).toBe(200);
    const high = await request("/api/lists", "POST", { name: "large automatic identity" });
    const highText = await high.text();
    expect(high.status).toBe(200);
    expect(highText).toContain('"id":9007199254740993');
    const highRead = await request("/api/lists/9007199254740993");
    expect(highRead.status).toBe(200);
    expect(await highRead.text()).toContain('"id":9007199254740993');
    const grant = await fetch(`${fixture.origin}/api/roles/lists/${role.id}`, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: '{"name":"Must not replace grants","lists":[{"id":9007199254740993,"permissions":["list:get"]}]}',
    });
    // D34 discloses this pre-existing, fail-closed role-input boundary. It
    // must not round the supplied numeric token or partially replace grants.
    expect(grant.status).toBe(400);
    const afterGrant = (
      await readJson<{ data: Array<{ id: number; lists: Array<{ id: number }> }> }>(
        await request("/api/roles/lists?query=fixture-grants"),
      )
    ).data.find((item) => item.id === role.id);
    expect(afterGrant).toEqual(roleProjection);
    const highUpdate = await request("/api/lists/9007199254740993", "PUT", {
      name: "updated large identity",
    });
    expect(highUpdate.status).toBe(200);
    expect(await highUpdate.text()).toContain('"id":9007199254740993');
    expect((await request("/api/lists/9007199254740993", "DELETE")).status).toBe(200);
    expect((await request("/api/lists/9007199254740993")).status).toBe(400);
    expect((await request(`/api/lists/${second}`)).status).toBe(200);
  } finally {
    await fixture.close();
  }
});
