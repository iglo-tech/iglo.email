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
      "create_campaign",
      "list_lists",
      "list_media",
      "list_sequences",
      "get_sequence",
      "update_sequence_step",
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
    expect(updatedCampData.lists.map((l: any) => l.id)).toEqual([listId]);

    {
      // Create a second list that is not attached to campWithAttribsId
      const otherListRes = await fetch(`${production.origin}/api/lists`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ name: "MCP Other List", type: "public", optin: "single" }),
      });
      expect(otherListRes.status).toBe(200);
      const otherListId = (await otherListRes.json()).data.id;

      // Caller-supplied invalid list IDs must return isError and leave stored campaign lists unchanged
      const updateInvalidTypeRes = await client.callTool({
        name: "update_campaign",
        arguments: {
          id: campWithAttribsId,
          lists: [otherListId, "1"],
        },
      });
      expect(updateInvalidTypeRes.isError).toBe(true);

      const getCampAfterInvalidType = await fetch(
        `${production.origin}/api/campaigns/${campWithAttribsId}`,
        { headers: adminHeaders },
      );
      expect(getCampAfterInvalidType.status).toBe(200);
      const campDataAfterInvalidType = (await getCampAfterInvalidType.json()).data;
      expect(campDataAfterInvalidType.lists.map((l: any) => l.id)).toEqual([listId]);

      // Negative list ID: update_campaign with [otherListId, -5] must give the same result as direct PUT
      // (success, and stored lists become exactly [otherListId])
      const updateNegativeIdRes = await client.callTool({
        name: "update_campaign",
        arguments: {
          id: campWithAttribsId,
          lists: [otherListId, -5],
        },
      });
      expect(updateNegativeIdRes.isError).toBeFalsy();

      const getCampAfterNegativeId = await fetch(
        `${production.origin}/api/campaigns/${campWithAttribsId}`,
        { headers: adminHeaders },
      );
      expect(getCampAfterNegativeId.status).toBe(200);
      const campDataAfterNegativeId = (await getCampAfterNegativeId.json()).data;
      expect(campDataAfterNegativeId.lists.map((l: any) => l.id)).toEqual([otherListId]);
    }

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

    // Blocker 2: upload media, attach to campaign, delete media, then update_campaign and send_campaign_test succeed
    const mediaForm = new FormData();
    mediaForm.append(
      "file",
      new Blob(["fake png content"], { type: "image/png" }),
      "deleted-test.png",
    );
    const uploadRes = await fetch(`${production.origin}/api/media`, {
      method: "POST",
      headers: { authorization: adminAuth },
      body: mediaForm,
    });
    expect(uploadRes.status).toBe(200);
    const mediaId = (await uploadRes.json()).data.id;

    // Create campaign with attached media
    const campWithMediaRes = await fetch(`${production.origin}/api/campaigns`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Media Campaign",
        subject: "Subject Before Media Delete",
        lists: [listId],
        from_email: "noreply@example.test",
        type: "regular",
        content_type: "richtext",
        body: "<p>Media test body</p>",
        media: [mediaId],
      }),
    });
    expect(campWithMediaRes.status).toBe(200);
    const campWithMediaId = (await campWithMediaRes.json()).data.id;

    // Delete the uploaded media
    const deleteMediaRes = await fetch(`${production.origin}/api/media/${mediaId}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(deleteMediaRes.status).toBe(200);

    // update_campaign (subject only) should succeed despite deleted media (reports id: null)
    const updateAfterMediaDelRes = await client.callTool({
      name: "update_campaign",
      arguments: {
        id: campWithMediaId,
        subject: "Subject After Media Delete",
      },
    });
    expect(updateAfterMediaDelRes.isError).toBeFalsy();

    const getCampAfterMediaDel = await fetch(
      `${production.origin}/api/campaigns/${campWithMediaId}`,
      { headers: adminHeaders },
    );
    expect(getCampAfterMediaDel.status).toBe(200);
    expect((await getCampAfterMediaDel.json()).data.subject).toBe("Subject After Media Delete");

    // send_campaign_test should also succeed
    const testSendAfterMediaDelRes = await client.callTool({
      name: "send_campaign_test",
      arguments: {
        id: campWithMediaId,
        subscribers: [subEmail],
      },
    });
    expect(testSendAfterMediaDelRes.isError).toBeFalsy();
    const mailMediaDel = await mailbox.one(subEmail, "Subject After Media Delete");
    expect(mailMediaDel.body).toContain("Media test body");

    // Optional / Blocker 2: campaign with two lists, delete one list, update_campaign with subject only still succeeds
    const listDel1Res = await fetch(`${production.origin}/api/lists`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "Deleted List 1", type: "public", optin: "single" }),
    });
    const listDel1Id = (await listDel1Res.json()).data.id;
    const listDel2Res = await fetch(`${production.origin}/api/lists`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "Retained List 2", type: "public", optin: "single" }),
    });
    const listDel2Id = (await listDel2Res.json()).data.id;

    const campTwoListsRes = await fetch(`${production.origin}/api/campaigns`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Two Lists Campaign",
        subject: "Initial Two Lists Subject",
        lists: [listDel1Id, listDel2Id],
        from_email: "noreply@example.test",
        type: "regular",
        content_type: "richtext",
        body: "<p>Two lists body</p>",
      }),
    });
    expect(campTwoListsRes.status).toBe(200);
    const campTwoListsId = (await campTwoListsRes.json()).data.id;

    const delListRes = await fetch(`${production.origin}/api/lists/${listDel1Id}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(delListRes.status).toBe(200);

    const updateTwoListsRes = await client.callTool({
      name: "update_campaign",
      arguments: {
        id: campTwoListsId,
        subject: "Updated Subject With One List Deleted",
      },
    });
    expect(updateTwoListsRes.isError).toBeFalsy();

    const getCampTwoLists = await fetch(`${production.origin}/api/campaigns/${campTwoListsId}`, {
      headers: adminHeaders,
    });
    expect(getCampTwoLists.status).toBe(200);
    const campTwoListsData = (await getCampTwoLists.json()).data;
    expect(campTwoListsData.subject).toBe("Updated Subject With One List Deleted");
    expect(campTwoListsData.lists.some((l: any) => l.id === listDel2Id)).toBe(true);

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

  // 8. Cookie session authentication: write tool succeeds with cookie + CSRF token, and fails without/invalid CSRF token
  test("8. Cookie session authentication: write tool succeeds with cookie + CSRF token, and fails without/invalid CSRF token", async () => {
    // 1. Log in through real login flow
    const loginPage = await fetch(`${production.origin}/admin/login`);
    const loginHtml = await loginPage.text();
    const nonce = /name="nonce"\s+value="([^"]+)"/.exec(loginHtml)![1]!;
    const nonceCookie = loginPage.headers
      .getSetCookie()
      .find((v) => v.startsWith("nonce="))!
      .split(";", 1)[0]!;

    const loginRes = await fetch(`${production.origin}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: nonceCookie,
      },
      body: new URLSearchParams({
        username: admin.user,
        password: admin.password,
        nonce,
      }),
    });
    expect(loginRes.status).toBe(302);
    const cookies = loginRes.headers.getSetCookie();
    const sessionCookie = cookies.find((v) => v.startsWith("session="))!.split(";", 1)[0]!;
    const csrfCookie = cookies.find((v) => v.startsWith("csrf="))!.split(";", 1)[0]!;
    const cookieHeader = `${sessionCookie}; ${csrfCookie}`;
    const csrfToken = csrfCookie.replace(/^csrf=/, "");

    // 2. Create template via API to use as test target
    const createTplRes = await fetch(`${production.origin}/api/templates`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Cookie Auth Template Initial",
        type: "tx",
        subject: "Initial Subject",
        body: "Initial Body",
      }),
    });
    expect(createTplRes.status).toBe(200);
    const tplId = (await createTplRes.json()).data.id;

    // 3. Connect via MCP SDK client using session cookie + CSRF token
    const client = new Client(
      { name: "mcp-cookie-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${production.origin}/api/mcp`), {
      requestInit: {
        headers: {
          Cookie: cookieHeader,
          "X-CSRF-Token": csrfToken,
        },
      },
    });
    await client.connect(transport);

    // Read tool over cookie session succeeds
    const readRes = await client.callTool({
      name: "get_template",
      arguments: { id: tplId },
    });
    expect(readRes.isError).toBeFalsy();

    // Write tool (update_template) over MCP with cookie + CSRF token succeeds
    const writeRes = await client.callTool({
      name: "update_template",
      arguments: {
        id: tplId,
        name: "Updated via Cookie+CSRF",
      },
    });
    expect(writeRes.isError).toBeFalsy();
    await client.close();

    // Change is visible via GET
    const verifyGetRes = await fetch(`${production.origin}/api/templates/${tplId}`, {
      headers: adminHeaders,
    });
    expect(verifyGetRes.status).toBe(200);
    expect((await verifyGetRes.json()).data.name).toBe("Updated via Cookie+CSRF");

    // 4. Same call with cookie but NO CSRF token -> refused (403) and nothing written
    const noCsrfRes = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "update_template",
          arguments: {
            id: tplId,
            name: "Should Not Update - Missing CSRF",
          },
        },
      }),
    });
    expect(noCsrfRes.status).toBe(403);

    const verifyNoCsrf = await fetch(`${production.origin}/api/templates/${tplId}`, {
      headers: adminHeaders,
    });
    expect(verifyNoCsrf.status).toBe(200);
    expect((await verifyNoCsrf.json()).data.name).toBe("Updated via Cookie+CSRF");

    // 5. Same call with cookie but INVALID CSRF token -> refused (403) and nothing written
    const invalidCsrfRes = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader,
        "x-csrf-token": "invalid-csrf-token-value",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "update_template",
          arguments: {
            id: tplId,
            name: "Should Not Update - Invalid CSRF",
          },
        },
      }),
    });
    expect(invalidCsrfRes.status).toBe(403);

    const verifyInvalidCsrf = await fetch(`${production.origin}/api/templates/${tplId}`, {
      headers: adminHeaders,
    });
    expect(verifyInvalidCsrf.status).toBe(200);
    expect((await verifyInvalidCsrf.json()).data.name).toBe("Updated via Cookie+CSRF");
  });

  // B39 helpers: plain HTTP API calls for expectations, API users with chosen permissions, and cookie login.
  async function api(method: string, path: string, body?: unknown, headers = adminHeaders) {
    const res = await fetch(`${production.origin}${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, text, json };
  }

  async function createApiUser(username: string, permissions: string[]) {
    const roleRes = await api("POST", "/api/roles/users", {
      name: `${username} role`,
      permissions,
    });
    expect(roleRes.status).toBe(200);
    const userRes = await api("POST", "/api/users", {
      username,
      type: "api",
      status: "enabled",
      user_role_id: roleRes.json.data.id,
    });
    expect(userRes.status).toBe(200);
    return `token ${username}:${userRes.json.data.password}`;
  }

  async function loginCookies() {
    const loginPage = await fetch(`${production.origin}/admin/login`);
    const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await loginPage.text())![1]!;
    const nonceCookie = loginPage.headers
      .getSetCookie()
      .find((v) => v.startsWith("nonce="))!
      .split(";", 1)[0]!;
    const loginRes = await fetch(`${production.origin}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: nonceCookie },
      body: new URLSearchParams({ username: admin.user, password: admin.password, nonce }),
    });
    expect(loginRes.status).toBe(302);
    const cookies = loginRes.headers.getSetCookie();
    const sessionCookie = cookies.find((v) => v.startsWith("session="))!.split(";", 1)[0]!;
    const csrfCookie = cookies.find((v) => v.startsWith("csrf="))!.split(";", 1)[0]!;
    return {
      cookieHeader: `${sessionCookie}; ${csrfCookie}`,
      csrfToken: csrfCookie.replace(/^csrf=/, ""),
    };
  }

  async function uploadMedia(filename: string) {
    const form = new FormData();
    form.append("file", new Blob([`${filename} content`], { type: "image/png" }), filename);
    const res = await fetch(`${production.origin}/api/media`, {
      method: "POST",
      headers: { authorization: adminAuth },
      body: form,
    });
    expect(res.status).toBe(200);
    return (await res.json()).data.id as number;
  }

  const withoutKeys = (value: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

  // 9. list_lists and list_media return what the HTTP API returns, and their query filters the items created through it.
  test("9. list_lists and list_media return what the HTTP API returns, and query filters them", async () => {
    const alpha = await api("POST", "/api/lists", {
      name: "B39 Alpha Newsletter",
      type: "public",
      optin: "single",
    });
    const beta = await api("POST", "/api/lists", {
      name: "B39 Beta Digest",
      type: "public",
      optin: "single",
    });
    expect(alpha.status).toBe(200);
    expect(beta.status).toBe(200);
    const alphaId: number = alpha.json.data.id;
    const betaId: number = beta.json.data.id;
    const mediaId = await uploadMedia("b39-logo.png");

    const { client, transport } = createClient();
    await client.connect(transport);

    const allLists = await client.callTool({ name: "list_lists", arguments: { query: "B39" } });
    expect(allLists.isError).toBeFalsy();
    expect(allLists.structuredContent).toEqual((await api("GET", "/api/lists?query=B39")).json);
    const listIds = (allLists.structuredContent as any).data.results.map((l: any) => l.id);
    expect(listIds).toEqual(expect.arrayContaining([alphaId, betaId]));

    const filtered = await client.callTool({ name: "list_lists", arguments: { query: "Alpha" } });
    expect(filtered.isError).toBeFalsy();
    expect((filtered.structuredContent as any).data.results.map((l: any) => l.id)).toEqual([
      alphaId,
    ]);

    const media = await client.callTool({ name: "list_media", arguments: { query: "b39-logo" } });
    expect(media.isError).toBeFalsy();
    expect(media.structuredContent).toEqual((await api("GET", "/api/media?query=b39-logo")).json);
    const item = (media.structuredContent as any).data.results.find((m: any) => m.id === mediaId);
    expect(item.filename).toBe("b39-logo.png");
    expect(typeof item.url).toBe("string");

    const mediaNone = await client.callTool({
      name: "list_media",
      arguments: { query: "no-such-b39-file" },
    });
    expect(mediaNone.isError).toBeFalsy();
    expect((mediaNone.structuredContent as any).data.results).toEqual([]);

    await client.close();
  });

  // 10. create_campaign takes list IDs from list_lists and media from list_media; update_campaign keeps the media and lists; preview and test send reach Mailpit; a non-integer list ID returns isError with the API's message and creates nothing.
  test("10. create_campaign creates a draft from list_lists and list_media ids; update_campaign keeps its media and lists; preview and test send deliver; invalid input creates nothing", async () => {
    const list = await api("POST", "/api/lists", {
      name: "B39 Campaign List",
      type: "public",
      optin: "single",
    });
    const listId: number = list.json.data.id;
    const subEmail = "b39-campaign@example.test";
    const sub = await api("POST", "/api/subscribers", {
      email: subEmail,
      name: "B39 Subscriber",
      status: "enabled",
      lists: [listId],
    });
    expect(sub.status).toBe(200);
    const heroId = await uploadMedia("b39-hero.png");

    const { client, transport } = createClient();
    await client.connect(transport);

    const found = await client.callTool({
      name: "list_lists",
      arguments: { query: "B39 Campaign List" },
    });
    const foundListId = (found.structuredContent as any).data.results[0].id;
    expect(foundListId).toBe(listId);
    const hero = await client.callTool({ name: "list_media", arguments: { query: "b39-hero" } });
    expect((hero.structuredContent as any).data.results[0].id).toBe(heroId);

    const created = await client.callTool({
      name: "create_campaign",
      arguments: {
        name: "B39 Created Campaign",
        subject: "B39 Created Subject",
        from_email: "noreply@example.test",
        lists: [foundListId],
        content_type: "richtext",
        body: "<p>Created body for {{ subscriber.name }}</p>",
        media: [heroId],
      },
    });
    expect(created.isError).toBeFalsy();
    const campaign = (created.structuredContent as any).data;
    const campId: number = campaign.id;
    expect(campaign.status).toBe("draft");

    const stored = (await api("GET", `/api/campaigns/${campId}`)).json.data;
    expect(stored.name).toBe("B39 Created Campaign");
    expect(stored.subject).toBe("B39 Created Subject");
    expect(stored.lists.map((l: any) => l.id)).toEqual([listId]);
    expect(stored.media.map((m: any) => m.id)).toEqual([heroId]);

    // Partial edit: only the body is given, so subject, lists and media are kept.
    const updated = await client.callTool({
      name: "update_campaign",
      arguments: { id: campId, body: "<p>Updated body for {{ subscriber.name }}</p>" },
    });
    expect(updated.isError).toBeFalsy();
    const afterUpdate = (await api("GET", `/api/campaigns/${campId}`)).json.data;
    expect(afterUpdate.body).toBe("<p>Updated body for {{ subscriber.name }}</p>");
    expect(afterUpdate.subject).toBe("B39 Created Subject");
    expect(afterUpdate.lists.map((l: any) => l.id)).toEqual([listId]);
    expect(afterUpdate.media.map((m: any) => m.id)).toEqual([heroId]);

    const preview = await client.callTool({ name: "preview_campaign", arguments: { id: campId } });
    expect(preview.isError).toBeFalsy();
    expect(getTextContent(preview)).toContain("Updated body for");

    const testSend = await client.callTool({
      name: "send_campaign_test",
      arguments: { id: campId, subscribers: [subEmail] },
    });
    expect(testSend.isError).toBeFalsy();
    const mail = await mailbox.one(subEmail, "B39 Created Subject");
    expect(mail.body).toContain("Updated body for B39 Subscriber");

    // A list ID that is not an integer is refused by the endpoint: same message, nothing created.
    const rejectedBody = {
      name: "B39 Rejected Campaign",
      subject: "B39 Rejected",
      from_email: "noreply@example.test",
      lists: ["not-an-id"],
      body: "<p>x</p>",
    };
    const rejected = await client.callTool({ name: "create_campaign", arguments: rejectedBody });
    expect(rejected.isError).toBe(true);
    const direct = await api("POST", "/api/campaigns", rejectedBody);
    expect(direct.status).toBe(400);
    expect(getTextContent(rejected)).toBe(direct.json?.message ?? direct.text);
    expect((await api("GET", "/api/campaigns?query=B39%20Rejected")).json.data.results).toEqual([]);

    await client.close();
  });

  // 11. get_sequence and list_sequences return what the HTTP API returns; update_sequence_step changes one step's subject and nothing else; an invalid step edit or an unknown step returns isError and changes nothing.
  test("11. get_sequence and list_sequences match the HTTP API; update_sequence_step changes only the given subject; invalid edits change nothing", async () => {
    const tpl = await api("POST", "/api/templates", {
      name: "B39 Sequence Template",
      type: "tx",
      subject: "Template subject",
      body: "<p>Hello</p>",
    });
    expect(tpl.status).toBe(200);
    const tplId: number = tpl.json.data.id;
    const layout = await api("POST", "/api/templates", {
      name: "B39 Campaign Layout",
      type: "campaign",
      body: "<div>{{ content | raw }}</div>",
    });
    expect(layout.status).toBe(200);
    const layoutId: number = layout.json.data.id;

    const seq = await api("POST", "/api/sequences", {
      name: "B39 Onboarding",
      status: "draft",
      trigger: { event: "b39_signup" },
      exit_on: ["b39_cancel"],
      reentry: "never",
      list_id: null,
      steps: [
        {
          wait: "PT0S",
          kind: "transactional",
          template_id: tplId,
          subject: "B39 step one",
          on_false: "exit",
          cap_policy: "defer",
        },
        {
          wait: "P2D",
          kind: "transactional",
          template_id: tplId,
          subject: "B39 step two",
          condition: { not: { event: "b39_done", since: "trigger" } },
          on_false: "skip",
          cap_policy: "skip",
          max_late: "PT6H",
        },
      ],
    });
    expect(seq.status).toBe(200);
    const seqId: number = seq.json.data.id;

    const { client, transport } = createClient();
    await client.connect(transport);

    const one = await client.callTool({ name: "get_sequence", arguments: { id: seqId } });
    expect(one.isError).toBeFalsy();
    expect(one.structuredContent).toEqual((await api("GET", `/api/sequences/${seqId}`)).json);

    const listed = await client.callTool({
      name: "list_sequences",
      arguments: { status: "draft", page: 1, per_page: 50 },
    });
    expect(listed.isError).toBeFalsy();
    expect(listed.structuredContent).toEqual(
      (await api("GET", "/api/sequences?status=draft&page=1&per_page=50")).json,
    );

    const before = (one.structuredContent as any).data;
    const step2 = before.steps.find((s: any) => s.subject === "B39 step two");
    const edited = await client.callTool({
      name: "update_sequence_step",
      arguments: { id: seqId, step_id: step2.id, subject: "B39 step two, edited" },
    });
    expect(edited.isError).toBeFalsy();

    const after = (await api("GET", `/api/sequences/${seqId}`)).json.data;
    const omitUpdated = (value: Record<string, unknown>) => withoutKeys(value, ["updated_at"]);
    expect(omitUpdated(withoutKeys(after, ["steps"]))).toEqual(
      omitUpdated(withoutKeys(before, ["steps"])),
    );
    expect(after.steps.map((s: any) => s.id)).toEqual(before.steps.map((s: any) => s.id));
    for (const [i, step] of before.steps.entries()) {
      const next = after.steps[i];
      expect(next.subject).toBe(step.id === step2.id ? "B39 step two, edited" : step.subject);
      expect(omitUpdated(withoutKeys(next, ["subject"]))).toEqual(
        omitUpdated(withoutKeys(step, ["subject"])),
      );
    }

    // A template that is not transactional is refused by the endpoint; an unknown step never reaches it.
    const badTemplate = await client.callTool({
      name: "update_sequence_step",
      arguments: { id: seqId, step_id: step2.id, template_id: layoutId },
    });
    expect(badTemplate.isError).toBe(true);
    expect(getTextContent(badTemplate)).toContain("transactional");
    const unknownStep = await client.callTool({
      name: "update_sequence_step",
      arguments: { id: seqId, step_id: 999999, subject: "Nope" },
    });
    expect(unknownStep.isError).toBe(true);
    expect((await api("GET", `/api/sequences/${seqId}`)).json.data).toEqual(after);

    await client.close();
  });

  // 12. Permissions: create_campaign without campaigns:manage, get_sequence and list_sequences without sequences:get, and update_sequence_step without sequences:manage return isError with the API's 403 message and write nothing.
  test("12. Permissions: missing campaigns:manage, sequences:get or sequences:manage gives isError with the API's 403 message and writes nothing", async () => {
    const list = await api("POST", "/api/lists", {
      name: "B39 Denied List",
      type: "public",
      optin: "single",
    });
    const listId: number = list.json.data.id;
    const tpl = await api("POST", "/api/templates", {
      name: "B39 Denied Template",
      type: "tx",
      subject: "Denied",
      body: "<p>Denied</p>",
    });
    const tplId: number = tpl.json.data.id;
    const seq = await api("POST", "/api/sequences", {
      name: "B39 Denied Sequence",
      status: "draft",
      trigger: { event: "b39_denied" },
      exit_on: [],
      reentry: "never",
      steps: [
        {
          wait: "PT0S",
          kind: "transactional",
          template_id: tplId,
          subject: "Denied step",
        },
      ],
    });
    const seqId: number = seq.json.data.id;
    const stepId: number = seq.json.data.steps[0].id;
    const seqBefore = (await api("GET", `/api/sequences/${seqId}`)).json.data;

    const campaignReader = await createApiUser("b39-campaign-reader", ["campaigns:get"]);
    {
      const { client, transport } = createClient(campaignReader);
      await client.connect(transport);
      const denied = await client.callTool({
        name: "create_campaign",
        arguments: {
          name: "B39 Denied Campaign",
          subject: "B39 Denied",
          lists: [listId],
          body: "<p>x</p>",
        },
      });
      expect(denied.isError).toBe(true);
      expect(getTextContent(denied)).toContain("permission denied: campaigns:manage");
      await client.close();
    }
    expect((await api("GET", "/api/campaigns?query=B39%20Denied")).json.data.results).toEqual([]);

    const noSequences = await createApiUser("b39-no-sequences", ["templates:get"]);
    {
      const { client, transport } = createClient(noSequences);
      await client.connect(transport);
      const getDenied = await client.callTool({
        name: "get_sequence",
        arguments: { id: seqId },
      });
      expect(getDenied.isError).toBe(true);
      expect(getTextContent(getDenied)).toContain("permission denied: sequences:get");
      const listDenied = await client.callTool({ name: "list_sequences", arguments: {} });
      expect(listDenied.isError).toBe(true);
      await client.close();
    }

    const sequenceReader = await createApiUser("b39-sequence-reader", ["sequences:get"]);
    {
      const { client, transport } = createClient(sequenceReader);
      await client.connect(transport);
      const readOk = await client.callTool({ name: "get_sequence", arguments: { id: seqId } });
      expect(readOk.isError).toBeFalsy();
      const editDenied = await client.callTool({
        name: "update_sequence_step",
        arguments: { id: seqId, step_id: stepId, subject: "Denied edit" },
      });
      expect(editDenied.isError).toBe(true);
      expect(getTextContent(editDenied)).toContain("permission denied: sequences:manage");
      await client.close();
    }
    expect((await api("GET", `/api/sequences/${seqId}`)).json.data).toEqual(seqBefore);
  });

  // 13. Cookie-session callers (login, CSRF token) can call create_campaign; without the CSRF token the request is refused and nothing is created.
  test("13. Cookie session authentication: create_campaign succeeds with cookie + CSRF token and is refused without it", async () => {
    const list = await api("POST", "/api/lists", {
      name: "B39 Cookie List",
      type: "public",
      optin: "single",
    });
    const listId: number = list.json.data.id;
    const { cookieHeader, csrfToken } = await loginCookies();

    const client = new Client({ name: "mcp-cookie-b39", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${production.origin}/api/mcp`), {
      requestInit: { headers: { Cookie: cookieHeader, "X-CSRF-Token": csrfToken } },
    });
    await client.connect(transport);
    const created = await client.callTool({
      name: "create_campaign",
      arguments: {
        name: "B39 Cookie Campaign",
        subject: "B39 Cookie Subject",
        from_email: "noreply@example.test",
        lists: [listId],
        body: "<p>Cookie body</p>",
      },
    });
    expect(created.isError).toBeFalsy();
    const campId = (created.structuredContent as any).data.id;
    expect((await api("GET", `/api/campaigns/${campId}`)).json.data.name).toBe(
      "B39 Cookie Campaign",
    );
    await client.close();

    const noCsrf = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "create_campaign",
          arguments: {
            name: "B39 Cookie Refused",
            subject: "B39 Cookie Refused",
            lists: [listId],
            body: "<p>x</p>",
          },
        },
      }),
    });
    expect(noCsrf.status).toBe(403);
    expect(
      (await api("GET", "/api/campaigns?query=B39%20Cookie%20Refused")).json.data.results,
    ).toEqual([]);
  });

  // 14. update_sequence_step does not send a status, so a paused or archived sequence keeps the status it has.
  test("14. update_sequence_step keeps the stored status of a paused or archived sequence", async () => {
    const tpl = await api("POST", "/api/templates", {
      name: "B39 Status Template",
      type: "tx",
      subject: "Status subject",
      body: "<p>Hello</p>",
    });
    expect(tpl.status).toBe(200);
    const seq = await api("POST", "/api/sequences", {
      name: "B39 Status Sequence",
      status: "draft",
      trigger: { event: "b39_status" },
      exit_on: ["b39_status_cancel"],
      reentry: "never",
      list_id: null,
      steps: [
        {
          wait: "PT0S",
          kind: "transactional",
          template_id: tpl.json.data.id,
          subject: "Before",
          on_false: "exit",
          cap_policy: "defer",
        },
      ],
    });
    expect(seq.status).toBe(200);
    const seqId: number = seq.json.data.id;
    const stepId: number = seq.json.data.steps[0].id;

    const { client, transport } = createClient();
    await client.connect(transport);

    for (const status of ["paused", "archived"] as const) {
      const set = await api("PUT", `/api/sequences/${seqId}/status`, { status });
      expect(set.status).toBe(200);

      const edited = await client.callTool({
        name: "update_sequence_step",
        arguments: { id: seqId, step_id: stepId, subject: `Edited while ${status}` },
      });
      expect(edited.isError).toBeFalsy();

      const after = (await api("GET", `/api/sequences/${seqId}`)).json.data;
      expect(after.status).toBe(status);
      expect(after.steps[0].subject).toBe(`Edited while ${status}`);
    }

    await client.close();
  });

  // B44. Read-merge tools read the stored object first. A caller who can save but not read gets a tool error that names the tool and the read permission, and nothing is written.
  test("15. Read-merge tools need the read permission too: manage without get gives a tool error naming the tool and the permission, and writes nothing", async () => {
    const list = await api("POST", "/api/lists", {
      name: "B44 Read List",
      type: "public",
      optin: "single",
    });
    const listId: number = list.json.data.id;
    const created = await api("POST", "/api/campaigns", {
      name: "B44 Read Campaign",
      subject: "B44 Read Subject",
      from_email: "noreply@example.test",
      lists: [listId],
      body: "<p>Stored body</p>",
      content_type: "html",
    });
    expect(created.status).toBe(200);
    const campId: number = created.json.data.id;
    const campBefore = (await api("GET", `/api/campaigns/${campId}`)).json.data;

    const tpl = await api("POST", "/api/templates", {
      name: "B44 Read Template",
      type: "tx",
      subject: "Read",
      body: "<p>Read</p>",
    });
    const seq = await api("POST", "/api/sequences", {
      name: "B44 Read Sequence",
      status: "draft",
      trigger: { event: "b44_read" },
      exit_on: [],
      reentry: "never",
      steps: [
        {
          wait: "PT0S",
          kind: "transactional",
          template_id: tpl.json.data.id,
          subject: "B44 read step",
        },
      ],
    });
    expect(seq.status).toBe(200);
    const seqId: number = seq.json.data.id;
    const stepId: number = seq.json.data.steps[0].id;
    const seqBefore = (await api("GET", `/api/sequences/${seqId}`)).json.data;

    const writerOnly = await createApiUser("b44-manage-only", [
      "campaigns:manage",
      "sequences:manage",
    ]);
    const { client, transport } = createClient(writerOnly);
    await client.connect(transport);

    const updateDenied = await client.callTool({
      name: "update_campaign",
      arguments: { id: campId, subject: "B44 Changed" },
    });
    expect(updateDenied.isError).toBe(true);
    expect(getTextContent(updateDenied)).toContain("update_campaign");
    expect(getTextContent(updateDenied)).toContain("campaigns:get");

    const textDenied = await client.callTool({ name: "campaign_text", arguments: { id: campId } });
    expect(textDenied.isError).toBe(true);
    expect(getTextContent(textDenied)).toContain("campaign_text");
    expect(getTextContent(textDenied)).toContain("campaigns:get");

    const stepDenied = await client.callTool({
      name: "update_sequence_step",
      arguments: { id: seqId, step_id: stepId, subject: "B44 Changed" },
    });
    expect(stepDenied.isError).toBe(true);
    expect(getTextContent(stepDenied)).toContain("update_sequence_step");
    expect(getTextContent(stepDenied)).toContain("sequences:get");
    await client.close();

    expect((await api("GET", `/api/campaigns/${campId}`)).json.data).toEqual(campBefore);
    expect((await api("GET", `/api/sequences/${seqId}`)).json.data).toEqual(seqBefore);
  });

  // B44. update_campaign sets send_at, keeps it when the argument is omitted, and clears it on an explicit null.
  test("16. update_campaign sets send_at, keeps the stored schedule when send_at is omitted, and clears it on null", async () => {
    const list = await api("POST", "/api/lists", {
      name: "B44 Schedule List",
      type: "public",
      optin: "single",
    });
    const created = await api("POST", "/api/campaigns", {
      name: "B44 Schedule Campaign",
      subject: "B44 Schedule Subject",
      from_email: "noreply@example.test",
      lists: [list.json.data.id],
      body: "<p>Schedule</p>",
      content_type: "html",
    });
    expect(created.status).toBe(200);
    const campId: number = created.json.data.id;

    const { client, transport } = createClient();
    await client.connect(transport);

    const listed = await client.listTools();
    const updateTool = listed.tools.find((t) => t.name === "update_campaign");
    const properties = updateTool?.inputSchema.properties as Record<string, any> | undefined;
    expect(properties?.send_at.type).toEqual(["string", "null"]);

    const scheduled = await client.callTool({
      name: "update_campaign",
      arguments: { id: campId, send_at: "2030-01-02T03:04:05Z" },
    });
    expect(scheduled.isError).toBeFalsy();
    const withSchedule = (await api("GET", `/api/campaigns/${campId}`)).json.data;
    expect(Date.parse(withSchedule.send_at)).toBe(Date.parse("2030-01-02T03:04:05Z"));

    const renamed = await client.callTool({
      name: "update_campaign",
      arguments: { id: campId, subject: "B44 Schedule Renamed" },
    });
    expect(renamed.isError).toBeFalsy();
    const kept = (await api("GET", `/api/campaigns/${campId}`)).json.data;
    expect(kept.subject).toBe("B44 Schedule Renamed");
    expect(kept.send_at).toBe(withSchedule.send_at);

    const cleared = await client.callTool({
      name: "update_campaign",
      arguments: { id: campId, send_at: null },
    });
    expect(cleared.isError).toBeFalsy();
    const unscheduled = (await api("GET", `/api/campaigns/${campId}`)).json.data;
    expect(unscheduled.send_at).toBeNull();
    expect(unscheduled.subject).toBe("B44 Schedule Renamed");

    await client.close();
  });

  // B44. A step edit with neither subject nor template_id changes nothing, so it is refused before any write.
  test("17. update_sequence_step with neither subject nor template_id is refused and saves nothing", async () => {
    const tpl = await api("POST", "/api/templates", {
      name: "B44 Noop Template",
      type: "tx",
      subject: "Noop",
      body: "<p>Noop</p>",
    });
    const seq = await api("POST", "/api/sequences", {
      name: "B44 Noop Sequence",
      status: "draft",
      trigger: { event: "b44_noop" },
      exit_on: [],
      reentry: "never",
      steps: [
        {
          wait: "PT0S",
          kind: "transactional",
          template_id: tpl.json.data.id,
          subject: "B44 noop step",
        },
      ],
    });
    expect(seq.status).toBe(200);
    const seqId: number = seq.json.data.id;
    const stepId: number = seq.json.data.steps[0].id;
    const before = (await api("GET", `/api/sequences/${seqId}`)).json.data;

    const { client, transport } = createClient();
    await client.connect(transport);
    const noop = await client.callTool({
      name: "update_sequence_step",
      arguments: { id: seqId, step_id: stepId },
    });
    expect(noop.isError).toBe(true);
    expect(getTextContent(noop)).toContain("Nothing to change");
    await client.close();

    expect((await api("GET", `/api/sequences/${seqId}`)).json.data).toEqual(before);
  });

  // B44. Cookie-session writes carry the caller's Origin, so a foreign Origin is refused before any write; the site's own Origin is the control.
  test("18. Cookie session: an MCP write with a foreign Origin is refused with 403 and writes nothing; the same write with the site's Origin succeeds", async () => {
    const tpl = await api("POST", "/api/templates", {
      name: "B44 Origin Template",
      type: "tx",
      subject: "Origin",
      body: "<p>Origin</p>",
    });
    const tplId: number = tpl.json.data.id;
    const { cookieHeader, csrfToken } = await loginCookies();

    const writeTemplate = (origin: string, name: string) =>
      fetch(`${production.origin}/api/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookieHeader,
          "x-csrf-token": csrfToken,
          origin,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "update_template", arguments: { id: tplId, name } },
        }),
      });

    const foreign = await writeTemplate("https://evil.example", "B44 Foreign Origin");
    expect(foreign.status).toBe(403);
    expect((await api("GET", `/api/templates/${tplId}`)).json.data.name).toBe(
      "B44 Origin Template",
    );

    const own = await writeTemplate(production.origin, "B44 Own Origin");
    expect(own.status).toBe(200);
    const ownResult = (await own.json()) as { result: { isError?: boolean } };
    expect(ownResult.result.isError).toBeFalsy();
    expect((await api("GET", `/api/templates/${tplId}`)).json.data.name).toBe("B44 Own Origin");
  });

  // B44. A campaign whose one list was deleted keeps working: the update succeeds and the other list stays attached.
  test("19. update_campaign on a campaign whose one list was deleted still works and keeps the other list", async () => {
    const keep = await api("POST", "/api/lists", {
      name: "B44 Keep List",
      type: "public",
      optin: "single",
    });
    const gone = await api("POST", "/api/lists", {
      name: "B44 Gone List",
      type: "public",
      optin: "single",
    });
    const keepId: number = keep.json.data.id;
    const goneId: number = gone.json.data.id;
    const created = await api("POST", "/api/campaigns", {
      name: "B44 Partial Campaign",
      subject: "B44 Partial Subject",
      from_email: "noreply@example.test",
      lists: [keepId, goneId],
      body: "<p>Partial</p>",
      content_type: "html",
    });
    expect(created.status).toBe(200);
    const campId: number = created.json.data.id;

    const deleted = await api("DELETE", `/api/lists/${goneId}`);
    expect(deleted.status).toBe(200);

    const { client, transport } = createClient();
    await client.connect(transport);
    const updated = await client.callTool({
      name: "update_campaign",
      arguments: { id: campId, subject: "B44 Partial Updated" },
    });
    expect(updated.isError).toBeFalsy();
    await client.close();

    const after = (await api("GET", `/api/campaigns/${campId}`)).json.data;
    expect(after.subject).toBe("B44 Partial Updated");
    const positiveListIds = (after.lists as { id: number }[])
      .map((list) => list.id)
      .filter((id) => id > 0);
    expect(positiveListIds).toEqual([keepId]);
  });

  // B44. A step edit on an active sequence updates the step in place: a subscriber waiting on that step keeps the same enrollment, step and due time.
  test("20. update_sequence_step on an active sequence with a live enrollment keeps the enrollment's step and due time", async () => {
    const tpl = await api("POST", "/api/templates", {
      name: "B44 Live Template",
      type: "tx",
      subject: "Live",
      body: "<p>Live</p>",
    });
    const tplId: number = tpl.json.data.id;
    const seq = await api("POST", "/api/sequences", {
      name: "B44 Live Sequence",
      status: "draft",
      trigger: { event: "b44_live" },
      exit_on: ["b44_live_cancel"],
      reentry: "never",
      list_id: null,
      steps: [
        {
          wait: "P30D",
          kind: "transactional",
          template_id: tplId,
          subject: "B44 waiting step",
          on_false: "exit",
          cap_policy: "defer",
        },
        {
          wait: "P30D",
          kind: "transactional",
          template_id: tplId,
          subject: "B44 later step",
        },
      ],
    });
    expect(seq.status).toBe(200);
    const seqId: number = seq.json.data.id;
    const waitingStepId: number = seq.json.data.steps[0].id;
    const activated = await api("PUT", `/api/sequences/${seqId}/status`, { status: "active" });
    expect(activated.status).toBe(200);

    const sub = await api("POST", "/api/subscribers", {
      email: "b44-live@example.test",
      name: "B44 Live Subscriber",
      status: "enabled",
      lists: [],
    });
    expect(sub.status).toBe(200);
    const enrolled = await api("POST", "/api/enrollments", {
      sequence_id: seqId,
      subscriber_id: sub.json.data.id,
    });
    expect(enrolled.status).toBe(200);
    const enrollmentId: number = enrolled.json.data.id;
    const enrollmentBefore = (await api("GET", `/api/enrollments/${enrollmentId}`)).json.data;
    expect(enrollmentBefore.status).toBe("active");
    expect(enrollmentBefore.step_id).toBe(waitingStepId);

    const { client, transport } = createClient();
    await client.connect(transport);
    const edited = await client.callTool({
      name: "update_sequence_step",
      arguments: { id: seqId, step_id: waitingStepId, subject: "B44 waiting step, edited" },
    });
    expect(edited.isError).toBeFalsy();
    await client.close();

    const sequenceAfter = (await api("GET", `/api/sequences/${seqId}`)).json.data;
    expect(sequenceAfter.status).toBe("active");
    expect(sequenceAfter.steps[0].id).toBe(waitingStepId);
    expect(sequenceAfter.steps[0].subject).toBe("B44 waiting step, edited");
    const enrollmentAfter = (await api("GET", `/api/enrollments/${enrollmentId}`)).json.data;
    expect(enrollmentAfter).toEqual(enrollmentBefore);
  });
});
