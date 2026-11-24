// Production-only: outbound webhooks are native (docs/design/04-sending.md#outbound-webhooks);
// listmonk has no equivalent, so there is no reference run. Exercised through the compiled
// executable's real HTTP, auth, migrations, restart and SQLite file, with a local receiver.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Credentials } from "@/test/contract/types";
import { startSink } from "@/test/tx/sink";
import {
  signatureCount,
  signatureTime,
  signatureValid,
  startReceiver,
} from "@/test/webhooks/receiver";
import { verifyDelivery } from "@/test/webhooks/verify-delivery";
import { asBody } from "@/test/read-body";
import { untilState } from "@/test/wait";

const dummy = "00000000-0000-0000-0000-000000000000";
const events = [
  "subscriber.unsubscribed",
  "subscriber.blocklisted",
  "subscriber.deleted",
  "send.failed",
];

const check = (condition: unknown, label: string) => {
  if (!condition) {
    throw new Error(`FAIL webhooks-${label}`);
  }
};

export async function runWebhooksContract(target: {
  baseUrl: string;
  credentials: Credentials;
  restart: () => Promise<void>;
  dataDir: string;
}) {
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
        .map((row) => asBody<{ payload: string }>(row).payload)
        .join("\n");
    } finally {
      reader.close();
    }
  };
  const ofEvent = (event: string) => receiver.received.filter((r) => r.body.event === event);
  const arrived = async (event: string, count: number) => {
    await untilState(() => ofEvent(event).length >= count, {
      label: `arrival-${event}-${count}`,
      progress: () => String(ofEvent(event).length),
      stallMs: 10_000,
    });
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
    // B125 (D122): a default install refuses a private target at delivery, with no request sent. The
    // probes subscribe to their own event, so the receiver below sees none of them; they are deleted
    // before it is switched on.
    check(
      (await call("/api/settings")).body.data["webhooks.block_private_addresses"] === true,
      "setting-default",
    );
    const probeListCreated = await call("/api/lists", "POST", {
      name: "probe",
      type: "public",
      optin: "single",
    });
    const probeList = asBody<number>(probeListCreated.body.data.id);
    const probeCreated = await call("/api/subscribers", "POST", {
      email: "probe@example.test",
      name: "probe",
      lists: [probeList],
    });
    const probe = asBody<number>(probeCreated.body.data.id);
    const probes: Array<number> = [];
    for (const url of [
      receiver.url(),
      `http://localhost:${receiver.port}/`,
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      const webhookCreated = await call("/api/webhooks", "POST", {
        url,
        events: ["subscriber.blocklisted"],
      });
      probes.push(asBody<number>(webhookCreated.body.data.id));
    }
    await call(`/api/subscribers/${probe}/blocklist`, "PUT", {});
    for (const id of probes) {
      let last = "no delivery";
      await untilState(
        async () => {
          const [row] = (await call(`/api/webhooks/${id}/deliveries`)).body.data.results;
          last = row?.last_error ?? "no delivery";
          return last === "blocked_address";
        },
        { label: "default-refused", progress: () => last, stallMs: 10_000 },
      );
    }
    check(receiver.received.length === 0, "default-refused-no-request");
    for (const id of probes) {
      check((await call(`/api/webhooks/${id}`, "DELETE")).status === 200, "probe-delete");
    }
    // The receivers below are on loopback, so the operator turns the block off; the stored false is
    // checked again after a restart.
    check(
      (await call("/api/settings/webhooks.block_private_addresses", "PUT", false)).status === 200,
      "setting-off",
    );

    const created = await call("/api/webhooks", "POST", { url: receiver.url(), events });
    check(created.status === 200 && /^[0-9a-f]{64}$/.test(created.body.data.secret), "create");
    const { id, secret } = asBody<{ id: number; secret: string }>(created.body.data);
    check(!JSON.stringify((await call("/api/webhooks")).body).includes(secret), "secret-hidden");

    const settings = (await call("/api/settings")).body.data;
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

    const listCreated = await call("/api/lists", "POST", {
      name: "hooks",
      type: "public",
      optin: "single",
    });
    const list = asBody<number>(listCreated.body.data.id);
    const subscriber = async (
      name: string,
      external?: string,
      lists: Array<number> | null = [list],
    ) => {
      const created = await call("/api/subscribers", "POST", {
        email: `${name}@example.test`,
        name,
        ...(lists ? { lists } : {}),
        ...(external ? { external_id: external } : {}),
      });
      return asBody<{ id: number; uuid: string }>(created.body.data);
    };

    // One-click (D137 item 3): the placeholder link ends pending double opt-ins only, so the
    // subscriber's membership is an unconfirmed double opt-in list. It is added by the bulk action,
    // not on create, which would also queue an opt-in mail the sink refuses. One-click works without
    // a login; a repeat changes nothing, so it queues nothing.
    const doubleCreated = await call("/api/lists", "POST", {
      name: "hooks-double",
      type: "public",
      optin: "double",
    });
    const doubleList = asBody<number>(doubleCreated.body.data.id);
    const oneClick = (uuid: string) =>
      fetch(`${target.baseUrl}/subscription/${dummy}/${uuid}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
    const clicked = await subscriber("clicked", "app-clicked", null);
    check(
      (
        await call("/api/subscribers/lists", "PUT", {
          ids: [clicked.id],
          target_list_ids: [doubleList],
          action: "add",
          status: "unconfirmed",
        })
      ).status === 200,
      "pending-double-add",
    );
    const memberships = asBody<{
      lists: Array<{ id: number; subscription_status: string }>;
    }>((await call(`/api/subscribers/${clicked.id}`)).body.data);
    check(
      memberships.lists.some((l) => l.id === doubleList && l.subscription_status === "unconfirmed"),
      "pending-double-membership",
    );
    check((await oneClick(clicked.uuid)).status === 200, "one-click");
    await arrived("subscriber.unsubscribed", 1);
    check((await oneClick(clicked.uuid)).status === 200, "one-click-repeat");
    const first = ofEvent("subscriber.unsubscribed")[0]!;
    check(signatureValid(first, secret), "signature");
    check(
      first.body.data.subscriber.external_id === "app-clicked" &&
        first.body.data.list_ids[0] === doubleList,
      "unsubscribed-data",
    );

    // Bulk by query and by ID.
    const bulk = await subscriber("bulk-a", "app-bulk");
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
    const templateCreated = await call("/api/templates", "POST", {
      name: "hook",
      type: "tx",
      subject: "Hello",
      body: "<p>hello</p>",
    });
    const template = asBody<number>(templateCreated.body.data.id);
    await call("/api/tx", "POST", { subscriber_id: failing.id, template_id: template });
    await arrived("send.failed", 1);
    const failed = ofEvent("send.failed")[0]!.body.data;
    check(failed.subscriber.id === failing.id && failed.send.status === "failed", "send-failed");

    // The public wipe and an admin delete: no address in anything stored afterwards. B124 (D125,
    // deliberate difference): the wipe's own deleted event names its external ID and lists, which
    // upstream's deleted event does not; the address stays out.
    const wiped = await subscriber("wiped", "app-wiped-7");
    // B123 (D126): a wipe pairs the subscriber through a campaign the runner delivered to them. It
    // is made before the blocklist below, since a blocklisted subscriber gets no delivery.
    const pairedCreated = await call("/api/campaigns", "POST", {
      name: "wipe pairing",
      subject: "wipe pairing",
      lists: [list],
      type: "regular",
      content_type: "html",
      messenger: "email",
      from_email: "Fixture <noreply@fixture.test>",
      body: "<p>Paired</p>",
    });
    const paired = asBody<{ id: number; uuid: string }>(pairedCreated.body.data);
    check(
      (await call(`/api/campaigns/${paired.id}/status`, "PUT", { status: "running" })).status ===
        200,
      "wipe-pairing-start",
    );
    let pairedStatus = "";
    await untilState(
      async () =>
        (pairedStatus = (await call(`/api/campaigns/${paired.id}`)).body.data.status) ===
        "finished",
      { label: "wipe-pairing-finish", progress: () => pairedStatus, stallMs: 10_000 },
    );
    await call(`/api/subscribers/${wiped.id}/blocklist`, "PUT", {});
    await arrived("subscriber.blocklisted", 4);
    // B126 (D123): a wipe deletes only when confirmed.
    const wipe = await fetch(
      `${target.baseUrl}/subscription/${paired.uuid}/wipe/${wiped.uuid}?confirm=true`,
      { method: "POST" },
    );
    check(wipe.status === 200, `wipe-${wipe.status}`);
    await arrived("subscriber.deleted", 1);
    const gone = ofEvent("subscriber.deleted")[0]!.body.data.subscriber;
    check(gone.id === wiped.id && gone.uuid === wiped.uuid && gone.email === "", "deleted-data");
    check(gone.external_id === "app-wiped-7", "wiped-external-id");
    check(
      JSON.stringify(ofEvent("subscriber.deleted")[0]!.body.data.list_ids) === `[${list}]`,
      "wiped-list-ids",
    );
    check(!stored().includes("wiped@example.test"), "wiped-stored");
    // B124 (D125, deliberate difference): the wiped address is suppressed, so its next event grants
    // nothing and answers `suppressed`. Upstream keeps no suppression and grants again.
    const granted = await call("/api/subscriber-events", "POST", {
      subscriber: { email: "wiped@example.test", grant_lists: [list] },
      name: "order_paid",
    });
    check(
      granted.status === 200 && granted.body.data.grants[0]?.result === "suppressed",
      "wiped-grant-suppressed",
    );
    check(signatureValid(ofEvent("subscriber.deleted")[0]!, secret), "deleted-signature");
    await call(`/api/subscribers/${bulk.id}`, "DELETE");
    await arrived("subscriber.deleted", 2);
    check(
      ofEvent("subscriber.deleted")[1]!.body.data.subscriber.external_id === "app-bulk",
      "admin-external-id",
    );
    const settled = async () => {
      let rows: Array<{ status: string }> = [];
      await untilState(
        async () => {
          rows = asBody<Array<{ status: string }>>(
            (await call(`/api/webhooks/${id}/deliveries?per_page=100`)).body.data.results,
          );
          return rows.every((row) => row.status === "delivered");
        },
        {
          label: "deliveries-settle",
          progress: () => rows.map((row) => row.status).join(),
          stallMs: 10_000,
        },
      );
      return rows;
    };
    const rows = await settled();
    check(rows.length === receiver.received.length, "one-delivery-each");
    const deliveredIds = asBody<Array<{ body: { id: unknown } }>>(receiver.received).map(
      (r) => r.body.id,
    );
    check(new Set(deliveredIds).size === rows.length, "ids-unique");
    const bytes = stored();
    for (const value of ["wiped@example.test", "bulk-a@example.test", "app-bulk"]) {
      check(!bytes.includes(value), `cleared-${value}`);
    }
    check(bytes.includes("clicked@example.test"), "others-kept");

    // D130: a rotation signs with both secrets for its window, shows the new secret once, and keeps
    // the window across a restart. The documented helper accepts the delivery with the new secret.
    check(
      (await call(`/api/webhooks/${id}/rotate-secret`, "POST", { overlap_hours: 169 })).status ===
        400,
      "rotate-range",
    );
    check(
      (await call("/api/webhooks/999999/rotate-secret", "POST", {})).status === 404,
      "rotate-missing",
    );
    check(
      (await call(`/api/webhooks/${id}/rotate-secret`, "POST", {}, denied)).status === 403,
      "rotate-permission",
    );
    const rotation = await call(`/api/webhooks/${id}/rotate-secret`, "POST", { overlap_hours: 24 });
    check(rotation.status === 200 && /^[0-9a-f]{64}$/.test(rotation.body.data.secret), "rotate");
    const next: string = rotation.body.data.secret;
    const until: string = rotation.body.data.previous_secret_until;
    check(next !== secret && Date.parse(until) - Date.now() > 23 * 3_600_000, "rotate-window");
    check(!JSON.stringify((await call("/api/webhooks")).body).includes(next), "rotate-hidden");
    const windowed = await subscriber("rotated");
    await call(`/api/subscribers/${windowed.id}/blocklist`, "PUT", {});
    await arrived("subscriber.blocklisted", 5);
    const during = ofEvent("subscriber.blocklisted").at(-1)!;
    check(
      signatureCount(during) === 2 &&
        signatureValid(during, next) &&
        signatureValid(during, secret),
      "rotate-both",
    );
    check(
      verifyDelivery(during.text, during.signature, [next], () => false, signatureTime(during))
        .event === "subscriber.blocklisted",
      "rotate-helper",
    );

    // A public-address policy refuses the loopback receiver at delivery time.
    check(
      (await call("/api/settings/webhooks.block_private_addresses", "PUT", true)).status === 200,
      "setting-update",
    );
    const blocked = receiver.received.length;
    const refused = await subscriber("refused");
    await call(`/api/subscribers/${refused.id}/blocklist`, "PUT", {});
    let last = "no delivery";
    await untilState(
      async () => {
        const [row] = (await call(`/api/webhooks/${id}/deliveries`)).body.data.results;
        last = row?.last_error ?? "no delivery";
        return last === "blocked_address";
      },
      { label: "blocked-address", progress: () => last, stallMs: 10_000 },
    );
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

    // Deliberate difference (07): a bulk action over the delivery budget writes nothing.
    const blockedBefore = (await call("/api/subscribers?per_page=1&status=blocklisted")).body.data
      .total;
    const writer = new Database(join(target.dataDir, "iglo-email.db"));
    writer.run(
      `WITH RECURSIVE i(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM i WHERE n < 50001)
       INSERT INTO subscribers (uuid, email, name)
       SELECT lower(hex(randomblob(16))), 'budget' || n || '@example.test', 'Budget' FROM i`,
    );
    writer.close();
    const total = (await call("/api/subscribers?per_page=1")).body.data.total;
    const over = await call("/api/subscribers/query/blocklist", "PUT", {
      query: "subscribers.email LIKE 'budget%'",
    });
    check(
      over.status === 400 && asBody<string>(over.body.message).includes("Narrow the selection"),
      "budget",
    );
    check(
      (await call("/api/subscribers?per_page=1&status=blocklisted")).body.data.total ===
        blockedBefore,
      "budget-atomic",
    );
    check((await call("/api/subscribers?per_page=1")).body.data.total === total, "budget-total");
    await call("/api/subscribers/query/delete", "POST", { query: "subscribers.id > 0" }).then(
      (refused) => check(refused.status === 400, "budget-delete"),
    );

    // Configuration and the secret survive a restart; the held row is retried in time by the
    // clock tests, so only the durable configuration is checked here.
    await target.restart();
    // B125 (D122): a stored false is the operator's choice and survives a restart.
    check(
      (await call("/api/settings")).body.data["webhooks.block_private_addresses"] === false,
      "restart-keeps-stored-false",
    );
    // D130: the rotation's window is stored, so after a restart the old secret still signs.
    const kept = asBody<{ results: Array<{ id: number; previous_secret_until: unknown }> }>(
      (await call("/api/webhooks")).body.data,
    ).results.find((hook) => hook.id === id)!;
    check(kept.previous_secret_until === until, "restart-keeps-window");
    const restarted = await subscriber("restarted");
    await call(`/api/subscribers/${restarted.id}`, "DELETE");
    await arrived("subscriber.deleted", 3);
    check(signatureValid(ofEvent("subscriber.deleted")[2]!, secret), "restart-signature");
    check(signatureValid(ofEvent("subscriber.deleted")[2]!, next), "restart-next-signature");
    check((await call(`/api/webhooks/${id}`, "DELETE")).status === 200, "delete");
    check((await call(`/api/webhooks/${id}/deliveries`)).status === 404, "deleted-gone");
    check(!stored(), "deliveries-gone");
  } finally {
    await receiver.close();
    await sink.close();
  }
}
