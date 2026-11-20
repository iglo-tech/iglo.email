// B123 (D126): the MCP tool of a subscriber's events needs `subscriber_events:get`, as its REST
// route does. A restricted API user is refused as an isError 403, and served once the role has the
// permission. Through the MCP endpoint of the compiled production server.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ensureProductionBuild } from "@/test/production-build";
import { admin, startProduction, type Production } from "@/test/worked-example/harness";
import { provisionApiUser } from "@/test/contract/owned";

let production: Production;
let adminAuth: string;
let nextId = 1;

beforeAll(async () => {
  await ensureProductionBuild();
  production = await startProduction();
  const creds = await provisionApiUser(production.origin, admin);
  adminAuth = `token ${creds.user}:${creds.token}`;
}, 60_000);

afterAll(async () => {
  await production?.stop().catch(() => {});
  await production?.close().catch(() => {});
});

async function api(path: string, method: string, body?: unknown, auth = adminAuth) {
  const response = await fetch(`${production.origin}${path}`, {
    method,
    headers: { authorization: auth, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

async function callTool(name: string, args: Record<string, unknown>, auth: string) {
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
  const reply = (await response.json()) as {
    result?: { isError?: boolean; content: { type: string; text: string }[] };
    error?: { message: string };
  };
  if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
  return reply.result!;
}

test("get_subscriber_events needs subscriber_events:get, as the REST route does", async () => {
  const list = (
    await api("/api/lists", "POST", { name: "MCP events", type: "public", optin: "single" })
  ).body.data.id as number;
  const subscriber = (
    await api("/api/subscribers", "POST", {
      email: "mcp-events@example.test",
      name: "Events",
      lists: [list],
    })
  ).body.data.id as number;
  const role = await api("/api/roles/users", "POST", {
    name: "mcp-events-reader",
    permissions: ["subscribers:get"],
  });
  expect(role.status).toBe(200);
  const listRole = await api("/api/roles/lists", "POST", {
    name: "mcp-events-reader",
    lists: [{ id: list, permissions: ["list:get"] }],
  });
  expect(listRole.status).toBe(200);
  const user = await api("/api/users", "POST", {
    username: "mcp-events-reader",
    type: "api",
    status: "enabled",
    user_role_id: role.body.data.id,
    list_role_id: listRole.body.data.id,
  });
  expect(user.status).toBe(200);
  const reader = `token mcp-events-reader:${user.body.data.password}`;

  // The REST route refuses the same caller, so the tool must refuse it too.
  const rest = await fetch(`${production.origin}/api/subscribers/${subscriber}/subscriber-events`, {
    headers: { authorization: reader },
  });
  expect(rest.status).toBe(403);
  const refused = await callTool("get_subscriber_events", { id: subscriber }, reader);
  expect(refused.isError).toBe(true);
  expect(refused.content.map((part) => part.text).join("\n")).toContain(
    "permission denied: subscriber_events:get",
  );

  // Granted: the role has the permission and the tool serves the subscriber's events.
  const granted = await api("/api/roles/users/" + role.body.data.id, "PUT", {
    name: "mcp-events-reader",
    permissions: ["subscribers:get", "subscriber_events:get"],
  });
  expect(granted.status).toBe(200);
  const served = await callTool("get_subscriber_events", { id: subscriber }, reader);
  expect(served.isError).not.toBe(true);
});
