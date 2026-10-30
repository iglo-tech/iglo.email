// Reference: listmonk cmd/bounce.go, internal/core/bounces.go and queries/bounces.sql at 6fcd95f.
// The shared corpus runs against both targets; the Mailgun endpoint, send links and outbound
// webhooks are native, so that part runs against the compiled production executable only.
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import type { Credentials, Mode } from "@/test/contract/types";
import { startSink } from "@/test/tx/sink";
import { signatureValid, startReceiver } from "@/test/webhooks/receiver";

const signingKey = "contract-mailgun-signing-key";

export async function runBouncesContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
  restart?: () => Promise<void>;
  dataDir?: string;
}) {
  const reference = target.mode === "reference";
  const suffix = crypto.randomUUID().slice(0, 8);
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL bounces-${label}`);
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
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* A public page. */
    }
    return { status: response.status, body: parsed, text };
  };
  const setting = async (key: string, value: unknown) => {
    check((await call(`/api/settings/${key}`, "PUT", value)).status === 200, `setting-${key}`);
    // Upstream reloads asynchronously after a settings write.
    if (reference) {
      await Bun.sleep(1200);
      for (const deadline = Date.now() + 15_000; Date.now() < deadline; await Bun.sleep(100)) {
        try {
          if ((await fetch(`${target.baseUrl}/health`)).ok) break;
        } catch {
          /* Still reloading. */
        }
      }
    }
  };
  const address = (name: string) => `${name}-${suffix}@example.com`;
  const subscriber = async (name: string, lists: number[] = []) => {
    const email = address(name);
    const created = await call("/api/subscribers", "POST", {
      email,
      name,
      status: "enabled",
      lists,
      preconfirm_subscriptions: true,
    });
    check(created.status === 200, `subscriber-${name}`);
    const { id, uuid } = created.body.data as { id: number; uuid: string };
    return { id, uuid, email };
  };
  const post = (body: unknown, headers?: Record<string, string>) =>
    call("/webhooks/bounce", "POST", body, headers);
  const bounces = async (id: number) =>
    (await call(`/api/subscribers/${id}/bounces`)).body.data as any[];
  /** Upstream queues bounces; a sentinel behind them in that queue shows they were handled. */
  const flushed = async () => {
    const sentinel = await subscriber(`sentinel-${crypto.randomUUID().slice(0, 8)}`);
    const sent = await post({ email: sentinel.email, type: "soft", source: "sentinel" });
    check(sent.status === 200, "sentinel");
    for (const deadline = Date.now() + 10_000; ; await Bun.sleep(25)) {
      if ((await bounces(sentinel.id)).length === 1) break;
      check(Date.now() < deadline, "sentinel-wait");
    }
    await call(`/api/subscribers/${sentinel.id}`, "DELETE");
  };
  const recorded = async (body: unknown) => {
    const response = await post(body);
    check(response.status === 200 && response.body?.data === true, "record");
    await flushed();
  };
  const originals = (await call("/api/settings")).body.data as Record<string, any>;
  const lists: number[] = [],
    campaigns: number[] = [],
    users: number[] = [],
    roles: number[] = [];
  const list = async (name: string) => {
    const created = await call("/api/lists", "POST", {
      name: `bounce-${name}-${suffix}`,
      type: "private",
      optin: "single",
    });
    check(created.status === 200, `list-${name}`);
    lists.push(created.body.data.id);
    return created.body.data.id as number;
  };
  const campaign = async (name: string, listID: number) => {
    const created = await call("/api/campaigns", "POST", {
      name: `bounce-${name}-${suffix}`,
      subject: "Bounce subject",
      lists: [listID],
      content_type: "plain",
      type: "regular",
      messenger: "email",
      body: "Body",
    });
    check(created.status === 200, `campaign-${name}`);
    campaigns.push(created.body.data.id);
    return created.body.data as { id: number; uuid: string; name: string };
  };
  const apiUser = async (name: string, permissions: string[], listPermissions?: unknown[]) => {
    const role = await call("/api/roles/users", "POST", {
      name: `${name}-${suffix}`,
      permissions,
    });
    check(role.status === 200, `role-${name}`);
    roles.push(role.body.data.id);
    let listRole: number | undefined;
    if (listPermissions) {
      const created = await call("/api/roles/lists", "POST", {
        name: `${name}-lists-${suffix}`,
        lists: listPermissions,
      });
      check(created.status === 200, `list-role-${name}`);
      roles.push(created.body.data.id);
      listRole = created.body.data.id;
    }
    const username = `${name}-${suffix}`;
    const user = await call("/api/users", "POST", {
      username,
      type: "api",
      status: "enabled",
      name,
      user_role_id: role.body.data.id,
      ...(listRole === undefined ? {} : { list_role_id: listRole }),
    });
    check(user.status === 200, `user-${name}`);
    users.push(user.body.data.id);
    return { authorization: `Basic ${btoa(`${username}:${user.body.data.password}`)}` };
  };

  try {
    // Gates: upstream registers the routes only with webhooks enabled, and without bounce
    // processing there is no manager.
    await setting("bounce.webhooks_enabled", false);
    check((await post({ email: "a@b.c", type: "hard" })).status === 404, "gate-webhooks");
    check((await call("/webhooks/service/ses", "POST", {})).status === 404, "gate-service");
    await setting("bounce.enabled", false);
    await setting("bounce.webhooks_enabled", true);
    check((await post({ email: "a@b.c", type: "hard" })).status === 503, "gate-bounce");
    check((await call("/webhooks/service/ses", "POST", {})).status === 503, "gate-bounce-service");
    await setting("bounce.actions", {
      soft: { count: 2, action: "none" },
      hard: { count: 2, action: "unsubscribe" },
      complaint: { count: 1, action: "blocklist" },
    });
    await setting("bounce.enabled", true);

    // Other providers answer as a disabled provider does upstream.
    for (const service of ["ses", "sendgrid", "postmark", "azure", "forwardemail", "lettermint"]) {
      const answer = await call(`/webhooks/service/${service}`, "POST", {});
      check(answer.status === 400 && answer.body.message === "Unknown service.", service);
    }

    // Authentication and permissions.
    check((await post({ email: "a@b.c", type: "hard" }, {})).status === 403, "post-anonymous");
    const readOnly = await apiUser("bounce-read", ["bounces:get"]);
    const manager = await apiUser("bounce-manage", ["bounces:manage"]);
    check((await call("/api/bounces", "GET", undefined, {})).status === 403, "get-anonymous");
    check((await call("/api/bounces", "GET", undefined, manager)).status === 403, "get-permission");
    check((await call("/api/bounces/1", "GET", undefined, manager)).status === 403, "one-denied");
    check((await call("/api/bounces?all=true", "DELETE", undefined, readOnly)).status === 403, "d");
    check((await call("/api/bounces/1", "DELETE", undefined, readOnly)).status === 403, "d-one");
    check((await call("/api/bounces/blocklist", "PUT", undefined, readOnly)).status === 403, "b");
    check((await post({ email: "a@b.c", type: "hard" }, readOnly)).status === 403, "post-denied");

    // Validation.
    const invalid: [string, unknown, string?][] = [
      ["no-address", { type: "hard" }, "Invalid fields: email / subscriber_uuid"],
      ["uuid", { subscriber_uuid: "nope", type: "hard" }, "Invalid fields: subscriber_uuid"],
      ["email", { email: "nope", type: "hard" }],
      ["type", { email: "a@example.com", type: "nope" }, "Invalid fields: type"],
      ["no-type", { email: "a@example.com" }, "Invalid fields: type"],
      ["json", "{"],
      ["field-type", { email: 1, type: "hard" }],
    ];
    for (const [label, body, message] of invalid) {
      const answer = await post(body);
      check(answer.status === 400, `invalid-${label}`);
      if (message) check(answer.body.message === message, `invalid-text-${label}`);
    }

    // Recording by email, by UUID and with a campaign. Unknown recipients are accepted and
    // store nothing.
    const listA = await list("a"),
      listB = await list("b");
    const first = await campaign("first", listA),
      second = await campaign("second", listA);
    const before = (await call("/api/bounces?per_page=all")).body.data.total as number;
    const ada = await subscriber("ada", [listA]);
    await recorded({ email: ada.email, type: "soft", source: "api", meta: { reason: "x" } });
    await recorded({
      subscriber_uuid: ada.uuid.toUpperCase(),
      type: "complaint",
      source: "script",
      campaign_uuid: first.uuid,
      created_at: "2026-01-02T03:04:05Z",
    });
    await recorded({ email: address("unknown"), type: "hard", source: "api" });
    await recorded({ subscriber_uuid: crypto.randomUUID(), type: "hard", source: "api" });
    await recorded({ email: address("ada"), type: "soft", campaign_uuid: "not-a-uuid" });
    await recorded({ email: address("ada"), type: "soft", campaign_uuid: crypto.randomUUID() });
    check(
      (await call("/api/bounces?source=sentinel&per_page=all")).body.data.total === 0,
      "sentinels-gone",
    );
    const adas = await bounces(ada.id);
    // `not-a-uuid` fails upstream's cast; the unknown campaign's is the second soft row. The
    // complaint blocklists, so upstream records no row for either: both stores agree on two.
    check(adas.length === 2, "ada-rows");
    check((await call("/api/bounces?per_page=all")).body.data.total === before + 2, "total");
    const complaint = adas.find((b) => b.type === "complaint");
    const soft = adas.find((b) => b.type === "soft");
    check(adas[0].id === soft.id, "default-order");
    check(complaint.campaign.id === first.id && complaint.campaign.name === first.name, "camp");
    check(Object.keys(complaint.campaign).length === 2, "camp-shape");
    check(soft.campaign === null && soft.meta.reason === "x" && soft.source === "api", "soft");
    check(complaint.email === ada.email && complaint.subscriber_uuid === ada.uuid, "email");
    check(complaint.subscriber_id === ada.id, "subscriber-id");
    check(complaint.subscriber_status === "blocklisted", "subscriber-status");
    check(Date.parse(complaint.created_at) === Date.UTC(2026, 0, 2, 3, 4, 5), "created-at");
    check(!("campaign_uuid" in complaint) && !("subscriber_name" in complaint), "hidden-fields");
    check(typeof complaint.meta === "object", "meta-default");

    const one = await call(`/api/bounces/${complaint.id}`);
    check(one.status === 200 && one.body.data.id === complaint.id, "get-one");
    const missing = await call("/api/bounces/999999999");
    check(missing.status === 400 && missing.body.message === "Bounce not found", "get-missing");
    check((await call("/api/bounces/x")).status === 400, "get-bad-id");

    // Filters, ordering and paging.
    const bob = await subscriber("bob", [listA]);
    const cyd = await subscriber("cyd", [listB]);
    await recorded({ email: bob.email, type: "soft", source: "beta", campaign_uuid: second.uuid });
    await recorded({ email: cyd.email, type: "hard", source: "alpha", campaign_uuid: first.uuid });
    // A malformed campaign UUID drops the event; an unknown one keeps it without a campaign.
    const kaz = await subscriber("kaz", [listA]);
    await recorded({ email: kaz.email, type: "soft", source: "kaz", campaign_uuid: "not-a-uuid" });
    check((await bounces(kaz.id)).length === 0, "malformed-campaign");
    await recorded({
      email: kaz.email,
      type: "soft",
      source: "kaz",
      campaign_uuid: crypto.randomUUID(),
    });
    const kazRows = await bounces(kaz.id);
    check(kazRows.length === 1 && kazRows[0].campaign === null, "unknown-campaign");
    check((await call(`/api/subscribers/${kaz.id}/bounces`, "DELETE")).status === 200, "kaz");
    const query = async (params: string) =>
      (await call(`/api/bounces?${params}`)).body.data as Record<string, any>;
    const byCampaign = await query(`campaign_id=${first.id}`);
    check(byCampaign.total === 2, "filter-campaign");
    check(
      byCampaign.results.every((b: any) => b.campaign.id === first.id),
      "filter-campaign-rows",
    );
    check((await query("source=beta")).total === 1, "filter-source");
    check((await query(`source=alpha&campaign_id=${second.id}`)).total === 0, "filter-both");
    check((await query("source=beta&type=hard")).total === 0, "filter-type");
    const bySource = await query(`source=beta&type=soft`);
    check(bySource.results[0].email === bob.email, "filter-type-rows");
    const empty = await query("source=absent");
    check(
      JSON.stringify(empty) ===
        '{"results":[],"search":"","query":"","total":0,"per_page":0,"page":0}',
      "empty-shape",
    );
    const paged = await query("per_page=1&page=2&order_by=source&order=asc");
    check(paged.per_page === 1 && paged.page === 2 && paged.results.length === 1, "paged");
    check(paged.total === before + 4, "paged-total");
    check(paged.search === "" && paged.query === "", "paged-keys");
    const ours = "campaign_id=" + first.id;
    const ascending = await query(`${ours}&order_by=email&order=asc`);
    check(ascending.results[0].email === ada.email, "order-asc");
    const descending = await query(`${ours}&order_by=email&order=desc`);
    check(descending.results[0].email === cyd.email, "order-desc");
    const fallback = await query(`${ours}&order_by=nope&order=nope`);
    check(fallback.results[0].created_at >= fallback.results[1].created_at, "order-fallback");
    const all = await query("per_page=all");
    check(all.per_page === 0 && all.page === 1 && all.total === all.results.length, "per-all");
    // Upstream's order_by=campaign_name names no column and answers 500, and an unknown type
    // fails its enum cast with 500. Clients get the sort and an empty page instead.
    const byName = await call(`/api/bounces?${ours}&order_by=campaign_name`);
    const badType = await call("/api/bounces?type=nope");
    if (reference) check(byName.status === 500 && badType.status === 500, "difference-reference");
    else check(byName.status === 200 && badType.body.data.total === 0, "difference-production");

    // The documented `meta` spelling is an escaped JSON string. Upstream keeps the string; the
    // schema's `meta` is an object, so it stores the object the string holds.
    const dee = await subscriber("dee", [listB]);
    await recorded({ email: dee.email, type: "soft", meta: '{"additional":"info"}' });
    const [documented] = await bounces(dee.id);
    if (reference) check(documented.meta === '{"additional":"info"}', "meta-reference");
    else check(documented.meta.additional === "info", "meta-production");

    // Thresholds: rows stop at the count, whose bounce fires the action. Soft is `none`.
    await recorded({ email: bob.email, type: "soft", source: "beta" });
    await recorded({ email: bob.email, type: "soft", source: "beta" });
    check((await bounces(bob.id)).length === 2, "soft-stops-at-count");
    check((await call(`/api/subscribers/${bob.id}`)).body.data.status === "enabled", "soft-none");

    // Unsubscribe at the count, on every list, keeping the status. A later bounce adds no row.
    const eve = await subscriber("eve", [listA, listB]);
    const statuses = async (id: number) =>
      (await call(`/api/subscribers/${id}`)).body.data.lists.map(
        (l: any) => l.subscription_status,
      ) as string[];
    const consentTimes = async (id: number) =>
      (await call(`/api/subscribers/${id}`)).body.data.lists.map((l: any) =>
        Date.parse(l.subscription_updated_at),
      ) as number[];
    const consentBefore = await consentTimes(eve.id);
    await recorded({ email: eve.email, type: "hard", source: "api" });
    check(
      (await statuses(eve.id)).every((s) => s === "confirmed"),
      "below-threshold",
    );
    await recorded({ email: eve.email, type: "hard", source: "api" });
    check(
      (await statuses(eve.id)).every((s) => s === "unsubscribed"),
      "unsubscribe-action",
    );
    // Upstream's action changes only the status, so its time stays that of the subscription.
    // `subscription_updated_at` here says when consent changed.
    const consentAfter = await consentTimes(eve.id);
    if (reference)
      check(
        consentAfter.every((time, i) => time === consentBefore[i]),
        "unsubscribe-time-reference",
      );
    else
      check(
        consentAfter.every((time, i) => time > consentBefore[i]!),
        "unsubscribe-time-production",
      );
    check((await call(`/api/subscribers/${eve.id}`)).body.data.status === "enabled", "unsub-sub");
    await recorded({ email: eve.email, type: "hard", source: "api" });
    check((await bounces(eve.id)).length === 2, "over-threshold");

    // Blocklist leaves memberships alone, and a blocklisted subscriber's bounces add no row.
    const fay = await subscriber("fay", [listA]);
    await recorded({ email: fay.email, type: "complaint", source: "api" });
    const fayRow = (await call(`/api/subscribers/${fay.id}`)).body.data;
    check(fayRow.status === "blocklisted", "blocklist-action");
    check(fayRow.lists[0].subscription_status === "confirmed", "blocklist-keeps-lists");
    await recorded({ email: fay.email, type: "soft", source: "api" });
    check((await bounces(fay.id)).length === 1, "blocklisted-no-row");

    // A re-enabled subscriber over the count is acted on again, without a new row.
    const reenabled = await call(`/api/subscribers/${fay.id}`, "PUT", {
      email: fay.email,
      name: "fay",
      status: "enabled",
      lists: [listA],
    });
    check(reenabled.status === 200, "reenable");
    await recorded({ email: fay.email, type: "complaint", source: "api" });
    check(
      (await call(`/api/subscribers/${fay.id}`)).body.data.status === "blocklisted",
      "action-repeats",
    );
    check((await bounces(fay.id)).length === 1, "action-repeats-no-row");

    // Delete, also for a subscriber already blocklisted.
    await setting("bounce.actions", {
      soft: { count: 2, action: "none" },
      hard: { count: 1, action: "delete" },
      complaint: { count: 1, action: "blocklist" },
    });
    const gus = await subscriber("gus", [listA]);
    await recorded({ email: gus.email, type: "hard", source: "api" });
    check((await call(`/api/subscribers/${gus.id}`)).status === 400, "delete-action");
    await recorded({ email: fay.email, type: "hard", source: "api" });
    check((await call(`/api/subscribers/${fay.id}`)).status === 400, "delete-blocklisted");
    check((await bounces(gus.id)).length === 0, "delete-cascades");

    // A subscriber's bounces, with list-scoped visibility.
    await setting("bounce.actions", {
      soft: { count: 9, action: "none" },
      hard: { count: 9, action: "none" },
      complaint: { count: 9, action: "none" },
    });
    const scoped = await apiUser(
      "bounce-scoped",
      ["bounces:get", "bounces:manage"],
      [{ id: listB, permissions: ["list:get"] }],
    );
    const managing = await apiUser(
      "bounce-scoped-manage",
      ["bounces:manage"],
      [{ id: listB, permissions: ["list:manage"] }],
    );
    const hal = await subscriber("hal", [listA]);
    const ivy = await subscriber("ivy", [listB]);
    const nol = await subscriber("nol");
    await recorded({ email: hal.email, type: "soft", source: "scope" });
    await recorded({ email: ivy.email, type: "soft", source: "scope" });
    const seen = async (id: number, headers = scoped) =>
      await call(`/api/subscribers/${id}/bounces`, "GET", undefined, headers);
    check((await seen(hal.id)).status === 403, "scope-other-list");
    check((await seen(nol.id)).status === 403, "scope-no-lists");
    const visible = await seen(ivy.id);
    check(visible.status === 200 && visible.body.data.length === 1, "scope-list");
    check(Array.isArray(visible.body.data), "subscriber-array");
    const absent = await seen(999999999);
    check(absent.status === 200 && absent.body.data.length === 0, "scope-absent");
    check((await call("/api/subscribers/x/bounces")).status === 400, "subscriber-bad-id");
    // Global reads stay unscoped upstream.
    check(
      (await call("/api/bounces?source=scope", "GET", undefined, scoped)).body.data.total === 2,
      "g",
    );
    const refused = await call(`/api/subscribers/${ivy.id}/bounces`, "DELETE", undefined, scoped);
    check(refused.status === 403, "scope-delete-get-only");
    check(
      (await call(`/api/subscribers/${hal.id}/bounces`, "DELETE", undefined, managing)).status ===
        403,
      "scope-delete-other",
    );
    const cleared = await call(`/api/subscribers/${ivy.id}/bounces`, "DELETE", undefined, managing);
    check(cleared.status === 200 && cleared.body.data === true, "subscriber-delete");
    check((await bounces(ivy.id)).length === 0, "subscriber-delete-rows");
    check((await bounces(hal.id)).length === 1, "subscriber-delete-other");

    // Delete by ID and by query.
    const jon = await subscriber("jon", [listA]);
    for (const source of ["d1", "d2", "d3", "d4", "d5"])
      await recorded({ email: jon.email, type: "soft", source, campaign_uuid: second.uuid });
    await recorded({ email: jon.email, type: "hard", source: "d5" });
    const ids = async (source: string) =>
      (await query(`source=${source}`)).results.map((b: any) => b.id as number);
    const [d1] = await ids("d1");
    const [d2] = await ids("d2");
    const [d3] = await ids("d3");
    check((await call(`/api/bounces/${d1}`, "DELETE")).body.data === true, "delete-one");
    check((await call(`/api/bounces/${d1}`, "DELETE")).status === 200, "delete-repeat");
    check((await call("/api/bounces/x", "DELETE")).status === 400, "delete-bad-id");
    check((await ids("d1")).length === 0, "delete-one-row");
    check((await call(`/api/bounces?id=${d2}&id=${d3}`, "DELETE")).status === 200, "delete-many");
    check((await ids("d2")).length + (await ids("d3")).length === 0, "delete-many-rows");
    for (const path of ["", "?id=x", "?id=0", "?all=false", "?all=nope", "?source=d4"])
      check((await call(`/api/bounces${path}`, "DELETE")).status === 400, `delete-refused${path}`);
    check((await call("/api/bounces?all=true&campaign_id=x", "DELETE")).status === 400, "camp-x");
    check((await ids("d4")).length === 1, "delete-refused-rows");
    // An ID wins over `all` and its filters, as upstream.
    const [d4] = await ids("d4");
    check((await call(`/api/bounces?all=true&id=${d4}&source=d5`, "DELETE")).status === 200, "ids");
    check((await ids("d4")).length === 0 && (await ids("d5")).length === 2, "ids-beat-all");
    check(
      (await call("/api/bounces?all=true&source=d5&type=hard", "DELETE")).status === 200,
      "delete-filter",
    );
    const left = await ids("d5");
    check(left.length === 1, "delete-filter-rows");
    check(
      (await call(`/api/bounces?all=true&campaign_id=${second.id}&source=d5`, "DELETE")).status ===
        200,
      "delete-campaign",
    );
    check((await ids("d5")).length === 0, "delete-campaign-rows");

    // Blocklist from bounces, by ID and by filter, which also ends memberships.
    const kim = await subscriber("kim", [listA]);
    const lee = await subscriber("lee", [listA]);
    const mae = await subscriber("mae", [listA]);
    await recorded({ email: kim.email, type: "soft", source: "b1" });
    await recorded({ email: lee.email, type: "soft", source: "b2", campaign_uuid: second.uuid });
    await recorded({ email: mae.email, type: "hard", source: "b2", campaign_uuid: second.uuid });
    const [kimBounce] = await ids("b1");
    check((await call("/api/bounces/blocklist?id=x", "PUT")).status === 400, "blocklist-bad-id");
    check((await call("/api/bounces/blocklist?campaign_id=0", "PUT")).status === 400, "bl-camp");
    const byID = await call(`/api/bounces/blocklist?id=${kimBounce}`, "PUT");
    check(byID.status === 200 && byID.body.data === true, "blocklist-id");
    const kimRow = (await call(`/api/subscribers/${kim.id}`)).body.data;
    check(kimRow.status === "blocklisted", "blocklist-id-status");
    check(kimRow.lists[0].subscription_status === "unsubscribed", "blocklist-id-lists");
    check((await call(`/api/subscribers/${lee.id}`)).body.data.status === "enabled", "bl-others");
    check(
      (await call(`/api/bounces/blocklist?campaign_id=${second.id}&source=b2&type=hard`, "PUT"))
        .status === 200,
      "blocklist-filter",
    );
    check((await call(`/api/subscribers/${mae.id}`)).body.data.status === "blocklisted", "bl-mae");
    check((await call(`/api/subscribers/${lee.id}`)).body.data.status === "enabled", "bl-lee");

    // Campaign counters read the same rows.
    const counted = await call(`/api/campaigns/${first.id}`);
    check(counted.body.data.bounces === 2, "campaign-count");

    if (!reference) await production();
  } finally {
    const failures: unknown[] = [];
    const attempt = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        failures.push(error);
      }
    };
    await attempt(() => call("/api/bounces?all=true", "DELETE"));
    for (const id of campaigns) await attempt(() => call(`/api/campaigns/${id}`, "DELETE"));
    for (const id of lists) await attempt(() => call(`/api/lists/${id}`, "DELETE"));
    for (const id of users) await attempt(() => call(`/api/users/${id}`, "DELETE"));
    for (const id of roles.reverse()) await attempt(() => call(`/api/roles/${id}`, "DELETE"));
    await attempt(() => setting("bounce.actions", originals["bounce.actions"]));
    await attempt(() => setting("bounce.enabled", originals["bounce.enabled"]));
    await attempt(() => setting("bounce.webhooks_enabled", originals["bounce.webhooks_enabled"]));
    if (failures.length) process.stderr.write("Bounce contract cleanup failed\n");
  }

  /** Native behavior, through the compiled executable's real HTTP, SQLite file and restart. */
  async function production() {
    const dataDir = target.dataDir!;
    const stored = <T>(sql: string, ...args: (string | number)[]) => {
      const reader = new Database(join(dataDir, "iglo-email.db"), { readonly: true });
      try {
        return reader.query(sql).all(...args) as T[];
      } finally {
        reader.close();
      }
    };
    const receiver = startReceiver();
    const sink = await startSink();
    try {
      const events = ["bounce.recorded", "subscriber.blocklisted", "subscriber.deleted"];
      const hook = await call("/api/webhooks", "POST", { url: receiver.url(), events });
      check(hook.status === 200, "hook");
      const secret = hook.body.data.secret as string;
      await setting("bounce.actions", {
        soft: { count: 2, action: "none" },
        hard: { count: 1, action: "blocklist" },
        complaint: { count: 1, action: "delete" },
      });

      // The key is a masked secret and survives a listmonk client's full replace.
      const settings = (await call("/api/settings")).body.data;
      check(settings["bounce.mailgun"].enabled === false, "mailgun-default");
      for (const key of [
        "bounce.azure",
        "bounce.postmark",
        "bounce.forwardemail",
        "bounce.lettermint",
      ])
        check(settings[key] && typeof settings[key].enabled === "boolean", `kept-${key}`);
      const mailgun = async (timestamp: number, token: string, data: unknown, key = signingKey) =>
        await call("/webhooks/bounce/mailgun", "POST", {
          signature: {
            timestamp: String(timestamp),
            token,
            signature: createHmac("sha256", key).update(`${timestamp}${token}`).digest("hex"),
          },
          "event-data": data,
        });
      const now = () => Math.floor(Date.now() / 1000);
      const token = () => crypto.randomUUID().replaceAll("-", "");
      const failed = (recipient: string, extra: object = {}) => ({
        id: crypto.randomUUID(),
        event: "failed",
        severity: "permanent",
        recipient,
        reason: "bounce",
        "delivery-status": {
          code: 550,
          message: `5.1.1 <${recipient}> user unknown`,
          description: "",
        },
        message: { headers: { "message-id": "x@y.test" } },
        ...extra,
      });
      const refused = await mailgun(now(), token(), failed("a@example.com"));
      check(refused.status === 400 && refused.body.message === "Unknown service.", "mailgun-off");
      check(
        (await call("/api/settings/bounce.mailgun", "PUT", { enabled: true, key: "" })).status ===
          400,
        "mailgun-key-required",
      );
      await setting("bounce.mailgun", { enabled: true, key: signingKey });
      const shown = (await call("/api/settings")).body.data;
      check(!JSON.stringify(shown).includes(signingKey), "mailgun-masked");
      check(shown["bounce.mailgun"].key === "•".repeat(signingKey.length), "mailgun-mask");
      const replaced = { ...shown };
      delete replaced["bounce.mailgun"];
      check((await call("/api/settings", "PUT", replaced)).status === 200, "full-put");
      await setting("bounce.mailgun", { enabled: true, key: shown["bounce.mailgun"].key });

      // Forged, stale and replayed requests change nothing.
      const victim = await subscriber("victim");
      const rows = () => stored<{ n: number }>("SELECT count(*) AS n FROM bounces")[0]!.n;
      const before = rows();
      const data = () => failed(victim.email);
      const forged = await mailgun(now(), token(), data(), "wrong-key");
      check(forged.status === 406, "mailgun-forged");
      const tampered = await call("/webhooks/bounce/mailgun", "POST", {
        signature: { timestamp: String(now()), token: token(), signature: "0".repeat(64) },
        "event-data": data(),
      });
      check(tampered.status === 406, "mailgun-zero-signature");
      check((await mailgun(now() - 3600, token(), data())).status === 406, "mailgun-stale");
      check((await mailgun(now() + 3600, token(), data())).status === 406, "mailgun-future");
      check((await call("/webhooks/bounce/mailgun", "POST", "{")).status === 406, "mailgun-json");
      check((await call("/webhooks/bounce/mailgun", "POST", {})).status === 406, "mailgun-empty");
      const big = await call("/webhooks/bounce/mailgun", "POST", "x".repeat(70_000));
      check(big.status === 413, "mailgun-body-limit");
      check(rows() === before, "mailgun-refused-rows");
      check(
        (await call(`/api/subscribers/${victim.id}`)).body.data.status === "enabled",
        "mailgun-refused-status",
      );

      // An accepted event, whose body is what the receiver then sees signed.
      const replay = { timestamp: now(), token: token() };
      const event = failed(victim.email);
      const accepted = await mailgun(replay.timestamp, replay.token, event);
      check(accepted.status === 200 && accepted.body.data === true, "mailgun-accepted");
      const [row] = await bounces(victim.id);
      check(row.type === "hard" && row.source === "mailgun", "mailgun-row");
      check(!JSON.stringify(row.meta).includes(victim.email), "mailgun-meta-address");
      check(row.meta.code === 550 && row.meta.severity === "permanent", "mailgun-meta");
      check(
        (await call(`/api/subscribers/${victim.id}`)).body.data.status === "blocklisted",
        "mailgun-action",
      );
      await receiver.waitFor(2);
      const seen = receiver.received.find((r) => r.body.event === "bounce.recorded")!;
      check(signatureValid(seen, secret), "webhook-signed");
      check(seen.body.data.subscriber.uuid === victim.uuid, "webhook-subscriber");
      check(seen.body.data.bounce.type === "hard", "webhook-type");
      check(seen.body.data.bounce.source === "mailgun", "webhook-source");
      check(!seen.text.includes("user unknown"), "webhook-no-meta");
      check(
        receiver.received.some((r) => r.body.event === "subscriber.blocklisted"),
        "webhook-blocklisted",
      );

      // A replay is refused, across a restart too, and the event's ID stops a re-signed copy.
      await call(`/api/subscribers/${victim.id}`, "PUT", {
        email: victim.email,
        name: "victim",
        status: "enabled",
        lists: [],
      });
      await target.restart!();
      check(
        (await mailgun(replay.timestamp, replay.token, event)).status === 406,
        "mailgun-replayed",
      );
      const copy = await mailgun(now(), token(), event);
      check(copy.status === 200, "mailgun-copy");
      check((await bounces(victim.id)).length === 1, "mailgun-no-double-count");
      check(
        (await call(`/api/subscribers/${victim.id}`)).body.data.status === "enabled",
        "mailgun-copy-no-action",
      );

      // Severities and complaints; events that are not bounces are acknowledged.
      const zoe = await subscriber("zoe");
      const temporary = failed(zoe.email, { severity: "temporary" });
      check((await mailgun(now(), token(), temporary)).status === 200, "mailgun-temporary");
      check((await bounces(zoe.id))[0].type === "soft", "mailgun-soft");
      const delivered = { id: crypto.randomUUID(), event: "delivered", recipient: zoe.email };
      check((await mailgun(now(), token(), delivered)).status === 200, "mailgun-delivered");
      check((await bounces(zoe.id)).length === 1, "mailgun-delivered-ignored");
      const stranger = failed(address("stranger"));
      check((await mailgun(now(), token(), stranger)).status === 200, "mailgun-unknown");

      // Complaint's `delete` is the administrative path: the bounce delivery is cleared.
      const complained = {
        id: crypto.randomUUID(),
        event: "complained",
        recipient: zoe.email,
        message: { headers: { "message-id": "x@y.test" } },
      };
      const queued = receiver.received.length;
      check((await mailgun(now(), token(), complained)).status === 200, "mailgun-complained");
      check((await call(`/api/subscribers/${zoe.id}`)).status === 400, "mailgun-delete-action");
      await receiver.waitFor(queued + 2);
      const payloads = stored<{ payload: string }>(
        "SELECT payload FROM webhook_deliveries WHERE event = 'bounce.recorded'",
      );
      check(!payloads.some((p) => p.payload.includes(zoe.email)), "webhook-cleared");

      // A transactional send to an address with no subscriber, and to a subscriber.
      const smtp = (await call("/api/settings")).body.data.smtp;
      check(
        (
          await call("/api/settings/smtp", "PUT", [
            {
              ...smtp[0],
              enabled: true,
              host: "127.0.0.1",
              port: sink.port,
              auth_protocol: "none",
              tls_type: "none",
              password: "",
            },
          ])
        ).status === 200,
        "smtp",
      );
      const template = await call("/api/templates", "POST", {
        name: `bounce-${suffix}`,
        type: "tx",
        subject: "Tx",
        body: "Body",
      });
      check(template.status === 200, "template");
      const sendTo = async (recipient: Record<string, unknown>) => {
        const sent = await call("/api/tx", "POST", {
          ...recipient,
          template_id: template.body.data.id,
        });
        check(sent.status === 200, "tx");
        const send = (await call("/api/sends?per_page=1")).body.data.results[0];
        return send as { id: number; uuid: string; smtp_message_id: string };
      };
      const outsider = address("outsider");
      const send = await sendTo({ subscriber_emails: [outsider], subscriber_mode: "external" });
      const bare = send.smtp_message_id.replace(/[<>]/g, "");
      const onSend = failed(outsider, { message: { headers: { "message-id": bare } } });
      check((await mailgun(now(), token(), onSend)).status === 200, "mailgun-send");
      const [linked] = stored<{ subscriber_id: number | null; send_id: number; meta: string }>(
        "SELECT subscriber_id, send_id, meta FROM bounces WHERE send_id = ?",
        send.id,
      );
      check(linked && linked.subscriber_id === null, "send-no-subscriber");
      const listed = (await call("/api/bounces?source=mailgun&per_page=all")).body.data.results;
      const outsiderRow = listed.find((b: any) => b.send_id === send.id);
      check(outsiderRow.email === outsider && !("subscriber_id" in outsiderRow), "send-listed");
      await receiver.waitFor(queued + 3);
      const anonymous = receiver.received.at(-1)!.body;
      check(anonymous.event === "bounce.recorded", "send-webhook");
      check(anonymous.data.subscriber === null, "send-webhook-subscriber");
      check(anonymous.data.send.uuid === send.uuid, "send-webhook-send");
      check(!JSON.stringify(anonymous).includes(outsider), "send-webhook-address");

      // That address later subscribes and wipes: the unlinked bounce goes with its sends.
      const wiper = await subscriber("outsider");
      check(wiper.email === outsider, "wiper");
      check(
        (await call("/api/settings/privacy.allow_wipe", "PUT", true)).status === 200,
        "allow-wipe",
      );
      const wipe = await fetch(`${target.baseUrl}/subscription/wipe/${wiper.uuid}`, {
        method: "POST",
      });
      check(wipe.status === 200, "wipe");
      check(
        stored("SELECT 1 FROM bounces WHERE send_id = ?", send.id).length === 0,
        "wipe-unlinked-bounce",
      );

      // A bounce arriving after the wipe finds an anonymized send and stores nothing.
      const late = failed(outsider, { message: { headers: { "message-id": bare } } });
      check((await mailgun(now(), token(), late)).status === 200, "mailgun-late");
      check(
        stored("SELECT 1 FROM bounces WHERE send_id = ?", send.id).length === 0,
        "late-bounce-dropped",
      );

      // A campaign's Message-ID carries both UUIDs.
      const listID = await list("mailgun");
      const camp = await campaign("mailgun", listID);
      const una = await subscriber("una", [listID]);
      const carried = { message: { headers: { "message-id": `${camp.uuid}.${una.uuid}@x.test` } } };
      const campaignEvent = failed(una.email, { severity: "temporary", ...carried });
      check((await mailgun(now(), token(), campaignEvent)).status === 200, "mailgun-campaign");
      const [campaignRow] = await bounces(una.id);
      check(campaignRow.campaign.id === camp.id, "mailgun-campaign-row");

      // A copy of that message has the same Message-ID: the campaign keeps the row, nobody acts.
      const copied = failed(address("copy"), carried);
      check((await mailgun(now(), token(), copied)).status === 200, "mailgun-campaign-copy");
      const [copyRow] = stored<{ subscriber_id: number | null; campaign_id: number; meta: string }>(
        "SELECT subscriber_id, campaign_id, meta FROM bounces WHERE meta ->> '$.event_id' = ?",
        copied.id,
      );
      check(copyRow?.subscriber_id === null, "mailgun-campaign-copy-subscriber");
      check(copyRow?.campaign_id === camp.id, "mailgun-campaign-copy-link");
      check(!copyRow?.meta.includes("user unknown"), "mailgun-campaign-copy-text");
      check((await bounces(una.id)).length === 1, "mailgun-campaign-copy-count");
      check(
        (await call(`/api/subscribers/${una.id}`)).body.data.status === "enabled",
        "mailgun-campaign-copy-action",
      );

      // The subscriber's own export carries their bounces with the activity beside them.
      check((await call("/api/settings/privacy.allow_export", "PUT", true)).status === 200, "ex");
      const mailCount = sink.messages.length;
      const exported = await fetch(`${target.baseUrl}/subscription/export/${una.uuid}`, {
        method: "POST",
      });
      check(exported.status === 200, "export");
      for (const deadline = Date.now() + 10_000; sink.messages.length === mailCount;) {
        check(Date.now() < deadline, "export-mail");
        await Bun.sleep(10);
      }
      const attachment = /filename="?data\.json"?[\s\S]*?\r?\n\r?\n([\s\S]*?)\r?\n--/.exec(
        sink.messages.at(-1)!.data,
      );
      const report = JSON.parse(Buffer.from(attachment![1]!, "base64").toString("utf8"));
      check(report.bounces.length === 1, "export-bounces");
      check(
        report.bounces[0].type === "soft" && report.bounces[0].source === "mailgun",
        "export-row",
      );
      check(report.bounces[0].meta.severity === "temporary", "export-meta");
      check(report.bounces[0].campaign === "Bounce subject", "export-campaign");

      // Native webhook callers can name a send.
      const vic = await subscriber("vic");
      const linkedSend = await sendTo({ subscriber_email: vic.email });
      await recorded({ send_uuid: linkedSend.uuid, type: "soft", source: "api" });
      const [vicRow] = await bounces(vic.id);
      check(vicRow?.send_id === linkedSend.id, "native-send-uuid");

      // A provider disabled by its own switch, then by the master switch, refuses everything.
      await setting("bounce.mailgun", { enabled: false, key: "" });
      check((await mailgun(now(), token(), data())).status === 400, "mailgun-disabled");
      await setting("bounce.mailgun", { enabled: true, key: signingKey });
      await setting("bounce.enabled", false);
      check((await mailgun(now(), token(), data())).status === 503, "mailgun-bounce-off");
      await setting("bounce.webhooks_enabled", false);
      check((await mailgun(now(), token(), data())).status === 404, "mailgun-webhooks-off");
      check(rows() >= before, "rows");
      await setting("bounce.mailgun", { enabled: false, key: "" });
      await call(`/api/webhooks/${hook.body.data.id}`, "DELETE");
      await call(`/api/templates/${template.body.data.id}`, "DELETE");
    } finally {
      receiver.close();
      await sink.close();
    }
  }
}

if (import.meta.main) {
  try {
    if (process.argv[2] !== "reference") throw new Error("Invalid mode");
    const {
      REFERENCE_URL: baseUrl,
      REFERENCE_API_USER: user,
      REFERENCE_API_TOKEN: token,
    } = process.env;
    if (!baseUrl || !user || !token) throw new Error("Missing reference credentials");
    await runBouncesContract({ mode: "reference", baseUrl, credentials: { user, token } });
    process.stdout.write("PASS bounces reference contract\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-/?=&]+$/.test(error.message) ? error.message : `Bounces contract failed: ${error}`}\n`,
    );
    process.exitCode = 1;
  }
}
