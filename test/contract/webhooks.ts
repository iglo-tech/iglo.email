// Production-only: outbound webhooks are native (docs/design/04-sending.md#outbound-webhooks);
// listmonk has no equivalent, so there is no reference run. Exercised through the compiled
// executable's real HTTP, auth, migrations, restart and SQLite file, with a local receiver.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Credentials } from "@/test/contract/types";
import { startSink } from "@/test/tx/sink";
import { signatureValid, startReceiver } from "@/test/webhooks/receiver";

const dummy = "00000000-0000-0000-0000-000000000000";
const events = [
  "subscriber.unsubscribed",
  "subscriber.blocklisted",
  "subscriber.deleted",
  "send.failed",
];

export async function runWebhooksContract(target: {
  baseUrl: string;
  credentials: Credentials;
  restart: () => Promise<void>;
  dataDir: string;
}) {
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL webhooks-${label}`);
  };
  const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = { authorization },
  ) => {
    const response = await fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const receiver = startReceiver();
  const sink = await startSink({ reject: () => true });
  const stored = () => {
    const reader = new Database(join(target.dataDir, "iglo-email.db"), { readonly: true });
    try {
      return reader
        .query("SELECT payload FROM webhook_deliveries ORDER BY id")
        .all()
        .map((row) => (row as { payload: string }).payload)
        .join("\n");
    } finally {
      reader.close();
    }
  };
  const ofEvent = (event: string) => receiver.received.filter((r) => r.body.event === event);
  const arrived = async (event: string, count: number) => {
    const deadline = Date.now() + 10_000;
    while (ofEvent(event).length < count) {
      check(Date.now() < deadline, `arrival-${event}-${count}`);
      await Bun.sleep(5);
    }
  };
  try {
    // Authorization: an API user without the permission, and no credentials at all.
    const role = await call("/api/roles/users", "POST", {
      name: "no-webhooks",
      permissions: ["subscribers:get"],
    });
    const user = await call("/api/users", "POST", {
      username: "no-webhooks",
      type: "api",
      status: "enabled",
      user_role_id: role.body.data.id,
    });
    const denied = { authorization: `Basic ${btoa(`no-webhooks:${user.body.data.password}`)}` };
    check((await call("/api/webhooks", "GET", undefined, denied)).status === 403, "permission");
    check((await call("/api/webhooks", "GET", undefined, {})).status === 403, "anonymous");

    check(
      (await call("/api/webhooks", "POST", { url: "ftp://x.test/", events })).status === 400,
      "scheme",
    );
    const created = await call("/api/webhooks", "POST", { url: receiver.url(), events });
    check(created.status === 200 && /^[0-9a-f]{64}$/.test(created.body.data.secret), "create");
    const { id, secret } = created.body.data as { id: number; secret: string };
    check(!JSON.stringify((await call("/api/webhooks")).body).includes(secret), "secret-hidden");

    const settings = (await call("/api/settings")).body.data;
    check(settings["webhooks.block_private_addresses"] === false, "setting-default");
    await call("/api/settings/smtp", "PUT", [
      {
        ...settings.smtp[0],
        enabled: true,
        host: "127.0.0.1",
        port: sink.port,
        auth_protocol: "none",
        username: "",
        password: "",
        tls_type: "none",
        email_headers: [],
      },
    ]);
    await call("/api/settings/app.from_email", "PUT", ["Fixture <noreply@fixture.test>"]);

    const list = (
      await call("/api/lists", "POST", { name: "hooks", type: "public", optin: "single" })
    ).body.data.id as number;
    const subscriber = async (name: string, external?: string) =>
      (
        await call("/api/subscribers", "POST", {
          email: `${name}@example.test`,
          name,
          lists: [list],
          ...(external ? { external_id: external } : {}),
        })
      ).body.data as { id: number; uuid: string };

    // One-click without a login; a repeat changes nothing, so it queues nothing.
    const oneClick = (uuid: string) =>
      fetch(`${target.baseUrl}/subscription/${dummy}/${uuid}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
    const clicked = await subscriber("clicked", "app-clicked");
    check((await oneClick(clicked.uuid)).status === 200, "one-click");
    await arrived("subscriber.unsubscribed", 1);
    check((await oneClick(clicked.uuid)).status === 200, "one-click-repeat");
    const first = ofEvent("subscriber.unsubscribed")[0]!;
    check(signatureValid(first, secret), "signature");
    check(
      first.body.data.subscriber.external_id === "app-clicked" &&
        first.body.data.list_ids[0] === list,
      "unsubscribed-data",
    );

    // Bulk by query and by ID.
    const bulk = await subscriber("bulk-a");
    await subscriber("bulk-b");
    const byQuery = await call("/api/subscribers/query/blocklist", "PUT", {
      query: "subscribers.email LIKE 'bulk-%'",
    });
    check(byQuery.status === 200, `query-blocklist-${byQuery.status}`);
    await arrived("subscriber.blocklisted", 2);
    check(
      (
        await call("/api/subscribers/query/blocklist", "PUT", {
          query: "subscribers.email LIKE 'bulk-%'",
        })
      ).status === 200,
      "query-blocklist-repeat",
    );
    const bulkLists = await subscriber("lists-a");
    const listQuery = {
      query: "subscribers.email LIKE 'lists-%'",
      action: "unsubscribe",
      target_list_ids: [list],
    };
    check(
      (await call("/api/subscribers/query/lists", "PUT", listQuery)).status === 200,
      "query-unsubscribe",
    );
    await arrived("subscriber.unsubscribed", 4);
    check((await call("/api/subscribers/query/lists", "PUT", listQuery)).status === 200, "repeat");
    check(
      ofEvent("subscriber.unsubscribed").at(-1)!.body.data.subscriber.id === bulkLists.id,
      "query-unsubscribe-data",
    );
    const single = await subscriber("single");
    check((await call(`/api/subscribers/${single.id}/blocklist`, "PUT", {})).status === 200, "bl");
    await arrived("subscriber.blocklisted", 3);
    check(ofEvent("subscriber.unsubscribed").length === 5, "blocklist-ends-memberships");

    // A failed send, with the send journal's own state.
    const failing = await subscriber("failing");
    const template = (
      await call("/api/templates", "POST", {
        name: "hook",
        type: "tx",
        subject: "Hello",
        body: "<p>hello</p>",
      })
    ).body.data.id as number;
    await call("/api/tx", "POST", { subscriber_id: failing.id, template_id: template });
    await arrived("send.failed", 1);
    const failed = ofEvent("send.failed")[0]!.body.data;
    check(failed.subscriber.id === failing.id && failed.send.status === "failed", "send-failed");

    // The public wipe and an admin delete: no address in anything stored afterwards.
    const wiped = await subscriber("wiped", "app-wiped");
    await call(`/api/subscribers/${wiped.id}/blocklist`, "PUT", {});
    await arrived("subscriber.blocklisted", 4);
    const wipe = await fetch(`${target.baseUrl}/subscription/wipe/${wiped.uuid}`, {
      method: "POST",
    });
    check(wipe.status === 200, `wipe-${wipe.status}`);
    await arrived("subscriber.deleted", 1);
    const gone = ofEvent("subscriber.deleted")[0]!.body.data.subscriber;
    check(gone.id === wiped.id && gone.uuid === wiped.uuid && gone.email === "", "deleted-data");
    check(gone.external_id === "app-wiped", "deleted-external-id");
    check(signatureValid(ofEvent("subscriber.deleted")[0]!, secret), "deleted-signature");
    await call(`/api/subscribers/${bulk.id}`, "DELETE");
    await arrived("subscriber.deleted", 2);
    const settled = async () => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const rows = (await call(`/api/webhooks/${id}/deliveries?per_page=100`)).body.data.results;
        if (rows.every((row: { status: string }) => row.status === "delivered")) return rows;
        check(Date.now() < deadline, "deliveries-settle");
        await Bun.sleep(5);
      }
    };
    const rows = await settled();
    check(rows.length === receiver.received.length, "one-delivery-each");
    check(new Set(receiver.received.map((r) => r.body.id)).size === rows.length, "ids-unique");
    const bytes = stored();
    for (const value of ["wiped@example.test", "bulk-a@example.test", "app-wiped"])
      check(!bytes.includes(value), `cleared-${value}`);
    check(bytes.includes("clicked@example.test"), "others-kept");

    // A public-address policy refuses the loopback receiver at delivery time.
    check(
      (await call("/api/settings/webhooks.block_private_addresses", "PUT", true)).status === 200,
      "setting-update",
    );
    const blocked = receiver.received.length;
    const refused = await subscriber("refused");
    await call(`/api/subscribers/${refused.id}/blocklist`, "PUT", {});
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [row] = (await call(`/api/webhooks/${id}/deliveries`)).body.data.results;
      if (row.last_error === "blocked_address") break;
      check(Date.now() < deadline, "blocked-address");
      await Bun.sleep(5);
    }
    check(receiver.received.length === blocked, "blocked-no-request");
    // A listmonk client's full settings write keeps the native key.
    const full = (await call("/api/settings")).body.data;
    delete full["webhooks.block_private_addresses"];
    check((await call("/api/settings", "PUT", full)).status === 200, "settings-full");
    check(
      (await call("/api/settings")).body.data["webhooks.block_private_addresses"] === true,
      "setting-kept",
    );
    await call("/api/settings/webhooks.block_private_addresses", "PUT", false);

    // Configuration and the secret survive a restart; the held row is retried in time by the
    // clock tests, so only the durable configuration is checked here.
    await target.restart();
    const restarted = await subscriber("restarted");
    await call(`/api/subscribers/${restarted.id}`, "DELETE");
    await arrived("subscriber.deleted", 3);
    check(signatureValid(ofEvent("subscriber.deleted")[2]!, secret), "restart-signature");
    check((await call(`/api/webhooks/${id}`, "DELETE")).status === 200, "delete");
    check((await call(`/api/webhooks/${id}/deliveries`)).status === 404, "deleted-gone");
    check(!stored(), "deliveries-gone");
  } finally {
    receiver.close();
    await sink.close();
  }
}
