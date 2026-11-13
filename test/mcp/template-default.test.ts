// B80: create_template and update_template take is_default. true makes the saved template the
// default once the save succeeded, and the answer is the template read back (one is_default).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensureProductionBuild } from "@/test/production-build";
import { startProduction, admin, type Production } from "@/test/worked-example/harness";
import { provisionApiUser } from "@/test/contract/owned";

describe("create_template and update_template take is_default (B80)", () => {
  let production: Production;
  let adminAuth: string;
  let adminHeaders: Record<string, string>;
  let nextId = 1;

  beforeAll(async () => {
    await ensureProductionBuild();
    production = await startProduction();
    const creds = await provisionApiUser(production.origin, admin);
    adminAuth = `token ${creds.user}:${creds.token}`;
    adminHeaders = { authorization: adminAuth, "content-type": "application/json" };
  }, 60_000);

  afterAll(async () => {
    if (production) {
      await production.stop().catch(() => {});
      await production.close().catch(() => {});
    }
  });

  async function rpc(method: string, params?: unknown) {
    const response = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: { authorization: adminAuth, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    return (await response.json()) as { result?: any; error?: { code: number; message: string } };
  }

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    const reply = await rpc("tools/call", { name, arguments: args });
    if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
    return reply.result as {
      isError?: boolean;
      content: { type: string; text: string }[];
      structuredContent?: any;
    };
  }

  async function api(method: string, path: string, body?: unknown) {
    const response = await fetch(`${production.origin}${path}`, {
      method,
      headers: adminHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: (await response.json()) as any };
  }

  /** The ID of the template that is the default, as the API lists it. */
  async function defaultId(): Promise<number[]> {
    const listed = (await api("GET", "/api/templates")).json.data as {
      id: number;
      is_default: boolean;
    }[];
    return listed.filter((template) => template.is_default).map((template) => template.id);
  }

  test("create_template with is_default: true makes the new campaign template the default and returns it as read back", async () => {
    const created = await callTool("create_template", {
      name: "B80 Default Layout",
      type: "campaign",
      body: "<p>B80</p>{{ content | raw }}",
      is_default: true,
    });
    expect(created.isError).toBeFalsy();
    const id = created.structuredContent.data.id;
    expect(created.structuredContent.data).toMatchObject({ id, is_default: true });
    expect(created.structuredContent.default).toBeUndefined();
    expect(await defaultId()).toEqual([id]);

    const fetched = await callTool("get_template", { id });
    expect(fetched.structuredContent.data.is_default).toBe(true);
  });

  test("update_template with is_default: true moves the default; is_default: false leaves it alone", async () => {
    const other = await callTool("create_template", {
      name: "B80 Other Layout",
      type: "campaign",
      body: "<p>B80 other</p>{{ content | raw }}",
    });
    expect(other.isError).toBeFalsy();
    const id = other.structuredContent.data.id;
    const before = await defaultId();
    expect(before).not.toContain(id);

    const moved = await callTool("update_template", { id, is_default: true });
    expect(moved.isError).toBeFalsy();
    expect(moved.structuredContent.data).toMatchObject({ id, is_default: true });
    expect(moved.structuredContent.default).toBeUndefined();
    expect(await defaultId()).toEqual([id]);
    expect((await callTool("get_template", { id })).structuredContent.data.is_default).toBe(true);

    const kept = await callTool("update_template", {
      id,
      name: "B80 Other Renamed",
      is_default: false,
    });
    expect(kept.isError).toBeFalsy();
    expect(kept.structuredContent.default).toBeUndefined();
    expect(await defaultId()).toEqual([id]);
  });

  test("a saved template that cannot become the default is a tool error that says it was saved", async () => {
    // Only a campaign template can be the default, so a tx template saves and then fails the default call.
    const refused = await callTool("create_template", {
      name: "B80 Tx Layout",
      type: "tx",
      subject: "B80 subject",
      body: "<p>B80 tx</p>",
      is_default: true,
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(
      /^Template \d+ was saved, but it was not made the default: /,
    );
    expect(refused.structuredContent).toBeUndefined();

    const saved = (await api("GET", "/api/templates")).json.data.find(
      (template: { name: string }) => template.name === "B80 Tx Layout",
    );
    expect(saved).toBeDefined();
    expect(saved.is_default).toBe(false);
    expect(refused.content[0]!.text).toContain(`Template ${saved.id} was saved`);
  });
});
