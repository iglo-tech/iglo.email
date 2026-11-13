// B78 / D98: every authenticated API operation is an MCP tool, except the explicit exclusions.
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
import { EXCLUDED_OPERATIONS, HANDWRITTEN_COVERAGE } from "@/mcp/coverage";
import { GENERATED } from "@/mcp/generated";

/** The 20 hand-written tools, which keep their names (D98). */
const HANDWRITTEN_TOOLS = [
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
];

/** Excluded operations, by the name a tool would have had. None of them may be callable. */
const EXCLUDED_TOOL_NAMES = [
  "create_user",
  "delete_users",
  "update_user",
  "delete_user",
  "create_user_role",
  "update_user_role",
  "create_list_role",
  "update_list_role",
  "delete_role",
  "update_profile",
  "logout",
  "enable_totp",
  "delete_subscribers",
  "delete_subscribers_by_query",
  "blocklist_subscribers_by_query",
  "delete_campaigns",
  "delete_lists",
  "delete_bounces",
  "delete_analytics",
  "update_settings",
  "post_bounce",
  "get_health_check",
];

describe("B78 MCP covers every operation (D98)", () => {
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

  /** A JSON-RPC call to POST /api/mcp, as the caller `auth`. */
  async function rpc(method: string, params?: unknown, auth = adminAuth) {
    const response = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    return (await response.json()) as {
      result?: any;
      error?: { code: number; message: string };
    };
  }

  async function callTool(name: string, args: Record<string, unknown> = {}, auth = adminAuth) {
    const reply = await rpc("tools/call", { name, arguments: args }, auth);
    if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
    return reply.result as {
      isError?: boolean;
      content: { type: string; text: string }[];
      structuredContent?: any;
    };
  }

  async function listTools(): Promise<any[]> {
    return (await rpc("tools/list")).result.tools;
  }

  async function apiGet(path: string) {
    return (await fetch(`${production.origin}${path}`, { headers: adminHeaders })).json();
  }

  // Coverage: every documented operation is exactly one of covered, excluded or generated.
  test("every operation in the API document is a hand-written tool, a generated tool, or excluded with a reason", async () => {
    const document = await apiGet("/api/openapi.json");
    const operationIds: string[] = Object.values<any>(document.paths).flatMap((item) =>
      Object.values<any>(item).map((operation) => operation.operationId),
    );
    expect(operationIds.length).toBeGreaterThan(100);

    for (const id of operationIds) {
      const buckets = [
        Object.hasOwn(HANDWRITTEN_COVERAGE, id),
        Object.hasOwn(EXCLUDED_OPERATIONS, id),
        GENERATED.some((entry) => entry.operation.id === id),
      ].filter(Boolean);
      expect({ id, buckets: buckets.length }).toEqual({ id, buckets: 1 });
    }

    // Every name in the coverage map and every generated tool is a tool, and nothing else is.
    const names = (await listTools()).map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    const expected = [...HANDWRITTEN_TOOLS, ...GENERATED.map((entry) => entry.name)];
    expect([...names].sort()).toEqual([...expected].sort());
    for (const hand of Object.values(HANDWRITTEN_COVERAGE)) expect(names).toContain(hand);
  });

  test("an excluded operation is not a tool, and calling it is an unknown-tool error even for an admin", async () => {
    const names = (await listTools()).map((tool) => tool.name);
    for (const name of EXCLUDED_TOOL_NAMES) {
      expect(names).not.toContain(name);
      const reply = await rpc("tools/call", { name, arguments: {} });
      expect(reply.error?.code).toBe(-32602);
      expect(reply.error?.message).toBe(`Unknown tool: ${name}`);
    }
  });

  test("tools/list: schemas are self-contained, and annotations follow D98 item 4", async () => {
    const tools = await listTools();
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain('"$ref"');
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations.destructiveHint).toBe("boolean");
      expect(typeof tool.annotations.openWorldHint).toBe("boolean");
    }
    const byName = new Map<string, any>(tools.map((tool) => [tool.name, tool]));
    const hint = (name: string) => byName.get(name)!.annotations;

    // Reads and previews.
    expect(hint("get_subscribers")).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(hint("preview_campaign_archive")).toMatchObject({ readOnlyHint: true });
    expect(hint("validate_condition")).toMatchObject({ readOnlyHint: true });
    expect(hint("list_lists")).toMatchObject({ readOnlyHint: true });
    // Deletes, blocklists, campaign status and settings by key are destructive.
    expect(hint("delete_subscriber")).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(hint("delete_template")).toMatchObject({ destructiveHint: true });
    expect(hint("blocklist_subscriber")).toMatchObject({ destructiveHint: true });
    expect(hint("update_campaign_status")).toMatchObject({
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(hint("update_setting_by_key")).toMatchObject({ destructiveHint: true });
    expect(hint("delete_subscriber_activity")).toMatchObject({ destructiveHint: true });
    // Mail or an outside call.
    expect(hint("send_campaign_test")).toMatchObject({ openWorldHint: true });
    expect(hint("transact_with_subscriber")).toMatchObject({ openWorldHint: true });
    expect(hint("test_smtp_settings")).toMatchObject({ openWorldHint: true });
    expect(hint("create_enrollment")).toMatchObject({ openWorldHint: true });
    // Ordinary writes.
    expect(hint("create_list")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(hint("update_campaign")).toMatchObject({ destructiveHint: false, readOnlyHint: false });

    // Path parameters and bodies are arguments, and the required ones say so.
    expect(byName.get("get_subscriber").inputSchema.required).toEqual(["id"]);
    expect(byName.get("create_subscriber").inputSchema.required).toEqual(["body"]);
    expect(byName.get("upload_media").inputSchema.required).toEqual(["filename", "content_base64"]);
  });

  test("a missing required argument is an isError naming it, and nothing is sent", async () => {
    const noId = await callTool("get_subscriber", {});
    expect(noId.isError).toBe(true);
    expect(noId.content[0]!.text).toBe("Missing required argument: id");

    const noBody = await callTool("create_subscriber", {});
    expect(noBody.isError).toBe(true);
    expect(noBody.content[0]!.text).toBe("Missing required argument: body");
  });

  test("uploads: a file over 1 MiB, or base64 that is not valid, is refused before anything is sent", async () => {
    const tooBig = await callTool("upload_media", {
      filename: "too-big.txt",
      content_base64: "A".repeat(1_398_108),
    });
    expect(tooBig.isError).toBe(true);
    expect(tooBig.content[0]!.text).toContain("larger than 1048576 bytes");

    const notBase64 = await callTool("upload_media", {
      filename: "bad.txt",
      content_base64: "not base64 !!",
    });
    expect(notBase64.isError).toBe(true);
    expect(notBase64.content[0]!.text).toBe("content_base64 is not valid base64.");

    const media = (await apiGet("/api/media")).data.results as { filename: string }[];
    expect(media.some((item) => item.filename.startsWith("too-big"))).toBe(false);
    expect(media.some((item) => item.filename.startsWith("bad"))).toBe(false);
  });

  // Round trip with an admin credential: the things an agent does day to day, through generated tools.
  test("round trip: list, subscriber, sequence, enrolment, setting, webhook, media and import all work through MCP", async () => {
    // A list and a subscriber on it, updated.
    const list = (
      await callTool("create_list", {
        body: { name: "B78 round trip", type: "private", optin: "single" },
      })
    ).structuredContent.data;
    expect(list.id).toBeGreaterThan(0);

    const created = await callTool("create_subscriber", {
      body: { email: "b78-one@example.com", name: "B78 One", lists: [list.id] },
    });
    expect(created.isError).toBeFalsy();
    const subscriber = created.structuredContent.data;

    const updated = await callTool("update_subscriber", {
      id: subscriber.id,
      body: {
        email: "b78-one@example.com",
        name: "B78 Renamed",
        status: "enabled",
        lists: [list.id],
        attribs: {},
      },
    });
    expect(updated.isError).toBeFalsy();
    const readBack = await callTool("get_subscriber", { id: subscriber.id });
    expect(readBack.structuredContent.data.name).toBe("B78 Renamed");

    // A transactional template for the step, then a sequence with a trigger and a step, set active.
    const template = await callTool("create_template", {
      name: "B78 step",
      type: "tx",
      subject: "B78 welcome",
      body: "<p>Hello from B78.</p>",
    });
    expect(template.isError).toBeFalsy();
    const sequence = (
      await callTool("create_sequence", {
        body: {
          name: "B78 sequence",
          trigger: { event: "b78_signup" },
          list_id: list.id,
          steps: [
            {
              wait: "P1D",
              kind: "transactional",
              template_id: template.structuredContent.data.id,
            },
          ],
        },
      })
    ).structuredContent.data;
    const activated = await callTool("update_sequence_status", {
      id: sequence.id,
      body: { status: "active" },
    });
    expect(activated.isError).toBeFalsy();

    // Enrol the subscriber; the first step waits a day, so nothing is sent during the test.
    const enrolled = await callTool("create_enrollment", {
      body: { sequence_id: sequence.id, subscriber_id: subscriber.id },
    });
    expect(enrolled.isError).toBeFalsy();

    // One setting by key, read back through get_settings.
    const setting = await callTool("update_setting_by_key", {
      key: "app.site_name",
      body: "B78 site",
    });
    expect(setting.isError).toBeFalsy();
    const settings = await callTool("get_settings");
    expect(
      settings.structuredContent.data["app.site_name"] ??
        settings.structuredContent.data.app?.site_name,
    ).toBe("B78 site");

    // A webhook that receives only bounce events, created and deleted; no event is raised here.
    const webhook = await callTool("create_webhook", {
      body: { url: "http://127.0.0.1:9/b78", events: ["bounce.recorded"], enabled: true },
    });
    expect(webhook.isError).toBeFalsy();
    const deleted = await callTool("delete_webhook", { id: webhook.structuredContent.data.id });
    expect(deleted.isError).toBeFalsy();

    // A small media file, base64.
    const upload = await callTool("upload_media", {
      filename: "b78-note.txt",
      content_base64: Buffer.from("hello from B78\n").toString("base64"),
    });
    expect(upload.isError).toBeFalsy();
    const media = await callTool("get_media", { id: upload.structuredContent.data.id });
    expect(media.structuredContent.data.filename).toBe("b78-note.txt");

    // A two-row CSV import into the list, then both rows are there.
    const csv = "email,name\nb78-two@example.com,B78 Two\nb78-three@example.com,B78 Three\n";
    const imported = await callTool("import_subscribers", {
      params: JSON.stringify({
        mode: "subscribe",
        subscription_status: "unconfirmed",
        delim: ",",
        lists: [list.id],
        overwrite: true,
      }),
      filename: "b78.csv",
      content_base64: Buffer.from(csv).toString("base64"),
    });
    expect(imported.isError).toBeFalsy();
    let total = 0;
    for (let attempt = 0; attempt < 100 && total < 3; attempt++) {
      const listed = await callTool("get_subscribers", { list_id: [list.id] });
      total = listed.structuredContent.data.total;
      if (total < 3) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(total).toBe(3);

    // Export is text (CSV), not JSON, and it names the imported rows.
    const exported = await callTool("export_subscribers", { list_id: [list.id] });
    expect(exported.isError).toBeFalsy();
    expect(exported.content[0]!.text).toContain("b78-two@example.com");
  }, 60_000);

  test("a restricted role gets the API's 403 as isError, and nothing is written", async () => {
    const role = await (
      await fetch(`${production.origin}/api/roles/users`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ name: "B78 Reader", permissions: ["subscribers:get_all"] }),
      })
    ).json();
    const user = await (
      await fetch(`${production.origin}/api/users`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          username: "b78-reader",
          type: "api",
          status: "enabled",
          user_role_id: role.data.id,
        }),
      })
    ).json();
    const readerAuth = `token ${user.data.username}:${user.data.password}`;

    const denied = await callTool(
      "create_subscriber",
      { body: { email: "b78-denied@example.com", name: "Denied" } },
      readerAuth,
    );
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain("subscribers:manage");

    const search = await callTool("get_subscribers", { search: "b78-denied" });
    expect(search.structuredContent.data.total).toBe(0);
  });
});
