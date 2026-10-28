import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";

test("compiled lists and grants persist across restart", async () => {
  const admin = { user: "m15-restart-admin", password: "m15-restart-password" };
  await withProduction(
    resolve("dist/iglo.email"),
    AbortSignal.timeout(30_000),
    async (origin, _signal, restart) => {
      for (const notice of [
        "fast-xml-parser@5.11.2",
        "@nodable_entities@3.1.0",
        "fast-xml-builder@1.3.1",
        "is-unsafe@2.0.2",
        "path-expression-matcher@1.6.2",
        "strnum@2.5.1",
        "xml-naming@0.3.0",
        "anynum@1.0.1",
      ]) {
        const path = `/admin/static/licenses/${notice}.txt`;
        const response = await fetch(`${origin}${path}`);
        const text = await response.text();
        expect(response.status).toBe(200);
        expect(text).toMatch(/permission is hereby granted/i);
        expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        const head = await fetch(`${origin}${path}`, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe("");
        expect(head.headers.get("cache-control")).toBe(response.headers.get("cache-control"));
        const options = await fetch(`${origin}${path}`, { method: "OPTIONS" });
        expect(options.status).toBe(204);
        expect(options.headers.get("allow")).toBe("OPTIONS, GET, HEAD");
      }
      expect((await fetch(`${origin}/admin/static/licenses/not-a-notice.txt`)).status).toBe(404);
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
