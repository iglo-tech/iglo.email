// B80 / D57: `order` takes asc, ASC and Asc alike on every endpoint whose API document lists it.
// This is a deliberate difference: upstream's documented ASC sorts descending (listmonk
// internal/core/core.go makeSearchQuery at 6fcd95f), so docs/design/07-api-and-ui.md names it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensureProductionBuild } from "@/test/production-build";
import { startProduction, admin, type Production } from "@/test/worked-example/harness";
import { provisionApiUser } from "@/test/contract/owned";

const ASCENDING = ["asc", "ASC", "Asc"];
const DESCENDING = ["desc", "DESC", "Desc"];

describe("order takes any case on every endpoint that documents it (B80)", () => {
  let production: Production;
  let headers: Record<string, string>;

  beforeAll(async () => {
    await ensureProductionBuild();
    production = await startProduction();
    const creds = await provisionApiUser(production.origin, admin);
    headers = {
      authorization: `token ${creds.user}:${creds.token}`,
      "content-type": "application/json",
    };
  }, 60_000);

  afterAll(async () => {
    if (production) {
      await production.stop().catch(() => {});
      await production.close().catch(() => {});
    }
  });

  async function api(method: string, path: string, body?: unknown) {
    const response = await fetch(`${production.origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: (await response.json()) as any };
  }

  /**
   * Checks the names one endpoint returns for each spelling of `order`: every ascending spelling gives
   * `ascending`, every descending spelling gives its reverse. `path` ends before the order parameter.
   */
  async function expectOrder(
    path: string,
    rows: (json: any) => { name: string }[],
    ascending: string[],
  ) {
    for (const order of ASCENDING) {
      const reply = await api("GET", `${path}&order=${order}`);
      expect(reply.status).toBe(200);
      expect(rows(reply.json).map((row) => row.name)).toEqual(ascending);
    }
    for (const order of DESCENDING) {
      const reply = await api("GET", `${path}&order=${order}`);
      expect(reply.status).toBe(200);
      expect(rows(reply.json).map((row) => row.name)).toEqual([...ascending].reverse());
    }
  }

  test("GET /api/lists", async () => {
    for (const name of ["B80 Lists Zeta", "B80 Lists Alpha", "B80 Lists Mid"])
      expect((await api("POST", "/api/lists", { name, type: "public" })).status).toBe(200);
    await expectOrder("/api/lists?query=B80%20Lists&order_by=name", (json) => json.data.results, [
      "B80 Lists Alpha",
      "B80 Lists Mid",
      "B80 Lists Zeta",
    ]);
  });

  test("GET /api/templates", async () => {
    for (const name of ["B80 Tpl Zeta", "B80 Tpl Alpha"]) {
      const created = await api("POST", "/api/templates", {
        name,
        type: "campaign",
        body: "<p>B80</p>{{ content | raw }}",
      });
      expect(created.status).toBe(200);
    }
    await expectOrder("/api/templates?query=B80%20Tpl&order_by=name", (json) => json.data, [
      "B80 Tpl Alpha",
      "B80 Tpl Zeta",
    ]);
  });

  test("GET /api/campaigns", async () => {
    const list = await api("POST", "/api/lists", { name: "B80 Camp List", type: "public" });
    for (const name of ["B80 Camp Zeta", "B80 Camp Alpha"]) {
      const created = await api("POST", "/api/campaigns", {
        name,
        subject: name,
        from_email: "noreply@example.test",
        lists: [list.json.data.id],
        body: "<p>B80</p>",
      });
      expect(created.status).toBe(200);
    }
    await expectOrder(
      "/api/campaigns?query=B80%20Camp&order_by=name",
      (json) => json.data.results,
      ["B80 Camp Alpha", "B80 Camp Zeta"],
    );
  });

  test("GET /api/subscribers", async () => {
    for (const [name, email] of [
      ["Zeta", "zeta-b80ord@example.test"],
      ["Alpha", "alpha-b80ord@example.test"],
    ])
      expect(
        (await api("POST", "/api/subscribers", { email, name, status: "enabled" })).status,
      ).toBe(200);
    await expectOrder(
      "/api/subscribers?search=b80ord&order_by=email",
      (json) => json.data.results.map((row: { email: string }) => ({ name: row.email })),
      ["alpha-b80ord@example.test", "zeta-b80ord@example.test"],
    );
  });

  test("GET /api/users", async () => {
    const role = await api("POST", "/api/roles/users", {
      name: "B80 Order Role",
      permissions: ["subscribers:get"],
    });
    expect(role.status).toBe(200);
    for (const username of ["b80-zeta", "b80-alpha"]) {
      const created = await api("POST", "/api/users", {
        username,
        type: "api",
        status: "enabled",
        user_role_id: role.json.data.id,
      });
      expect(created.status).toBe(200);
    }
    // Only the two users above, so the administrator and the bootstrap users stay out of the list.
    await expectOrder(
      "/api/users?order_by=username",
      (json) => json.data.filter((row: { username: string }) => row.username.startsWith("b80-")),
      ["b80-alpha", "b80-zeta"],
    );
  });

  test("GET /api/roles/users", async () => {
    for (const name of ["B80 Role Zeta", "B80 Role Alpha"]) {
      const created = await api("POST", "/api/roles/users", {
        name,
        permissions: ["subscribers:get"],
      });
      expect(created.status).toBe(200);
    }
    await expectOrder("/api/roles/users?query=B80%20Role&order_by=name", (json) => json.data, [
      "B80 Role Alpha",
      "B80 Role Zeta",
    ]);
  });
});
