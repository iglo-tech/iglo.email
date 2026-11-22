// B124 (D125, adopter review): removing a suppression needs `suppressions:manage`, a permission of
// its own that only the built-in Super Admin holds by default. A role with `subscribers:manage` and
// nothing else is refused over REST and MCP and removes nothing; with the permission the same call
// removes the suppression. The suppressions come from real self-wipes of a campaign's recipients,
// on the compiled server, with the mailbox sink for the campaign's mail.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ensureProductionBuild } from "@/test/production-build";
import { admin, startMailbox, startProduction } from "@/test/worked-example/harness";
import type { Mailbox, Production } from "@/test/worked-example/harness";
import { provisionApiUser } from "@/test/contract/owned";
import { asBody } from "@/test/read-body";

let production: Production;
let mailbox: Mailbox;
let adminAuth: string;
let nextId = 1;
const suffix = Date.now().toString(36);

beforeAll(async () => {
  await ensureProductionBuild();
  production = await startProduction();
  mailbox = await startMailbox();
  const creds = await provisionApiUser(production.origin, admin);
  adminAuth = `token ${creds.user}:${creds.token}`;
  // Mail goes to the loopback sink only (AGENTS.md: tests never use a real SMTP server).
  const settings = (
    await (
      await fetch(`${production.origin}/api/settings`, {
        headers: { authorization: adminAuth },
      })
    ).json()
  ).data;
  const smtp = await fetch(`${production.origin}/api/settings/smtp`, {
    method: "PUT",
    headers: { authorization: adminAuth, "content-type": "application/json" },
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
  expect(smtp.status).toBe(200);
}, 60_000);

afterAll(async () => {
  await production?.stop().catch(() => {});
  await production?.close().catch(() => {});
  await mailbox?.close().catch(() => {});
});

async function api(path: string, method = "GET", body?: unknown, auth = adminAuth) {
  const response = await fetch(`${production.origin}${path}`, {
    method,
    headers: { authorization: auth, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
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
  const reply = asBody<{
    result?: { isError?: boolean; content: Array<{ type: string; text: string }> };
    error?: { message: string };
  }>(await response.json());
  if (reply.error) {
    throw new Error(`${name}: ${reply.error.message}`);
  }
  return reply.result!;
}

/** An API user whose role has exactly these user permissions. */
async function reader(name: string, permissions: Array<string>) {
  const role = await api("/api/roles/users", "POST", { name: `${name}-${suffix}`, permissions });
  expect(role.status).toBe(200);
  const user = await api("/api/users", "POST", {
    username: `${name}-${suffix}`,
    type: "api",
    status: "enabled",
    user_role_id: role.body.data.id,
  });
  expect(user.status).toBe(200);
  return `token ${name}-${suffix}:${user.body.data.password}`;
}

/** Wipes each address through the paired path of one campaign the runner delivered to all of them. */
async function wiped(addresses: Array<string>): Promise<void> {
  const list = (
    await api("/api/lists", "POST", { name: `suppress-${suffix}`, type: "public", optin: "single" })
  ).body.data;
  const subscribers: Array<{ uuid: string }> = [];
  for (const email of addresses) {
    subscribers.push(
      (
        await api("/api/subscribers", "POST", {
          email,
          name: "Wiped",
          lists: [list.id],
          preconfirm_subscriptions: true,
        })
      ).body.data,
    );
  }
  const campaign = (
    await api("/api/campaigns", "POST", {
      name: `suppress-${suffix}`,
      subject: "Suppression",
      lists: [list.id],
      type: "regular",
      content_type: "html",
      messenger: "email",
      from_email: "Fixture <noreply@fixture.test>",
      body: "<p>Hello</p>",
    })
  ).body.data;
  expect(
    (await api(`/api/campaigns/${campaign.id}/status`, "PUT", { status: "running" })).status,
  ).toBe(200);
  for (let i = 0; i < 300; i++) {
    if ((await api(`/api/campaigns/${campaign.id}`)).body.data.status === "finished") {
      break;
    }
    await Bun.sleep(100);
  }
  for (const subscriber of subscribers) {
    const response = await fetch(
      `${production.origin}/subscription/${campaign.uuid}/wipe/${subscriber.uuid}?confirm=true`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
  }
}

/** DELETE /api/suppressions over REST, as the given caller. */
async function removeOverRest(auth: string, email: string) {
  const response = await fetch(`${production.origin}/api/suppressions`, {
    method: "DELETE",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("removing a suppression needs suppressions:manage, over REST and MCP, and a refusal removes nothing", async () => {
  const [first, second, third] = [
    `first-${suffix}@example.test`,
    `second-${suffix}@example.test`,
    `third-${suffix}@example.test`,
  ] as const;
  await wiped([first, second, third]);

  // A role with subscribers:manage and nothing else is refused on both surfaces.
  const restricted = await reader("supp-restricted", ["subscribers:manage"]);
  const refusedRest = await removeOverRest(restricted, first);
  expect(refusedRest.status).toBe(403);
  expect(refusedRest.body.message).toBe("permission denied: suppressions:manage");
  const refusedTool = await callTool("delete_suppressions", { body: { email: first } }, restricted);
  expect(refusedTool.isError).toBe(true);
  expect(refusedTool.content.map((part) => part.text).join("\n")).toContain(
    "permission denied: suppressions:manage",
  );

  // Nothing was removed: Super Admin, who holds every permission, removes the first one now.
  expect(await removeOverRest(adminAuth, first)).toEqual({
    status: 200,
    body: { data: { removed: 1 } },
  });

  // With the permission, the same call over REST removes the second suppression...
  const granted = await reader("supp-granted", ["subscribers:manage", "suppressions:manage"]);
  expect(await removeOverRest(granted, second)).toEqual({
    status: 200,
    body: { data: { removed: 1 } },
  });
  // ...and over MCP the third.
  const served = await callTool("delete_suppressions", { body: { email: third } }, granted);
  expect(served.isError).not.toBe(true);
  expect(served.content.map((part) => part.text).join("\n")).toContain('"removed":1');
});
