// The step preview and test send as MCP tools (docs/design/06-templates.md, 05-sequences.md
// #preview-and-test-send, D98, D105): the generated tools are listed with their annotations, and
// one round trip each runs through POST /api/mcp against the compiled server and the SMTP sink.
// preview_template takes the same sample as the REST preview.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensureProductionBuild } from "@/test/production-build";
import { startProduction, startMailbox, admin } from "@/test/worked-example/harness";
import type { Production, Mailbox } from "@/test/worked-example/harness";
import { provisionApiUser } from "@/test/contract/owned";
import { asBody } from "@/test/read-body";

describe("D105 step preview and test send through MCP", () => {
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
    if (mailbox) {
      await mailbox.close().catch(() => {});
    }
  });

  async function rpc(method: string, params?: unknown) {
    const response = await fetch(`${production.origin}/api/mcp`, {
      method: "POST",
      headers: { authorization: adminAuth, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    return asBody<{ result?: any; error?: { code: number; message: string } }>(
      await response.json(),
    );
  }
  async function callTool(name: string, args: Record<string, unknown>) {
    const reply = await rpc("tools/call", { name, arguments: args });
    if (reply.error) {
      throw new Error(`${name}: ${reply.error.message}`);
    }
    return asBody<{
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
      structuredContent?: any;
    }>(reply.result);
  }
  async function api(method: string, path: string, body?: unknown) {
    const response = await fetch(`${production.origin}${path}`, {
      method,
      headers: adminHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }

  test("the step tools are listed with D98's annotations, and preview_template takes a sample", async () => {
    const tools = asBody<Array<any>>((await rpc("tools/list")).result.tools);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("preview_sequence_step")?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(byName.get("test_sequence_step")?.annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
    });
    expect(byName.get("preview_sequence_step")?.inputSchema.required).toEqual(
      expect.arrayContaining(["id", "step"]),
    );
    expect(byName.get("preview_template")?.inputSchema.properties.sample).toMatchObject({
      type: "object",
    });
  });

  test("preview_sequence_step renders a step with a sample, and preview_template renders the same sample", async () => {
    const template = await api("POST", "/api/templates", {
      name: "MCP step",
      type: "tx",
      subject: "Template subject",
      body: "<p>Hi {{ subscriber.name }}; items: {{ trigger.data.items }}; downloads: {{ aggregates.downloads | number | default: 0 }}</p>",
    });
    expect(template.status).toBe(200);
    const sequence = await api("POST", "/api/sequences", {
      name: "MCP onboarding",
      status: "active",
      trigger: { event: "purchase" },
      reentry: "always",
      steps: [
        {
          wait: "P1D",
          kind: "transactional",
          template_id: template.body.data.id,
          subject: "Order update",
          aggregates: { downloads: { event: "download", fn: "count" } },
        },
      ],
    });
    expect(sequence.status).toBe(200);
    const id = sequence.body.data.id;
    const step = sequence.body.data.steps[0].id;
    const sample = {
      subscriber: { name: "Grace" },
      trigger: { data: { items: 7 } },
      aggregates: { downloads: 1_234_567 },
    };
    const shown = await callTool("preview_sequence_step", { id, step, body: { sample } });
    expect(shown.isError).toBeFalsy();
    expect(shown.structuredContent.data).toMatchObject({
      subject: "Order update",
      body: "<p>Hi Grace; items: 7; downloads: 1,234,567</p>",
    });

    const template_preview = await callTool("preview_template", {
      template_type: "tx",
      body: "{{ subscriber.name }}|{{ aggregates.x | number | default: 0 }}",
      sample: { subscriber: { name: "Grace" }, aggregates: { x: 1_234_567 } },
    });
    expect(template_preview.content[0]!.text).toBe("Grace|1,234,567");
  });

  test("test_sequence_step mails the addresses it names, labelled, and journals nothing", async () => {
    const sequence = asBody<{ results: Array<{ id: number; name: string }> }>(
      (await api("GET", "/api/sequences?per_page=100")).body.data,
    ).results.find((row) => row.name === "MCP onboarding")!;
    const detail = (await api("GET", `/api/sequences/${sequence.id}`)).body.data;
    const sent = await callTool("test_sequence_step", {
      id: sequence.id,
      step: detail.steps[0].id,
      body: { emails: ["owner@example.test"], sample: { subscriber: { name: "Grace" } } },
    });
    expect(sent.isError).toBeFalsy();
    expect(sent.structuredContent.data).toBe(true);
    const mail = await mailbox.one("owner@example.test", "[Test] Order update");
    expect(mail.body).toContain("Hi Grace");
    expect((await api("GET", "/api/sends")).body.data.total).toBe(0);
  });
});
