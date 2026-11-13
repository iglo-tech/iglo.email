// B82: an API user whose role has templates:manage but not templates:get can save a template as the
// default through MCP. The read-back is refused, so the tool answers from the saved template with
// is_default: true (the fallback in src/mcp/tools.ts makeDefault). The admin sees one saved template
// that is the default.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensureProductionBuild } from "@/test/production-build";
import { startProduction, admin, type Production } from "@/test/worked-example/harness";
import { provisionApiUser } from "@/test/contract/owned";

type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: any;
};

describe("MCP template default fallback for a user without templates:get (B82)", () => {
  let production: Production;
  let adminAuth: string;
  let writerAuth: string;
  let nextId = 1;

  beforeAll(async () => {
    await ensureProductionBuild();
    production = await startProduction();
    const creds = await provisionApiUser(production.origin, admin);
    adminAuth = `token ${creds.user}:${creds.token}`;

    const roleResponse = await fetch(`${production.origin}/api/roles/users`, {
      method: "POST",
      headers: { authorization: adminAuth, "content-type": "application/json" },
      body: JSON.stringify({ name: "B82 Template Writer", permissions: ["templates:manage"] }),
    });
    expect(roleResponse.status).toBe(200);
    const roleId = ((await roleResponse.json()) as { data: { id: number } }).data.id;

    const userResponse = await fetch(`${production.origin}/api/users`, {
      method: "POST",
      headers: { authorization: adminAuth, "content-type": "application/json" },
      body: JSON.stringify({
        username: "b82-template-writer",
        type: "api",
        status: "enabled",
        user_role_id: roleId,
      }),
    });
    expect(userResponse.status).toBe(200);
    const writer = ((await userResponse.json()) as { data: { username: string; password: string } })
      .data;
    writerAuth = `token ${writer.username}:${writer.password}`;
  }, 60_000);

  afterAll(async () => {
    if (production) {
      await production.stop().catch(() => {});
      await production.close().catch(() => {});
    }
  });

  async function rpc(auth: string, name: string, args: Record<string, unknown>) {
    const response = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    if (response.status !== 200) {
      throw new Error(`${name}: /api/mcp answered HTTP ${response.status}, expected 200`);
    }
    return (await response.json()) as { result?: ToolResult; error?: { message: string } };
  }

  /** Calls an MCP tool as the given API user and returns its result. */
  async function callTool(auth: string, name: string, args: Record<string, unknown>) {
    const reply = await rpc(auth, name, args);
    if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
    return reply.result as ToolResult;
  }

  async function api(auth: string, method: string, path: string, body?: unknown) {
    const response = await fetch(`${production.origin}${path}`, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: (await response.json()) as any };
  }

  /** The templates the admin lists, as the API returns them. */
  async function listedTemplates(): Promise<{ id: number; name: string; is_default: boolean }[]> {
    return (await api(adminAuth, "GET", "/api/templates")).json.data;
  }

  /** The IDs of every template that is the default, as the admin sees them. */
  async function defaultIds(): Promise<number[]> {
    return (await listedTemplates())
      .filter((template) => template.is_default)
      .map((template) => template.id);
  }

  test("the writer's read-back is refused: GET is 403 without templates:get", async () => {
    // Precondition for the fallback: the writer can save but cannot read back.
    const listed = await api(writerAuth, "GET", "/api/templates");
    expect(listed.status).toBe(403);
    const one = await api(writerAuth, "GET", "/api/templates/1");
    expect(one.status).toBe(403);
  });

  test("create_template with is_default: true saves once, makes it the default, and reports is_default: true without the read-back", async () => {
    const created = await callTool(writerAuth, "create_template", {
      name: "B82 Fallback Layout",
      type: "campaign",
      body: "<p>B82</p>{{ content | raw }}",
      is_default: true,
    });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent.data).toMatchObject({
      name: "B82 Fallback Layout",
      is_default: true,
    });
    const id = created.structuredContent.data.id;
    expect(id).toEqual(expect.any(Number));

    // Admin: exactly one saved template with this name, and it is the only default.
    const saved = (await listedTemplates()).filter(
      (template) => template.name === "B82 Fallback Layout",
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]!.id).toBe(id);
    expect(saved[0]!.is_default).toBe(true);
    expect(await defaultIds()).toEqual([id]);

    const fetched = await api(adminAuth, "GET", `/api/templates/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.json.data.is_default).toBe(true);
  });

  test("update_template with is_default: true changes the template as the writer, and the admin sees the default once", async () => {
    // The admin creates the target, so the writer only has templates:manage to change it.
    const target = await api(adminAuth, "POST", "/api/templates", {
      name: "B82 Update Target",
      type: "campaign",
      body: "<p>B82 target</p>{{ content | raw }}",
    });
    expect(target.status).toBe(200);
    const id = target.json.data.id;
    expect(await defaultIds()).not.toContain(id);

    const updated = await callTool(writerAuth, "update_template", {
      id,
      name: "B82 Update Renamed",
      is_default: true,
    });
    expect(updated.isError).toBeFalsy();
    expect(updated.structuredContent.data).toMatchObject({
      id,
      name: "B82 Update Renamed",
      is_default: true,
    });

    const renamed = (await listedTemplates()).filter(
      (template) => template.name === "B82 Update Renamed",
    );
    expect(renamed).toHaveLength(1);
    expect(renamed[0]!.id).toBe(id);
    expect(await defaultIds()).toEqual([id]);

    // The tool's answer is the template the admin reads back, field for field.
    const readBack = await api(adminAuth, "GET", `/api/templates/${id}`);
    expect(readBack.status).toBe(200);
    expect(updated.structuredContent.data).toEqual(readBack.json.data);
    expect((await listedTemplates()).some((t) => t.name === "B82 Update Target")).toBe(false);
  });
});
