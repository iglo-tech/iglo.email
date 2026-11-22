import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";
import { readJson } from "@/test/read-body";

test("compiled lists and grants persist across restart", async () => {
  const admin = { user: "m15-restart-admin", password: "m15-restart-password" };
  await withProduction(
    resolve("dist/iglo.email"),
    AbortSignal.timeout(30_000),
    async (origin, _signal, restart) => {
      for (const notice of ["saxes@6.0.0", "xmlchars@2.2.0"]) {
        const path = `/admin/static/licenses/${notice}.txt`;
        const response = await fetch(`${origin}${path}`);
        const text = await response.text();
        expect(response.status).toBe(200);
        expect(text).toMatch(/permission (?:is hereby granted|to use, copy, modify)/i);
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
      for (const absent of ["not-a-notice", "fast-xml-parser@5.11.2", "@nodable_entities@3.1.0"]) {
        expect((await fetch(`${origin}/admin/static/licenses/${absent}.txt`)).status).toBe(404);
      }
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
        await readJson<{ data: { id: number; uuid: string } }>(
          await req("/api/lists", "POST", {
            name: "persistent list",
            description: "stored",
            tags: ["saved tag"],
          }),
        )
      ).data;
      const userRole = (
        await readJson<{ data: { id: number } }>(
          await req("/api/roles/users", "POST", { name: "restart-user", permissions: [] }),
        )
      ).data.id;
      const listRole = (
        await readJson<{ data: { id: number } }>(
          await req("/api/roles/lists", "POST", {
            name: "restart-list",
            lists: [{ id: list.id, permissions: ["list:get"] }],
          }),
        )
      ).data.id;
      const user = (
        await readJson<{ data: { username: string; password: string } }>(
          await req("/api/users", "POST", {
            username: "m15-restart-api",
            type: "api",
            status: "enabled",
            user_role_id: userRole,
            list_role_id: listRole,
          }),
        )
      ).data;
      const limited = `Basic ${btoa(`${user.username}:${user.password}`)}`;
      await restart();
      const response = await req(`/api/lists/${list.id}`, "GET", undefined, limited);
      expect(response.status).toBe(200);
      expect((await readJson<{ data: unknown }>(response)).data).toMatchObject({
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
