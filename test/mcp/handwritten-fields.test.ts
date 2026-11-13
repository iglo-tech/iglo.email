// B79 / D98: a hand-written tool takes every field of the operations it covers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensureProductionBuild } from "@/test/production-build";
import {
  startProduction,
  startMailbox,
  admin,
  type Production,
  type Mailbox,
} from "@/test/worked-example/harness";
import { provisionApiUser } from "@/test/contract/owned";
import { HANDWRITTEN_COVERAGE } from "@/mcp/coverage";

/** The API field a hand-written tool takes under its own argument name: `dir` is the `order` of getCampaigns. */
const ARGUMENT_FOR: Record<string, Record<string, string>> = {
  list_campaigns: { order: "dir" },
};

/**
 * Fields of a covered operation that its tool deliberately does not take, with the reason. The tool
 * keeps the stored value, and no argument for the field exists.
 */
const NOT_TAKEN: Record<string, Record<string, string>> = {
  update_campaign: { type: "the endpoint keeps the stored type of a campaign" },
};

type Schema = {
  $ref?: string;
  properties?: Record<string, unknown>;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
};
type Document = {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, Schema> };
};

/**
 * The property names of a schema, following a $ref and every allOf, oneOf and anyOf part, so none is
 * missed: a branch of a composed body names fields the tool must take as well.
 */
function propertiesOf(document: Document, schema: Schema | undefined): string[] {
  if (!schema) return [];
  if (schema.$ref)
    return propertiesOf(document, document.components.schemas[schema.$ref.split("/").pop()!]);
  return [
    ...Object.keys(schema.properties ?? {}),
    ...(schema.allOf ?? []).flatMap((part) => propertiesOf(document, part)),
    ...(schema.oneOf ?? []).flatMap((part) => propertiesOf(document, part)),
    ...(schema.anyOf ?? []).flatMap((part) => propertiesOf(document, part)),
  ];
}

/**
 * The query parameter names and body property names of an operation, as the API document states them.
 * `declared` is true when the operation has query parameters or a structured request body (a $ref,
 * allOf, oneOf, anyOf or properties), so a test can require that some field was found for it. A
 * free-form body names no field and is not declared.
 */
function fieldsOf(
  document: Document,
  operationId: string,
): { query: string[]; body: string[]; declared: boolean } {
  for (const item of Object.values(document.paths)) {
    for (const operation of Object.values<any>(item)) {
      if (operation.operationId !== operationId) continue;
      const query = (operation.parameters ?? [])
        .filter((parameter: any) => parameter.in === "query")
        .map((parameter: any) => parameter.name as string);
      const schema: Schema | undefined = Object.values<any>(operation.requestBody?.content ?? {})[0]
        ?.schema;
      const structured =
        schema !== undefined &&
        ("$ref" in schema ||
          "allOf" in schema ||
          "oneOf" in schema ||
          "anyOf" in schema ||
          "properties" in schema);
      return {
        query,
        body: propertiesOf(document, schema),
        declared: query.length > 0 || structured,
      };
    }
  }
  throw new Error(`no operation ${operationId} in the API document`);
}

describe("B79 hand-written MCP tools take every field of their operations (D98)", () => {
  let production: Production;
  let mailbox: Mailbox;
  let adminAuth: string;
  let adminHeaders: Record<string, string>;
  let nextId = 1;

  beforeAll(async () => {
    await ensureProductionBuild();
    production = await startProduction();
    mailbox = await startMailbox();
    const creds = await provisionApiUser(production.origin, admin);
    adminAuth = `token ${creds.user}:${creds.token}`;
    adminHeaders = { authorization: adminAuth, "content-type": "application/json" };

    // Mail goes to the loopback sink only (AGENTS.md: tests never use a real SMTP server).
    const settings = (
      await (await fetch(`${production.origin}/api/settings`, { headers: adminHeaders })).json()
    ).data;
    await fetch(`${production.origin}/api/settings/smtp`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify([
        {
          ...settings.smtp[0],
          enabled: true,
          host: "127.0.0.1",
          port: mailbox.port,
          auth_protocol: "none",
          username: "",
          password: "",
          tls_type: "none",
          email_headers: [],
        },
      ]),
    });
  }, 60_000);

  afterAll(async () => {
    if (production) {
      await production.stop().catch(() => {});
      await production.close().catch(() => {});
    }
    if (mailbox) await mailbox.close().catch(() => {});
  });

  /** A JSON-RPC call to POST /api/mcp as the admin. */
  async function rpc(method: string, params?: unknown) {
    const response = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: { authorization: adminAuth, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    return (await response.json()) as {
      result?: any;
      error?: { code: number; message: string };
    };
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

  async function createList(name: string, type: string, optin: string): Promise<number> {
    const created = await api("POST", "/api/lists", { name, type, optin });
    expect(created.status).toBe(200);
    return created.json.data.id;
  }

  test("tools/list: each query parameter and body field of a covered operation is an argument of its tool", async () => {
    const document = (await (
      await fetch(`${production.origin}/api/openapi.json`, { headers: adminHeaders })
    ).json()) as Document;
    const tools = (await rpc("tools/list")).result.tools as {
      name: string;
      inputSchema: { properties?: Record<string, unknown> };
    }[];
    const argumentNames = new Map(
      tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {})]),
    );

    const missing: string[] = [];
    // A schema that yields no fields would pass this test empty, so each operation that declares
    // fields must yield some, and the count must cover every covered operation.
    let checked = 0;
    for (const [operationId, toolName] of Object.entries(HANDWRITTEN_COVERAGE)) {
      const names = argumentNames.get(toolName);
      if (!names) {
        missing.push(`${toolName} is not a tool`);
        continue;
      }
      const { query, body, declared } = fieldsOf(document, operationId);
      const fields = [...query, ...body];
      if (declared) expect(fields.length, `${operationId} declares fields`).toBeGreaterThan(0);
      checked += fields.length;
      for (const field of fields) {
        if (NOT_TAKEN[toolName]?.[field]) {
          expect(names).not.toContain(field);
          continue;
        }
        const argument = ARGUMENT_FOR[toolName]?.[field] ?? field;
        if (!names.includes(argument))
          missing.push(`${toolName} lacks ${argument} (${operationId})`);
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(Object.keys(HANDWRITTEN_COVERAGE).length);
  });

  test("an object given for a query parameter is a tool error, not a search for [object Object]", async () => {
    const refused = await callTool("list_templates", { query: { name: "B79" } });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("query");
    expect(refused.structuredContent).toBeUndefined();

    const refusedInArray = await callTool("list_campaigns", { tag: [{ tag: "b80" }] });
    expect(refusedInArray.isError).toBe(true);
    expect(refusedInArray.content[0]!.text).toContain("tag");
  });

  test("create_campaign takes type and the archive fields: an opt-in campaign and its archive settings are stored as sent", async () => {
    const listId = await createList("B79 Opt-in List", "public", "double");

    const optin = await callTool("create_campaign", {
      name: "B79 Opt-in Campaign",
      subject: "B79 Opt-in Subject",
      from_email: "noreply@example.test",
      lists: [listId],
      type: "optin",
    });
    expect(optin.isError).toBeFalsy();
    expect(optin.structuredContent.data.type).toBe("optin");
    const stored = (await api("GET", `/api/campaigns/${optin.structuredContent.data.id}`)).json
      .data;
    expect(stored.type).toBe("optin");

    const archived = await callTool("create_campaign", {
      name: "B79 Archived Campaign",
      subject: "B79 Archived Subject",
      from_email: "noreply@example.test",
      lists: [listId],
      archive: true,
      archive_slug: "b79-archived-campaign",
    });
    expect(archived.isError).toBeFalsy();
    expect(archived.structuredContent.data.archive).toBe(true);
    expect(archived.structuredContent.data.archive_slug).toBe("b79-archived-campaign");
  });

  test("list_lists takes order_by, order and type: the same answer as GET /api/lists with those parameters", async () => {
    for (const name of ["B79 Lists Zeta", "B79 Lists Alpha", "B79 Lists Mid"])
      await createList(name, "public", "single");
    await createList("B79 Lists Private", "private", "single");

    const ascending = await callTool("list_lists", {
      query: "B79 Lists",
      order_by: "name",
      order: "asc",
      type: "public",
    });
    expect(ascending.isError).toBeFalsy();
    const names = (ascending.structuredContent.data.results as { name: string }[]).map(
      (list) => list.name,
    );
    expect(names).toEqual(["B79 Lists Alpha", "B79 Lists Mid", "B79 Lists Zeta"]);

    const descending = await callTool("list_lists", {
      query: "B79 Lists",
      order_by: "name",
      order: "desc",
      type: "public",
    });
    expect(
      (descending.structuredContent.data.results as { name: string }[]).map((list) => list.name),
    ).toEqual(["B79 Lists Zeta", "B79 Lists Mid", "B79 Lists Alpha"]);

    const rest = await api(
      "GET",
      "/api/lists?query=B79%20Lists&order_by=name&order=asc&type=public",
    );
    expect(rest.json.data.results.map((list: any) => list.id)).toEqual(
      ascending.structuredContent.data.results.map((list: any) => list.id),
    );
  });

  test("list_campaigns takes dir, type and tag; get_campaign takes no_body", async () => {
    const listId = await createList("B79 Sort List", "public", "single");
    for (const name of ["B79 Sort Alpha", "B79 Sort Zulu"]) {
      const created = await callTool("create_campaign", {
        name,
        subject: name,
        from_email: "noreply@example.test",
        lists: [listId],
        body: `<p>Body of ${name}</p>`,
        tags: ["b79-sort"],
      });
      expect(created.isError).toBeFalsy();
    }

    const names = async (dir: string) =>
      (
        (
          await callTool("list_campaigns", {
            query: "B79 Sort",
            order_by: "name",
            dir,
            tag: ["b79-sort"],
            type: "regular",
          })
        ).structuredContent.data.results as { name: string }[]
      ).map((campaign) => campaign.name);
    expect(await names("ASC")).toEqual(["B79 Sort Alpha", "B79 Sort Zulu"]);
    expect(await names("DESC")).toEqual(["B79 Sort Zulu", "B79 Sort Alpha"]);

    const id = (await callTool("list_campaigns", { query: "B79 Sort Alpha" })).structuredContent
      .data.results[0].id;
    const withBody = await callTool("get_campaign", { id });
    expect(withBody.structuredContent.data.body).toContain("Body of B79 Sort Alpha");
    const withoutBody = await callTool("get_campaign", { id, no_body: true });
    expect(withoutBody.structuredContent.data.body).toBe("");
  });

  test("send_campaign_test renders the template given as template_id, not the stored one", async () => {
    const stored = await api("POST", "/api/templates", {
      name: "B79 Stored Layout",
      type: "campaign",
      body: "<p>B79-LAYOUT-STORED</p>{{ content | raw }}",
    });
    const chosen = await api("POST", "/api/templates", {
      name: "B79 Chosen Layout",
      type: "campaign",
      body: "<p>B79-LAYOUT-CHOSEN</p>{{ content | raw }}",
    });
    const listId = await createList("B79 Test Send List", "public", "single");
    const email = "b79-test-send@example.test";
    const subscriber = await api("POST", "/api/subscribers", {
      email,
      name: "B79 Test Send",
      status: "enabled",
      lists: [listId],
    });
    expect(subscriber.status).toBe(200);

    const campaign = await callTool("create_campaign", {
      name: "B79 Test Send Campaign",
      subject: "B79 Test Send Subject",
      from_email: "noreply@example.test",
      lists: [listId],
      body: "<p>Hello</p>",
      template_id: stored.json.data.id,
    });
    expect(campaign.isError).toBeFalsy();

    const sent = await callTool("send_campaign_test", {
      id: campaign.structuredContent.data.id,
      subscribers: [email],
      template_id: chosen.json.data.id,
    });
    expect(sent.isError).toBeFalsy();

    const mail = await mailbox.one(email, "B79 Test Send Subject");
    expect(mail.body).toContain("B79-LAYOUT-CHOSEN");
    expect(mail.body).not.toContain("B79-LAYOUT-STORED");
  }, 60_000);
});
