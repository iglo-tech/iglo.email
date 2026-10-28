import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";

test("compiled lists and grants persist across restart", async () => {
  const admin = { user: "m15-restart-admin", password: "m15-restart-password" };
  await withProduction(
    resolve("dist/iglo.email"),
    AbortSignal.timeout(30_000),
    async (origin, _signal, restart) => {
      const credentials = await provisionApiUser(origin, admin);
      const auth = `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`;
      async function req(path: string, method = "GET", body?: unknown, authorization = auth) {
        return fetch(`${origin}${path}`, {
          method,
          headers: {
            Authorization: authorization,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      }
      const list = (
        (await (
          await req("/api/lists", "POST", {
            name: "persistent list",
            description: "stored",
            tags: ["saved tag"],
          })
        ).json()) as { data: { id: number; uuid: string } }
      ).data;
      const userRole = (
        (await (
          await req("/api/roles/users", "POST", { name: "restart-user", permissions: [] })
        ).json()) as { data: { id: number } }
      ).data.id;
      const listRole = (
        (await (
          await req("/api/roles/lists", "POST", {
            name: "restart-list",
            lists: [{ id: list.id, permissions: ["list:get"] }],
          })
        ).json()) as { data: { id: number } }
      ).data.id;
      const user = (
        (await (
          await req("/api/users", "POST", {
            username: "m15-restart-api",
            type: "api",
            status: "enabled",
            user_role_id: userRole,
            list_role_id: listRole,
          })
        ).json()) as { data: { username: string; password: string } }
      ).data;
      const limited = `Basic ${btoa(`${user.username}:${user.password}`)}`;
      await restart();
      const response = await req(`/api/lists/${list.id}`, "GET", undefined, limited);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { data: unknown }).data).toMatchObject({
        id: list.id,
        uuid: list.uuid,
        name: "persistent list",
        description: "stored",
        tags: ["saved-tag"],
        type: "private",
        optin: "single",
        status: "active",
        subscriber_count: 0,
      });
      expect((await req(`/api/lists/${list.id}`, "PUT", { name: "denied" }, limited)).status).toBe(
        403,
      );
    },
    admin,
  );
}, 40_000);
