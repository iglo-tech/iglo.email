import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureProductionBuild } from "@/test/production-build";
import {
  startProduction,
  startMailbox,
  admin,
  type Production,
  type Mailbox,
} from "@/test/worked-example/harness";
import { provisionApiUser } from "@/test/contract/owned";

describe("B34 MCP endpoint tests", () => {
  let production: Production;
  let mailbox: Mailbox;
  let adminCreds: { user: string; token: string };
  let adminAuth: string;
  let adminHeaders: Record<string, string>;

  beforeAll(async () => {
    await ensureProductionBuild();
    production = await startProduction();
    mailbox = await startMailbox();
    adminCreds = await provisionApiUser(production.origin, admin);
    adminAuth = `token ${adminCreds.user}:${adminCreds.token}`;
    adminHeaders = {
      authorization: adminAuth,
      "content-type": "application/json",
    };

    // Configure SMTP to our loopback test sink (Mailpit / sink)
    const settingsRes = await fetch(`${production.origin}/api/settings`, { headers: adminHeaders });
    const settings = (await settingsRes.json()).data;
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
    if (mailbox) {
      await mailbox.close().catch(() => {});
    }
  });

  function createClient(authorization = adminAuth) {
    const client = new Client({ name: "mcp-test-client", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${production.origin}/api/mcp`), {
      requestInit: {
        headers: {
          Authorization: authorization,
        },
      },
    });
    return { client, transport };
  }

  function getTextContent(result: unknown): string {
    const res = result as { content?: Array<{ type: string; text?: string }> };
    return res.content?.[0]?.text ?? "";
  }

  // 1. The SDK client connects, initialize negotiates a version, tools/list returns exactly the tools above with valid schemas.
  test("1. The SDK client connects, initialize negotiates a version, tools/list returns exactly the tools above with valid schemas", async () => {
    const { client, transport } = createClient();
    await client.connect(transport);
    const serverVersion = client.getServerVersion();
    expect(serverVersion).toBeDefined();
    expect(serverVersion?.name).toBe("iglo.email");

    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    const expectedTools = [
      "list_templates",
      "get_template",
      "create_template",
      "update_template",
      "delete_template",
      "preview_template",
      "set_default_template",
      "list_campaigns",
      "get_campaign",
      "update_campaign",
      "preview_campaign",
      "campaign_text",
      "send_campaign_test",
      "template_reference",
    ].sort();

    expect(toolNames).toEqual(expectedTools);

    for (const tool of toolsResult.tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.description!.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }

    await client.close();

    // Initialize with unsupported protocol version replies with server's latest supported version
    const unsupportedInitRes = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 100,
        method: "initialize",
        params: {
          protocolVersion: "2099-01-01",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });
    expect(unsupportedInitRes.status).toBe(200);
    const unsupportedInitBody = await unsupportedInitRes.json();
    expect(unsupportedInitBody.result.protocolVersion).toBe("2025-11-25");
  });

  // 2. Create, update, preview, get and delete a template through MCP; the same template is visible through GET /api/templates/:id and vice versa.
  test("2. Create, update, preview, get and delete a template through MCP; the same template is visible through GET /api/templates/:id and vice versa", async () => {
    const { client, transport } = createClient();
    await client.connect(transport);

    // Create template through MCP
    const createRes = await client.callTool({
      name: "create_template",
      arguments: {
        name: "MCP Layout Test",
        type: "campaign",
        body: '<div class="mcp-layout">{{ content | raw }}</div>',
      },
    });
    expect(createRes.isError).toBeFalsy();
    const createdData = (
      createRes.structuredContent as { data: { id: number; name: string; body: string } }
    ).data;
    const templateId = createdData.id;
    expect(templateId).toBeGreaterThan(0);
    expect(createdData.name).toBe("MCP Layout Test");

    // Visible through GET /api/templates/:id
    const apiGetRes = await fetch(`${production.origin}/api/templates/${templateId}`, {
      headers: adminHeaders,
    });
    expect(apiGetRes.status).toBe(200);
    const apiGetData = (await apiGetRes.json()).data;
    expect(apiGetData.name).toBe("MCP Layout Test");
    expect(apiGetData.body).toBe('<div class="mcp-layout">{{ content | raw }}</div>');

    // Update through MCP
    const updateRes = await client.callTool({
      name: "update_template",
      arguments: {
        id: templateId,
        name: "MCP Layout Updated",
        body: '<div class="mcp-layout-updated">{{ content | raw }}</div>',
      },
    });
    expect(updateRes.isError).toBeFalsy();

    // Verify update visible via API
    const apiGetRes2 = await fetch(`${production.origin}/api/templates/${templateId}`, {
      headers: adminHeaders,
    });
    const apiGetData2 = (await apiGetRes2.json()).data;
    expect(apiGetData2.name).toBe("MCP Layout Updated");
    expect(apiGetData2.body).toBe('<div class="mcp-layout-updated">{{ content | raw }}</div>');

    // Set default template through MCP
    const setDefaultRes = await client.callTool({
      name: "set_default_template",
      arguments: { id: templateId },
    });
    expect(setDefaultRes.isError).toBeFalsy();
    const defaultCheckRes = await fetch(`${production.origin}/api/templates/${templateId}`, {
      headers: adminHeaders,
    });
    const defaultCheckData = (await defaultCheckRes.json()).data;
    expect(defaultCheckData.is_default).toBe(true);

    // Reset default back to template 1 so templateId can be deleted
    await client.callTool({
      name: "set_default_template",
      arguments: { id: 1 },
    });

    // Preview template (both saved and unsaved) through MCP
    const previewSavedRes = await client.callTool({
      name: "preview_template",
      arguments: { id: templateId },
    });
    expect(previewSavedRes.isError).toBeFalsy();
    const savedHtml = getTextContent(previewSavedRes);
    expect(savedHtml).toContain("mcp-layout-updated");

    const previewUnsavedRes = await client.callTool({
      name: "preview_template",
      arguments: {
        template_type: "tx",
        body: "Hello {{ data.name }}!",
      },
    });
    expect(previewUnsavedRes.isError).toBeFalsy();

    // Get template through MCP
    const getRes = await client.callTool({
      name: "get_template",
      arguments: { id: templateId },
    });
    expect(getRes.isError).toBeFalsy();
    const getData = (getRes.structuredContent as { data: { name: string } }).data;
    expect(getData.name).toBe("MCP Layout Updated");

    // Delete template through MCP
    const deleteRes = await client.callTool({
      name: "delete_template",
      arguments: { id: templateId },
    });
    expect(deleteRes.isError).toBeFalsy();

    // Verify deleted through GET /api/templates/:id
    const apiGetRes3 = await fetch(`${production.origin}/api/templates/${templateId}`, {
      headers: adminHeaders,
    });
    expect(apiGetRes3.status).toBe(400);

    await client.close();
  });

  // 3. Permissions: an API user whose role has templates:get but not templates:manage can list/get/preview but create_template returns isError with the API's 403 message and writes nothing; a user without credentials gets HTTP 401 on /api/mcp.
  test("3. Permissions: an API user whose role has templates:get but not templates:manage can list/get/preview but create_template returns isError with the API's 403 message and writes nothing; a user without credentials gets HTTP 401 on /api/mcp", async () => {
    // 1. Check unauthenticated request gets 401
    const unauthRes = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(unauthRes.status).toBe(401);

    // 2. Create a restricted role with only templates:get
    const roleRes = await fetch(`${production.origin}/api/roles/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Templates Reader",
        permissions: ["templates:get"],
      }),
    });
    expect(roleRes.status).toBe(200);
    const roleId = (await roleRes.json()).data.id;

    // Create an API user with this role
    const userRes = await fetch(`${production.origin}/api/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        username: "mcp-reader-user",
        type: "api",
        status: "enabled",
        user_role_id: roleId,
      }),
    });
    expect(userRes.status).toBe(200);
    const userData = (await userRes.json()).data;
    const readerAuth = `token ${userData.username}:${userData.password}`;

    // Connect with reader user
    const { client, transport } = createClient(readerAuth);
    await client.connect(transport);

    // list_templates should succeed
    const listRes = await client.callTool({ name: "list_templates", arguments: {} });
    expect(listRes.isError).toBeFalsy();

    // preview_template should succeed (requires templates:get)
    const previewRes = await client.callTool({
      name: "preview_template",
      arguments: { template_type: "tx", body: "Preview test" },
    });
    expect(previewRes.isError).toBeFalsy();

    // create_template should fail with 403 error message
    const createRes = await client.callTool({
      name: "create_template",
      arguments: {
        name: "Forbidden Template",
        type: "tx",
        subject: "Subj",
        body: "Body",
      },
    });
    expect(createRes.isError).toBe(true);
    const errorText = getTextContent(createRes);
    expect(errorText).toContain("permission denied: templates:manage");

    // Verify create_template wrote nothing
    const verifyListRes = await fetch(`${production.origin}/api/templates`, {
      headers: adminHeaders,
    });
    const templates = (await verifyListRes.json()).data;
    expect(templates.some((t: any) => t.name === "Forbidden Template")).toBe(false);

    await client.close();
  });

  // 4. Campaign: update the body through MCP, preview it, and send_campaign_test delivers one email to Mailpit with the rendered content; a user limited to some lists cannot read a campaign outside them (same result as the HTTP API).
  test("4. Campaign: update the body through MCP, preview it, and send_campaign_test delivers one email to Mailpit with the rendered content; a user limited to some lists cannot read a campaign outside them", async () => {
    // Create a list
    const listRes = await fetch(`${production.origin}/api/lists`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "MCP Test List", type: "public", optin: "single" }),
    });
    expect(listRes.status).toBe(200);
    const listId = (await listRes.json()).data.id;

    // Create a subscriber
    const subEmail = "mcp-subscriber@example.test";
    const subRes = await fetch(`${production.origin}/api/subscribers`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        email: subEmail,
        name: "MCP Subscriber",
        status: "enabled",
        lists: [listId],
      }),
    });
    expect(subRes.status).toBe(200);

    // Create a draft campaign
    const campRes = await fetch(`${production.origin}/api/campaigns`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "MCP Campaign",
        subject: "Original Subject",
        lists: [listId],
        from_email: "noreply@example.test",
        type: "regular",
        content_type: "richtext",
        body: "<p>Original Body</p>",
      }),
    });
    expect(campRes.status).toBe(200);
    const campId = (await campRes.json()).data.id;

    const { client, transport } = createClient();
    await client.connect(transport);

    // Update the campaign body through MCP
    const updateRes = await client.callTool({
      name: "update_campaign",
      arguments: {
        id: campId,
        name: "MCP Campaign",
        lists: [listId],
        subject: "Updated MCP Subject",
        body: "<p>Hello {{ subscriber.name }}, welcome to MCP campaign!</p>",
      },
    });
    expect(updateRes.isError).toBeFalsy();

    // list_campaigns through MCP
    const listCampsRes = await client.callTool({
      name: "list_campaigns",
      arguments: { query: "MCP" },
    });
    expect(listCampsRes.isError).toBeFalsy();
    const listedCamps = (listCampsRes.structuredContent as { data: { results: any[] } }).data
      .results;
    expect(listedCamps.some((c: any) => c.id === campId)).toBe(true);

    // Preview campaign through MCP
    const previewRes = await client.callTool({
      name: "preview_campaign",
      arguments: { id: campId },
    });
    expect(previewRes.isError).toBeFalsy();
    const previewHtml = getTextContent(previewRes);
    expect(previewHtml).toContain("welcome to MCP campaign");

    // Test 2 blocker: campaign_text {id} and preview_campaign {id, template_id} with stored body and attribs
    const campWithAttribsRes = await fetch(`${production.origin}/api/campaigns`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Attribs Campaign",
        subject: "Attribs Subject",
        lists: [listId],
        from_email: "noreply@example.test",
        type: "regular",
        content_type: "richtext",
        body: "<p>STORED BODY {{ campaign.attribs.cta }}</p>",
        attribs: { cta: "CTA-VALUE" },
        headers: [{ "X-Test-Header": "HeaderValue" }],
      }),
    });
    expect(campWithAttribsRes.status).toBe(200);
    const campWithAttribsId = (await campWithAttribsRes.json()).data.id;

    // campaign_text {id} without body must render the stored body and attribs
    const campTextRes = await client.callTool({
      name: "campaign_text",
      arguments: { id: campWithAttribsId },
    });
    expect(campTextRes.isError).toBeFalsy();
    const campTextOutput = getTextContent(campTextRes);
    expect(campTextOutput).toContain("STORED BODY CTA-VALUE");

    // preview_campaign {id, template_id} without body must render the stored body and attribs
    const previewWithTplRes = await client.callTool({
      name: "preview_campaign",
      arguments: { id: campWithAttribsId, template_id: 1 },
    });
    expect(previewWithTplRes.isError).toBeFalsy();
    const previewWithTplHtml = getTextContent(previewWithTplRes);
    expect(previewWithTplHtml).toContain("STORED BODY CTA-VALUE");

    // Test 4 blocker: update_campaign changing only subject preserves attribs, headers, and lists
    const updateSubjectOnlyRes = await client.callTool({
      name: "update_campaign",
      arguments: {
        id: campWithAttribsId,
        subject: "Brand New Subject Only",
      },
    });
    expect(updateSubjectOnlyRes.isError).toBeFalsy();

    const getCampRes = await fetch(`${production.origin}/api/campaigns/${campWithAttribsId}`, {
      headers: adminHeaders,
    });
    expect(getCampRes.status).toBe(200);
    const updatedCampData = (await getCampRes.json()).data;
    expect(updatedCampData.subject).toBe("Brand New Subject Only");
    expect(updatedCampData.attribs).toEqual({ cta: "CTA-VALUE" });
    expect(updatedCampData.headers).toEqual([{ "X-Test-Header": "HeaderValue" }]);
    expect(updatedCampData.lists.map((l: any) => l.id)).toContain(listId);

    // Test 3 blocker: send_campaign_test with a client sending ONLY declared fields (id and subscribers)
    const testSendDeclaredOnlyRes = await client.callTool({
      name: "send_campaign_test",
      arguments: {
        id: campWithAttribsId,
        subscribers: [subEmail],
      },
    });
    expect(testSendDeclaredOnlyRes.isError).toBeFalsy();

    const mailDeclaredOnly = await mailbox.one(subEmail, "Brand New Subject Only");
    expect(mailDeclaredOnly.body).toContain("STORED BODY CTA-VALUE");

    // Test send delivers one email to Mailpit / sink with rendered content
    const testSendRes = await client.callTool({
      name: "send_campaign_test",
      arguments: {
        id: campId,
        name: "MCP Campaign",
        lists: [listId],
        subject: "Updated MCP Subject",
        from_email: "noreply@example.test",
        content_type: "richtext",
        body: "<p>Hello {{ subscriber.name }}, welcome to MCP campaign!</p>",
        subscribers: [subEmail],
      },
    });
    expect(testSendRes.isError).toBeFalsy();

    // Verify email was received by mailbox
    const mail = await mailbox.one(subEmail, "Updated MCP Subject");
    expect(mail.body).toContain("Hello MCP Subscriber, welcome to MCP campaign!");

    // Create a second list and campaign for permission boundary check
    const otherListRes = await fetch(`${production.origin}/api/lists`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "Other List", type: "public", optin: "single" }),
    });
    const otherListId = (await otherListRes.json()).data.id;

    // Create a list role that only has access to otherListId
    const listRoleRes = await fetch(`${production.origin}/api/roles/lists`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Other List Role",
        lists: [{ id: otherListId, permissions: ["list:get", "list:manage"] }],
      }),
    });
    expect(listRoleRes.status).toBe(200);
    const listRoleId = (await listRoleRes.json()).data.id;

    // Create a user role with campaigns:get and campaigns:manage (list-scoped)
    const userRoleRes = await fetch(`${production.origin}/api/roles/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Scoped Campaigner",
        permissions: ["campaigns:get", "campaigns:manage"],
      }),
    });
    expect(userRoleRes.status).toBe(200);
    const scopedUserRoleId = (await userRoleRes.json()).data.id;

    // Create an API user with these roles
    const scopedUserRes = await fetch(`${production.origin}/api/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        username: "mcp-scoped-user",
        type: "api",
        status: "enabled",
        user_role_id: scopedUserRoleId,
        list_role_id: listRoleId,
      }),
    });
    expect(scopedUserRes.status).toBe(200);
    const scopedUserData = (await scopedUserRes.json()).data;
    const scopedAuth = `token ${scopedUserData.username}:${scopedUserData.password}`;

    // That user cannot read a campaign outside their lists
    const { client: scopedClient, transport: scopedTransport } = createClient(scopedAuth);
    await scopedClient.connect(scopedTransport);

    const forbiddenCampRes = await scopedClient.callTool({
      name: "get_campaign",
      arguments: { id: campId },
    });
    expect(forbiddenCampRes.isError).toBe(true);
    const forbiddenText = getTextContent(forbiddenCampRes);
    expect(forbiddenText.toLowerCase()).toContain("permission denied: campaigns:get");

    await scopedClient.close();
    await client.close();
  });

  // 5. Invalid Liquid in update_template returns isError with the API's validation message, and the stored template is unchanged.
  test("5. Invalid Liquid in update_template returns isError with the API's validation message, and the stored template is unchanged", async () => {
    const { client, transport } = createClient();
    await client.connect(transport);

    // Create a valid template
    const createRes = await client.callTool({
      name: "create_template",
      arguments: {
        name: "Liquid Test Template",
        type: "campaign",
        body: "<header>Safe</header>{{ content | raw }}",
      },
    });
    const templateId = (createRes.structuredContent as { data: { id: number } }).data.id;

    // Update with invalid Liquid syntax
    const badUpdateRes = await client.callTool({
      name: "update_template",
      arguments: {
        id: templateId,
        body: "{% if unclosed_tag %}hello",
      },
    });
    expect(badUpdateRes.isError).toBe(true);
    const errorText = getTextContent(badUpdateRes);
    expect(errorText.toLowerCase()).toContain("invalid");

    // Stored template is unchanged
    const getRes = await client.callTool({
      name: "get_template",
      arguments: { id: templateId },
    });
    expect(getRes.isError).toBeFalsy();
    const storedBody = (getRes.structuredContent as { data: { body: string } }).data.body;
    expect(storedBody).toBe("<header>Safe</header>{{ content | raw }}");

    // Clean up
    await client.callTool({ name: "delete_template", arguments: { id: templateId } });
    await client.close();
  });

  // 6. Malformed JSON-RPC (bad JSON, unknown method, missing id/params) gets the spec's JSON-RPC error codes, no crash, no write; request bodies are size-bounded like other API bodies.
  test("6. Malformed JSON-RPC (bad JSON, unknown method, missing id/params) gets the spec's JSON-RPC error codes, no crash, no write; request bodies are size-bounded like other API bodies", async () => {
    // Record baseline template and campaign counts
    const tplCountBefore = (
      await (await fetch(`${production.origin}/api/templates`, { headers: adminHeaders })).json()
    ).data.length;
    const campCountBefore = (
      await (await fetch(`${production.origin}/api/campaigns`, { headers: adminHeaders })).json()
    ).data.total;

    // 1. Bad JSON -> -32700 Parse error
    const badJsonRes = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: adminHeaders,
      body: '{"jsonrpc": "2.0", "bad json',
    });
    expect(badJsonRes.status).toBe(200);
    const badJsonBody = await badJsonRes.json();
    expect(badJsonBody.error?.code).toBe(-32700);

    // 2. Unknown method -> -32601 Method not found
    const unknownMethodRes = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "non_existent_method" }),
    });
    expect(unknownMethodRes.status).toBe(200);
    const unknownBody = await unknownMethodRes.json();
    expect(unknownBody.error?.code).toBe(-32601);
    expect(unknownBody.id).toBe(42);

    // 3. Invalid params -> -32602 Invalid params
    const badParamsRes = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 43,
        method: "tools/call",
        params: "not an object",
      }),
    });
    expect(badParamsRes.status).toBe(200);
    const badParamsBody = await badParamsRes.json();
    expect(badParamsBody.error?.code).toBe(-32602);

    // 4. Notifications: message without id returns HTTP 202 with no body and executes no tool
    const notifCancelledRes = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 },
      }),
    });
    expect(notifCancelledRes.status).toBe(202);
    expect(await notifCancelledRes.text()).toBe("");

    // tools/call without id is a notification: returns 202 with no body and does not create anything
    const toolCallNoIdRes = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "create_template",
          arguments: {
            name: "Notification Template",
            type: "campaign",
            body: "{{ content | raw }}",
          },
        },
      }),
    });
    expect(toolCallNoIdRes.status).toBe(202);
    expect(await toolCallNoIdRes.text()).toBe("");

    // 5. Invalid id types (boolean, float, object, null) get -32600
    for (const badId of [true, 1.5, { obj: "id" }, null]) {
      const badIdRes = await fetch(`${production.origin}/api/mcp`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: badId, method: "ping" }),
      });
      expect(badIdRes.status).toBe(200);
      const badIdBody = await badIdRes.json();
      expect(badIdBody.error?.code).toBe(-32600);
    }

    // 6. JSON array batch gets -32600
    const batchRes = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ]),
    });
    expect(batchRes.status).toBe(200);
    const batchBody = await batchRes.json();
    expect(batchBody.error?.code).toBe(-32600);
    expect(batchBody.error?.message).toContain("Batch requests are not supported");

    // 7. MCP-Protocol-Version request header validation
    const badVersionHeaderRes = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: {
        ...adminHeaders,
        "mcp-protocol-version": "unsupported-version-1.0",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 50, method: "ping" }),
    });
    expect(badVersionHeaderRes.status).toBe(400);
    const badVersionHeaderBody = await badVersionHeaderRes.json();
    expect(badVersionHeaderBody.error?.code).toBe(-32000);

    // 8. GET /api/mcp -> 405 Method Not Allowed
    const getRes = await fetch(`${production.origin}/api/mcp`, {
      method: "GET",
      headers: { authorization: adminAuth },
    });
    expect(getRes.status).toBe(405);

    // 9. Foreign Origin header -> 403 Forbidden
    const badOriginRes = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: {
        ...adminHeaders,
        origin: "https://evil.attacker.test",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 44, method: "ping" }),
    });
    expect(badOriginRes.status).toBe(403);

    // 10. Request body over size limit -> 413 Payload Too Large
    const oversizedBody = "x".repeat(3 * 1024 * 1024);
    const oversizedRes = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: adminHeaders,
      body: oversizedBody,
    });
    expect(oversizedRes.status).toBe(413);

    // Assert "writes nothing": template and campaign counts unchanged
    const tplCountAfter = (
      await (await fetch(`${production.origin}/api/templates`, { headers: adminHeaders })).json()
    ).data.length;
    const campCountAfter = (
      await (await fetch(`${production.origin}/api/campaigns`, { headers: adminHeaders })).json()
    ).data.total;
    expect(tplCountAfter).toBe(tplCountBefore);
    expect(campCountAfter).toBe(campCountBefore);
  });

  // 7. template_reference matches the doc section.
  test("7. template_reference matches the doc section", async () => {
    const { client, transport } = createClient();
    await client.connect(transport);

    const refRes = await client.callTool({
      name: "template_reference",
      arguments: {},
    });
    expect(refRes.isError).toBeFalsy();
    const text = getTextContent(refRes);

    // Read doc section from docs/design/06-templates.md
    const docPath = resolve(import.meta.dir, "../../docs/design/06-templates.md");
    const docContent = await readFile(docPath, "utf8");

    // The tool's text must match the documentation section: Liquid variables, tags and filters table and examples
    const startMarker = "### Template reference for agents";
    const endMarker = "### Internal renderer implementation notes";
    const expectedSection = docContent
      .slice(docContent.indexOf(startMarker), docContent.indexOf(endMarker))
      .trim();
    expect(text.trim()).toBe(expectedSection);

    await client.close();
  });
});
