// What an agent reads from the MCP endpoint before it writes anything (D108): the server
// instructions in the initialize result, and the description of every tool that takes Liquid.
// Both are read through the SDK client, as an agent's client reads them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureProductionBuild } from "@/test/production-build";
import { startProduction, admin } from "@/test/worked-example/harness";
import type { Production } from "@/test/worked-example/harness";
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

/** Backticked words in the instructions that are values, not tool or argument names. */
const PROSE_WORDS = new Set(["true", "false", "null"]);

/** The schemas a schema is built from: union members (`anyOf`, `oneOf`, `allOf`), at its own level. */
function unionMembers(node: Record<string, any>): Array<unknown> {
  return [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])];
}

/** Whether a schema accepts a string, directly or through a union. */
function acceptsString(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) {
    return false;
  }
  const node = schema as Record<string, any>;
  return node.type === "string" || unionMembers(node).some(acceptsString);
}

/**
 * Whether a tool's input schema has a field that holds Liquid, at any depth: a `body` that takes a
 * string, or a field named in LIQUID_FIELDS. Unions are followed, so a field under `anyOf` counts.
 */
function takesLiquid(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) {
    return false;
  }
  const node = schema as Record<string, any>;
  for (const [name, property] of Object.entries<any>(node.properties ?? {})) {
    if (LIQUID_FIELDS.has(name)) {
      return true;
    }
    if (name === "body" && acceptsString(property)) {
      return true;
    }
    if (takesLiquid(property)) {
      return true;
    }
  }
  if (takesLiquid(node.items)) {
    return true;
  }
  return unionMembers(node).some(takesLiquid);
}

/** Every property name of a schema at any depth, through `items` and union members. */
function propertyNames(schema: unknown, into = new Set<string>()): Set<string> {
  if (typeof schema !== "object" || schema === null) {
    return into;
  }
  const node = schema as Record<string, any>;
  for (const [name, property] of Object.entries<any>(node.properties ?? {})) {
    into.add(name);
    propertyNames(property, into);
  }
  propertyNames(node.items, into);
  for (const member of unionMembers(node)) {
    propertyNames(member, into);
  }
  return into;
}

/** The instructions split at each full stop and paragraph break: a sentence. */
function sentences(text: string): Array<string> {
  return text
    .split(/\.\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** The instructions split at each sentence end, semicolon and paragraph break: a step. */
function steps(text: string): Array<string> {
  return text
    .split(/[.;]\s+|\n+/)
    .map((step) => step.trim())
    .filter(Boolean);
}

/** The backticked words of a sentence or step, in order. */
function backticked(text: string): Array<string> {
  return [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((match) => match[1]!);
}

describe("D108 MCP agent guidance", () => {
  let production: Production;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let tools: Array<{ name: string; description?: string | undefined; inputSchema: any }>;

  beforeAll(async () => {
    await ensureProductionBuild();
    production = await startProduction();
    const creds = await provisionApiUser(production.origin, admin);
    const adminAuth = `token ${creds.user}:${creds.token}`;
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

  test("every tool named in the instructions exists, and every argument is one of the tool named with it", () => {
    const instructions = client.getInstructions() ?? "";
    const toolNames = new Set(tools.map((tool) => tool.name));
    const argumentsByTool = new Map(
      tools.map((tool) => [tool.name, propertyNames(tool.inputSchema)]),
    );
    const named = steps(instructions).flatMap(backticked);
    expect(named.length).toBeGreaterThan(0);
    const failures: Array<string> = [];
    for (const step of steps(instructions)) {
      const words = backticked(step);
      const toolsHere = words.filter((word) => toolNames.has(word));
      const allowed = new Set(toolsHere.flatMap((name) => [...argumentsByTool.get(name)!]));
      for (const word of words) {
        // Any other backticked word is an argument, and must belong to a tool named in this step.
        if (toolNames.has(word) || PROSE_WORDS.has(word)) {
          continue;
        }
        if (!toolsHere.length || !allowed.has(word)) {
          failures.push(`\`${word}\` in: ${step.slice(0, 80)}`);
        }
      }
    }
    expect(failures).toEqual([]);
    // The authoring loop names the tools an agent calls in it.
    for (const name of [
      "template_reference",
      "get_sequence",
      "update_sequence_step",
      "preview_sequence_step",
      "test_sequence_step",
      "get_sends",
      "get_bounces",
    ]) {
      expect(named).toContain(name);
    }
  });

  test("no sentence that tells a test send names a send or bounce list: a test writes no send row", () => {
    const testSentences = sentences(client.getInstructions() ?? "").filter((sentence) =>
      /test_sequence_step|send_campaign_test|\btest sends?\b/i.test(sentence),
    );
    expect(testSentences.length).toBeGreaterThan(0);
    for (const sentence of testSentences) {
      expect(sentence, sentence).not.toMatch(/get_sends|get_bounces/);
    }
  });

  test("a test send that fails to deliver is named with get_logs, which is a tool", () => {
    const instructions = client.getInstructions() ?? "";
    expect(tools.map((tool) => tool.name)).toContain("get_logs");
    const failures = sentences(instructions).filter(
      (sentence) => /\btest\b/i.test(sentence) && /fails? to deliver/i.test(sentence),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("`get_logs`");
  });

  test("reading users and roles is a tool, and only changes to them are excluded", () => {
    const instructions = client.getInstructions() ?? "";
    const toolNames = new Set(tools.map((tool) => tool.name));
    for (const name of ["get_users", "get_user_roles"]) {
      expect(toolNames.has(name), name).toBe(true);
      expect(instructions).toContain(`\`${name}\``);
    }
    expect(instructions).toContain("changes to users and roles");
    expect(instructions).toContain("bulk deletes");
    expect(instructions).toContain("deletes addressed by a query");
    expect(instructions).not.toMatch(/irreversible/);
    expect(toolNames.has("delete_subscriber")).toBe(true);
  });

  test("every tool that takes Liquid says to read template_reference first", () => {
    const liquid = tools.filter((tool) => takesLiquid(tool.inputSchema)).map((tool) => tool.name);
    for (const name of LIQUID_TOOLS) {
      expect(liquid).toContain(name);
    }
    for (const name of liquid) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(tool.description, name).toContain("template_reference");
    }
  });
});
