// What an agent reads from the MCP endpoint before it writes anything (D108): the server
// instructions in the initialize result, and the description of every tool that takes Liquid.
// Both are read through the SDK client, as an agent's client reads them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureProductionBuild } from "@/test/production-build";
import { startProduction, admin, type Production } from "@/test/worked-example/harness";
import { provisionApiUser } from "@/test/contract/owned";

/** The hand-written and generated tools whose subject, body or sender is Liquid (D9). */
const LIQUID_TOOLS = [
  "create_template",
  "update_template",
  "preview_template",
  "create_campaign",
  "update_campaign",
  "preview_campaign",
  "campaign_text",
  "send_campaign_test",
  "update_sequence_step",
  "create_sequence",
  "update_sequence",
  "transact_with_subscriber",
];

/** Input fields that hold Liquid: a subject, a body, an alternative body or a sender address. */
const LIQUID_FIELDS = new Set(["subject", "altbody", "from_email"]);

/** Whether a tool's input schema has a field that holds Liquid, at any depth (`body` as a string or as an object's field). */
function takesLiquid(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const node = schema as { properties?: Record<string, any>; items?: unknown };
  for (const [name, property] of Object.entries(node.properties ?? {})) {
    if (LIQUID_FIELDS.has(name)) return true;
    if (name === "body" && property?.type === "string") return true;
    if (takesLiquid(property)) return true;
  }
  return takesLiquid(node.items);
}

describe("D108 MCP agent guidance", () => {
  let production: Production;
  let adminAuth: string;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let tools: { name: string; description?: string | undefined; inputSchema: any }[];

  beforeAll(async () => {
    await ensureProductionBuild();
    production = await startProduction();
    const creds = await provisionApiUser(production.origin, admin);
    adminAuth = `token ${creds.user}:${creds.token}`;
    client = new Client({ name: "agent-guidance-test", version: "1.0.0" }, { capabilities: {} });
    transport = new StreamableHTTPClientTransport(new URL(`${production.origin}/api/mcp`), {
      requestInit: { headers: { Authorization: adminAuth } },
    });
    await client.connect(transport);
    tools = (await client.listTools()).tools;
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    if (production) {
      await production.stop().catch(() => {});
      await production.close().catch(() => {});
    }
  });

  test("initialize carries instructions of at most about 1,500 characters that name template_reference", () => {
    const instructions = client.getInstructions();
    expect(instructions).toBeTypeOf("string");
    expect(instructions!.length).toBeLessThanOrEqual(1500);
    expect(instructions).toContain("template_reference");
  });

  test("every tool named in the instructions exists in tools/list for an admin credential", () => {
    const instructions = client.getInstructions() ?? "";
    const names = new Set(tools.map((tool) => tool.name));
    // Argument names are backticked too (`subscriber_id`); a tool name must be one of the tools.
    const fields = new Set(
      tools.flatMap((tool) => Object.keys(tool.inputSchema?.properties ?? {})),
    );
    const named = [...instructions.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map(
      (match) => match[1]!,
    );
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(names.has(name) || fields.has(name)).toBe(true);
    // The authoring loop names the tools an agent calls in it.
    for (const name of [
      "template_reference",
      "get_sequence",
      "update_sequence_step",
      "preview_sequence_step",
      "test_sequence_step",
      "get_sends",
      "get_bounces",
    ])
      expect(named).toContain(name);
  });

  test("every tool that takes Liquid says to read template_reference first", () => {
    const liquid = tools.filter((tool) => takesLiquid(tool.inputSchema)).map((tool) => tool.name);
    for (const name of LIQUID_TOOLS) expect(liquid).toContain(name);
    for (const name of liquid) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(tool.description, name).toContain("template_reference");
    }
  });
});
