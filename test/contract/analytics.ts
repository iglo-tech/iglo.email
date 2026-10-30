// Reference: listmonk cmd/campaign_analytics.go, cmd/dashboard.go, cmd/admin.go,
// internal/core/analytics.go, queries/campaigns.sql, queries/lists.sql and the
// mat_dashboard_* views in schema.sql at 6fcd95f. Shared results run against both the pinned
// reference and the compiled executable. Rows are made through the real pixel and redirect
// routes, so they all fall in the current period; bucket boundaries are covered with an
// injected clock in test/analytics. GET /api/sends/analytics is native and production-only.
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Credentials, Mode } from "@/test/contract/types";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";

interface CountRow {
  list_id?: number;
  campaign_id: number;
  count: number;
  timestamp: string;
}
const dummy = "00000000-0000-0000-0000-000000000000";
const wide = "from=2000-01-01&to=2099-01-01";

/** UTC DATE_TRUNC: the reference database and SQLite both run analytics in UTC. */
function truncated(at: Date, interval: string): string {
  const y = at.getUTCFullYear(),
    m = at.getUTCMonth(),
    d = at.getUTCDate();
  const value =
    interval === "hour"
      ? Date.UTC(y, m, d, at.getUTCHours())
      : interval === "day"
        ? Date.UTC(y, m, d)
        : interval === "week"
          ? Date.UTC(y, m, d - ((at.getUTCDay() + 6) % 7))
          : Date.UTC(y, m, 1);
  return new Date(value).toISOString().replace(".000Z", "Z");
}

export async function runAnalyticsContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
  dataDir?: string;
  restart?: () => Promise<void>;
}) {
  const reference = target.mode === "reference";
  const sink = referenceMailpit(process.env);
  await assertOwnedMailpit(sink);
  const marker = `m08${randomBytes(10).toString("hex")}`;
  const mailpit = new Mailpit(sink, marker);
  const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL analytics-${label}`);
  };
  const call = async (path: string, method = "GET", body?: unknown, auth = authorization) => {
    const response = await fetch(`${target.baseUrl}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(auth ? { authorization: auth } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let parsed: any = text;
    if (response.headers.get("content-type")?.startsWith("application/json"))
      parsed = JSON.parse(text);
    return { status: response.status, body: parsed };
  };
  /** The reference restarts itself on a settings change; production applies it live. */
  const setting = async (key: string, value: unknown) => {
    check((await call(`/api/settings/${key}`, "PUT", value)).status === 200, `setting-${key}`);
    if (!reference) return;
    await Bun.sleep(1500);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const up = await fetch(`${target.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      }).catch(() => null);
      if (up?.ok) return;
      check(Date.now() < deadline, "restart-wait");
      await Bun.sleep(100);
    }
  };
  const received = async (subject: string) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = (await mailpit.list()).filter((m) => m.Subject === subject);
      if (found.length || Date.now() > deadline) return found;
      await Bun.sleep(25);
    }
  };
  const counts = async () => (await call("/api/dashboard/counts")).body.data;
  const charts = async () => (await call("/api/dashboard/charts")).body.data;
  const analytics = async (
    resource: string,
    type: string,
    ids: number[],
    query = "",
    auth = authorization,
  ) => {
    const idQuery = ids.map((id) => `id=${id}`).join("&");
    return call(
      `/api/${resource}/analytics/${type}?${idQuery}&${wide}${query}`,
      "GET",
      undefined,
      auth,
    );
  };
  /** Rows reduced to id → count, whichever period each row fell in. */
  const summed = (response: { status: number; body: any }, key: "campaign_id" | "list_id") => {
    check(response.status === 200, `summed-status-${response.status}`);
    const out: Record<number, number> = {};
    for (const row of response.body.data as CountRow[])
      out[row[key]!] = (out[row[key]!] ?? 0) + row.count;
    return out;
  };
  const same = (actual: unknown, expected: unknown, label: string) =>
    check(JSON.stringify(actual) === JSON.stringify(expected), label);

  const owned = {
    campaigns: [] as number[],
    templates: [] as number[],
    subscribers: [] as number[],
    lists: [] as number[],
    users: [] as number[],
    roles: [] as number[],
  };
  try {
    // Fresh instance, before anything here exists. Absent aggregates stay JSON null.
    const fresh = await counts();
    same(Object.keys(fresh), ["subscribers", "lists", "campaigns", "messages"], "counts-keys");
    same(
      Object.keys(fresh.subscribers),
      ["total", "blocklisted", "orphans"],
      "counts-subscriber-keys",
    );
    same(
      Object.keys(fresh.lists),
      ["total", "private", "public", "optin_single", "optin_double"],
      "counts-list-keys",
    );
    same(Object.keys(fresh.campaigns), ["total", "by_status"], "counts-campaign-keys");
    check(fresh.subscribers.blocklisted === null, "counts-no-blocklisted");
    same(Object.keys(await charts()), ["link_clicks", "campaign_views"], "charts-keys");

    if (reference) {
      await setting("bounce.enabled", true);
      await setting("bounce.webhooks_enabled", true);
    }
    const settings = (await call("/api/settings")).body.data;
    const rootUrl = (settings["app.root_url"] as string).replace(/\/+$/, "");
    if (!reference) {
      const smtp = [
        {
          ...settings.smtp[0],
          enabled: true,
          host: sink.host,
          port: sink.port,
          auth_protocol: "none",
          username: "",
          password: "",
          tls_type: "none",
          email_headers: [],
        },
      ];
      check((await call("/api/settings/smtp", "PUT", smtp)).status === 200, "smtp-settings");
    }
    const templates = (await call("/api/templates?no_body=true")).body.data as any[];
    const defaultTemplate = templates.find((t) => t.is_default).id as number;

    const list = async (name: string, type: string, optin: string) => {
      const response = await call("/api/lists", "POST", { name: `${marker} ${name}`, type, optin });
      check(response.status === 200, "list-create");
      owned.lists.push(response.body.data.id);
      return response.body.data.id as number;
    };
    const subscriber = async (name: string, lists: number[]) => {
      const response = await call("/api/subscribers", "POST", {
        email: `${name}-${marker}@example.test`,
        name,
        status: "enabled",
        lists,
      });
      check(response.status === 200, "subscriber-create");
      owned.subscribers.push(response.body.data.id);
      return response.body.data as { id: number; uuid: string; email: string };
    };
    const campaign = async (name: string, lists: number[]) => {
      const response = await call("/api/campaigns", "POST", {
        name: `${marker} ${name}`,
        subject: "s",
        lists,
        content_type: "richtext",
        body: "<p>b</p>",
      });
      check(response.status === 200, "campaign-create");
      owned.campaigns.push(response.body.data.id);
      return response.body.data as { id: number; uuid: string; name: string };
    };

    const news = await list("news", "public", "single");
    const other = await list("other", "private", "double");
    const hidden = await list("hidden", "private", "single");
    const ada = await subscriber("ada", [news, other]);
    const bob = await subscriber("bob", [news]);
    const orphan = await subscriber("orphan", []);
    const camp1 = await campaign("one", [news]);
    const camp2 = await campaign("two", [news, other]);
    const camp3 = await campaign("three", [hidden]);

    const before = await counts();
    check(before.subscribers.total === fresh.subscribers.total + 3, "counts-subscribers");
    check(before.subscribers.orphans === fresh.subscribers.orphans + 1, "counts-orphans");
    check(before.lists.total === fresh.lists.total + 3, "counts-lists");
    check(before.lists.private === fresh.lists.private + 2, "counts-private");
    check(before.lists.public === fresh.lists.public + 1, "counts-public");
    check(before.lists.optin_single === fresh.lists.optin_single + 2, "counts-single");
    check(before.lists.optin_double === fresh.lists.optin_double + 1, "counts-double");
    check(before.campaigns.total === fresh.campaigns.total + 3, "counts-campaigns");
    check(
      before.campaigns.by_status.draft === (fresh.campaigns.by_status?.draft ?? 0) + 3,
      "counts-by-status",
    );
    check(
      (await call(`/api/subscribers/${bob.id}/blocklist`, "PUT")).status === 200,
      "blocklist-bob",
    );
    check((await counts()).subscribers.blocklisted === 1, "counts-blocklisted");

    // Register two tracked links for a campaign through a real test send.
    const linksOf = async (camp: { id: number; name: string }) => {
      const subject = `${marker} links ${camp.id}`;
      const track = (url: string) =>
        reference ? `{{ TrackLink "${url}" }}` : `{{ "${url}" | track_link }}`;
      const sent = await call(`/api/campaigns/${camp.id}/test`, "POST", {
        name: camp.name,
        subject,
        lists: [news],
        messenger: "email",
        content_type: "richtext",
        template_id: defaultTemplate,
        body: `<a href="${track("https://example.test/a")}">a</a><a href="${track("https://example.test/b")}">b</a>`,
        subscribers: [ada.email],
      });
      check(sent.status === 200, "test-send");
      const [mail] = await received(subject);
      check(mail, "test-received");
      const found = [
        ...(await mailpit.message(mail!.ID)).HTML.matchAll(/\/link\/([0-9a-f-]{36})\//g),
      ].map((m) => m[1]!);
      check(found.length === 2, "test-links");
      return { a: found[0]!, b: found[1]! };
    };
    const view = async (uuid: string, subscriberUuid = dummy) => {
      const pixel = await fetch(`${rootUrl}/campaign/${uuid}/${subscriberUuid}/px.png`);
      check(pixel.status === 200, "view");
    };
    const click = async (link: string, uuid: string, subscriberUuid = dummy) => {
      const followed = await fetch(`${rootUrl}/link/${link}/${uuid}/${subscriberUuid}`, {
        redirect: "manual",
      });
      check(followed.status === 307 || followed.status === 302, `click-${followed.status}`);
    };
    const links1 = await linksOf(camp1);
    const links2 = await linksOf(camp2);

    // Unattributed rows, the default: individual tracking is off.
    const startedAt = new Date();
    for (let i = 0; i < 3; i++) await view(camp1.uuid, ada.uuid);
    for (let i = 0; i < 2; i++) await view(camp2.uuid, ada.uuid);
    await click(links1.a, camp1.uuid, ada.uuid);
    await click(links1.a, camp1.uuid, ada.uuid);
    await click(links1.b, camp1.uuid, ada.uuid);
    await click(links2.a, camp2.uuid, ada.uuid);

    const ids = [camp1.id, camp2.id];
    same(
      summed(await analytics("campaigns", "views", ids), "campaign_id"),
      { [camp1.id]: 3, [camp2.id]: 2 },
      "views-total",
    );
    // `unique` needs individual tracking, otherwise totals come back.
    same(
      summed(await analytics("campaigns", "views", ids, "&unique=true"), "campaign_id"),
      { [camp1.id]: 3, [camp2.id]: 2 },
      "views-unique-ignored",
    );
    same(
      summed(await analytics("campaigns", "clicks", ids), "campaign_id"),
      { [camp1.id]: 3, [camp2.id]: 1 },
      "clicks-total",
    );
    same(
      summed(await analytics("campaigns", "total_views", ids), "campaign_id"),
      { [camp1.id]: 3, [camp2.id]: 2 },
      "total-views",
    );
    const linkRows = (await analytics("campaigns", "links", ids)).body.data as object[];
    same(
      linkRows,
      [
        { url: "https://example.test/a", count: 3 },
        { url: "https://example.test/b", count: 1 },
      ],
      "links-total",
    );
    same(
      (await analytics("lists", "links", [other])).body.data,
      [{ url: "https://example.test/a", count: 1 }],
      "list-links",
    );
    same(
      summed(await analytics("lists", "views", [news, other]), "list_id"),
      { [news]: 5, [other]: 2 },
      "list-views",
    );
    same(
      summed(await analytics("lists", "clicks", [news, other]), "list_id"),
      { [news]: 4, [other]: 1 },
      "list-clicks",
    );

    // Row shapes and every interval.
    const finishedAt = new Date();
    for (const interval of ["hour", "day", "week", "month"]) {
      const allowed = [truncated(startedAt, interval), truncated(finishedAt, interval)];
      const rows = (await analytics("campaigns", "views", ids, `&interval=${interval}`)).body
        .data as CountRow[];
      check(rows.length >= 2, `interval-${interval}-rows`);
      for (const row of rows) {
        same(Object.keys(row).sort(), ["campaign_id", "count", "timestamp"], "campaign-row-keys");
        check(allowed.includes(row.timestamp), `interval-${interval}-${row.timestamp}`);
      }
      const listRows = (await analytics("lists", "views", [news], `&interval=${interval}`)).body
        .data as CountRow[];
      for (const row of listRows) {
        same(
          Object.keys(row).sort(),
          ["campaign_id", "count", "list_id", "timestamp"],
          "list-row-keys",
        );
        check(row.campaign_id === 0 && row.list_id === news, "list-row-values");
        check(allowed.includes(row.timestamp), `list-interval-${interval}`);
      }
    }
    const defaulted = (await analytics("campaigns", "views", ids)).body.data as CountRow[];
    check(
      defaulted.every((row) => row.timestamp === truncated(finishedAt, "day")),
      "interval-default-day",
    );

    // Date bounds, in the forms API clients send. Each bound must be 10 to 30 bytes.
    const dated = (type: string, from: string, to: string, extra = "") =>
      call(
        `/api/campaigns/analytics/${type}?id=${camp1.id}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${extra}`,
      );
    const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    const hour = 3_600_000;
    for (const [from, to] of [
      ["2000-01-01", "2099-01-01"],
      ["2000-01-01 00:00:00", "2099-01-01 23:59:59"],
      ["2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z"],
      ["2000-01-01T00:00:00+02:00", "2099-01-01T00:00:00-02:00"],
      ["2000-01-01T00:00", "2099-01-01T23:59"],
      [iso(-hour), iso(hour)],
    ] as const)
      same(
        summed(await dated("views", from, to), "campaign_id"),
        { [camp1.id]: 3 },
        `dates-${from}`,
      );
    same((await dated("views", iso(hour), iso(2 * hour))).body, { data: [] }, "dates-after");
    same((await dated("views", iso(hour), iso(-hour))).body, { data: [] }, "dates-reversed");
    same((await dated("links", iso(hour), iso(2 * hour))).body, { data: [] }, "links-empty");

    // Input errors, in upstream's order.
    const error = async (path: string, status: number, label: string) => {
      const response = await call(path);
      check(response.status === status, `${label}-status-${response.status}`);
      return response.body?.message as string;
    };
    const invalidDates = "Invalid `from` or `to` dates.";
    check(
      (await error(`/api/campaigns/analytics/views?${wide}`, 400, "no-id")).includes("`id`"),
      "no-id-message",
    );
    await error(`/api/campaigns/analytics/views?id=abc&${wide}`, 400, "bad-id");
    await error(`/api/campaigns/analytics/views?id=0&${wide}`, 400, "zero-id");
    await error(`/api/lists/analytics/views?id=-1&${wide}`, 400, "negative-id");
    check(
      (await error(
        `/api/campaigns/analytics/views?id=${camp1.id}&from=2000&to=2099-01-01`,
        400,
        "short-from",
      )) === invalidDates,
      "short-from-message",
    );
    check(
      (await error(
        `/api/campaigns/analytics/links?id=${camp1.id}&from=2000-01-01`,
        400,
        "missing-to",
      )) === invalidDates,
      "missing-to-message",
    );
    await error(
      `/api/campaigns/analytics/views?id=${camp1.id}&from=2000-01-01&to=${"9".repeat(31)}`,
      400,
      "long-to",
    );
    await error(`/api/campaigns/analytics/nope?id=${camp1.id}&${wide}`, 400, "bad-type");
    await error(`/api/campaigns/analytics/subscriptions?id=${camp1.id}&${wide}`, 400, "list-type");
    await error(`/api/lists/analytics/nope?id=${news}&${wide}`, 400, "bad-list-type");
    await error(
      `/api/campaigns/analytics/views?id=${camp1.id}&${wide}&interval=year`,
      400,
      "bad-interval",
    );
    // Links take no interval, so a bad one is not looked at.
    await error(
      `/api/campaigns/analytics/links?id=${camp1.id}&${wide}&interval=year`,
      200,
      "links-interval",
    );

    // Bounce rows: M3.4 records them in production, so its fixture rows go straight to the table.
    const bounce = async (
      camp: { id: number; uuid: string },
      sub: { id: number; uuid: string },
    ) => {
      if (reference) {
        const posted = await call("/webhooks/bounce", "POST", {
          subscriber_uuid: sub.uuid,
          campaign_uuid: camp.uuid,
          type: "soft",
          source: "api",
        });
        check(posted.status === 200, `bounce-${posted.status}`);
        return;
      }
      const db = new Database(join(target.dataDir!, "iglo-email.db"));
      try {
        db.run("PRAGMA busy_timeout = 5000");
        db.run(
          "INSERT INTO bounces (subscriber_id, campaign_id, type, source) VALUES (?, ?, ?, ?)",
          [sub.id, camp.id, "soft", "api"],
        );
      } finally {
        db.close();
      }
    };
    await bounce(camp1, ada);
    await bounce(camp1, ada);
    await bounce(camp2, orphan);
    const deadline = Date.now() + 10_000;
    while (
      summed(await analytics("campaigns", "bounces", ids), "campaign_id")[camp2.id] !== 1 &&
      Date.now() < deadline
    )
      await Bun.sleep(50);
    same(
      summed(await analytics("campaigns", "bounces", ids), "campaign_id"),
      { [camp1.id]: 2, [camp2.id]: 1 },
      "bounces",
    );
    same(
      summed(await analytics("lists", "bounces", [news, other]), "list_id"),
      { [news]: 3, [other]: 1 },
      "list-bounces",
    );

    // Memberships: subscriptions by created_at, unsubscriptions by the last update.
    same(
      summed(await analytics("lists", "subscriptions", [news, other]), "list_id"),
      { [news]: 2, [other]: 1 },
      "subscriptions",
    );
    // Blocklisting bob unsubscribed bob from every list.
    same(
      summed(await analytics("lists", "unsubscriptions", [news]), "list_id"),
      { [news]: 1 },
      "unsubscriptions-blocklist",
    );
    same(
      (await analytics("lists", "unsubscriptions", [other])).body,
      { data: [] },
      "unsubscriptions-none",
    );
    check(
      (
        await call("/api/subscribers/lists", "PUT", {
          ids: [ada.id],
          action: "unsubscribe",
          target_list_ids: [other],
        })
      ).status === 200,
      "unsubscribe",
    );
    const left = (await analytics("lists", "unsubscriptions", [other])).body.data as CountRow[];
    same(
      left.map((row) => [row.list_id, row.campaign_id, row.count]),
      [[other, 0, 1]],
      "unsubscriptions",
    );

    // Campaign metrics, list metrics and the dashboard under narrower permissions.
    const apiUser = async (name: string, permissions: string[], lists: object[]) => {
      const role = await call("/api/roles/users", "POST", {
        name: `${marker}-${name}`,
        permissions,
      });
      check(role.status === 200, "role-create");
      owned.roles.push(role.body.data.id);
      let listRole: number | undefined;
      if (lists.length) {
        const created = await call("/api/roles/lists", "POST", {
          name: `${marker}-${name}-lists`,
          lists,
        });
        check(created.status === 200, "list-role-create");
        listRole = created.body.data.id;
        owned.roles.push(listRole!);
      }
      const user = await call("/api/users", "POST", {
        username: `${marker}-${name}`,
        type: "api",
        status: "enabled",
        user_role_id: role.body.data.id,
        ...(listRole ? { list_role_id: listRole } : {}),
      });
      check(user.status === 200, "user-create");
      owned.users.push(user.body.data.id);
      return `Basic ${btoa(`${marker}-${name}:${user.body.data.password}`)}`;
    };
    const newsGet = [{ id: news, permissions: ["list:get"] }];
    const analyst = await apiUser("analyst", ["campaigns:get_analytics"], newsGet);
    const noMetrics = await apiUser("no-metrics", ["campaigns:get_all"], newsGet);
    const listsOnly = await apiUser("lists-only", ["campaigns:get", "subscribers:get"], newsGet);
    const scoped = await apiUser("scoped", ["campaigns:get", "campaigns:get_analytics"], newsGet);
    const nobody = await apiUser("nobody", ["templates:get"], []);
    const allowed = async (
      resource: string,
      type: string,
      id: number[],
      auth: string,
      status: number,
      label: string,
    ) => check((await analytics(resource, type, id, "", auth)).status === status, `perm-${label}`);
    check((await analytics("campaigns", "views", [camp1.id], "", "")).status === 403, "anon");
    check((await analytics("lists", "views", [news], "", "")).status === 403, "anon-list");
    check(
      (await call("/api/dashboard/counts", "GET", undefined, "")).status === 403,
      "anon-counts",
    );
    check(
      (await call("/api/dashboard/charts", "GET", undefined, "")).status === 403,
      "anon-charts",
    );
    check(
      (await call("/api/dashboard/campaigns", "GET", undefined, "")).status === 403,
      "anon-campaigns",
    );
    await allowed("campaigns", "views", [camp1.id], noMetrics, 403, "no-analytics");
    await allowed("campaigns", "views", [camp1.id], analyst, 200, "analyst-own");
    await allowed("campaigns", "links", [camp1.id], analyst, 200, "analyst-links");
    await allowed("campaigns", "views", [camp3.id], analyst, 403, "analyst-other");
    await allowed("campaigns", "views", [camp1.id, camp3.id], analyst, 403, "analyst-mixed");
    await allowed("lists", "subscriptions", [news], listsOnly, 200, "list-subscriptions");
    await allowed("lists", "unsubscriptions", [news], analyst, 200, "list-unsubscriptions");
    await allowed("lists", "subscriptions", [hidden], listsOnly, 403, "list-other");
    await allowed("lists", "subscriptions", [news, hidden], listsOnly, 403, "list-mixed");
    await allowed("lists", "views", [news], listsOnly, 403, "list-no-analytics");
    await allowed("lists", "links", [news], analyst, 403, "list-no-campaign-get");
    await allowed("lists", "views", [news], scoped, 200, "list-views");
    await allowed("lists", "links", [news], scoped, 200, "list-links");

    // Dashboard campaigns: scheduled first, then the newest of the others, six at most.
    for (let i = 0; i < 6; i++) {
      await campaign(`filler ${i}`, [hidden]);
      await Bun.sleep(5);
    }
    const planned = await campaign("planned", [news]);
    const sendAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const put = await call(`/api/campaigns/${planned.id}`, "PUT", {
      name: planned.name,
      subject: "s",
      lists: [news],
      content_type: "richtext",
      body: "<p>b</p>",
      messenger: "email",
      send_at: sendAt,
    });
    check(put.status === 200, "planned-update");
    const scheduled = await call(`/api/campaigns/${planned.id}/status`, "PUT", {
      status: "scheduled",
    });
    check(scheduled.status === 200, "planned-schedule");

    const board = await call("/api/dashboard/campaigns");
    check(board.status === 200 && board.body.data.length === 6, "board-size");
    const rows = board.body.data as any[];
    check(rows[0].id === planned.id && rows[0].status === "scheduled", "board-scheduled-first");
    const listed = (await call("/api/campaigns?no_body=true&per_page=7&order_by=created_at")).body
      .data.results as any[];
    same(
      rows.slice(1).map((row) => row.id),
      listed
        .filter((row) => row.id !== planned.id)
        .slice(0, 5)
        .map((row) => row.id),
      "board-newest",
    );
    same(
      rows[1],
      listed.find((row) => row.id === rows[1].id),
      "board-row",
    );
    check(
      rows.every((row) => row.body === "" && row.body_source === null),
      "board-no-bodies",
    );
    const narrowed = (await call("/api/dashboard/campaigns", "GET", undefined, scoped)).body
      .data as any[];
    check(
      narrowed.length && narrowed.every((row) => [camp1.id, camp2.id, planned.id].includes(row.id)),
      "board-scoped",
    );
    const none = await call("/api/dashboard/campaigns", "GET", undefined, nobody);
    check(none.status === 200 && none.body.data === null, "board-none");
    check((await call("/api/dashboard/counts", "GET", undefined, nobody)).status === 200, "open");

    // Charts count by date and include the current day.
    const today = finishedAt.toISOString().slice(0, 10);
    const chartData = await charts();
    same(chartData.campaign_views, [{ count: 5, date: today }], "charts-views");
    same(chartData.link_clicks, [{ count: 4, date: today }], "charts-clicks");

    // Individual tracking on: rows name subscribers, and unique counts become available.
    await setting("privacy.individual_tracking", true);
    for (let i = 0; i < 2; i++) await view(camp1.uuid, ada.uuid);
    await view(camp1.uuid, bob.uuid);
    await view(camp2.uuid, ada.uuid);
    await click(links1.a, camp1.uuid, ada.uuid);
    await click(links1.a, camp1.uuid, ada.uuid);
    await click(links1.b, camp1.uuid, bob.uuid);
    same(
      summed(await analytics("campaigns", "views", ids), "campaign_id"),
      { [camp1.id]: 6, [camp2.id]: 3 },
      "tracked-views-total",
    );
    // Unattributed rows collapse into one unknown subscriber per campaign.
    same(
      summed(await analytics("campaigns", "views", ids, "&unique=true"), "campaign_id"),
      { [camp1.id]: 3, [camp2.id]: 2 },
      "tracked-views-unique",
    );
    same(
      summed(await analytics("campaigns", "clicks", ids, "&unique=true"), "campaign_id"),
      { [camp1.id]: 3, [camp2.id]: 1 },
      "tracked-clicks-unique",
    );
    same(
      summed(await analytics("campaigns", "total_views", ids, "&unique=true"), "campaign_id"),
      { [camp1.id]: 6, [camp2.id]: 3 },
      "tracked-total-type",
    );
    same(
      summed(await analytics("lists", "views", [news, other], "&unique=true"), "list_id"),
      { [news]: 5, [other]: 2 },
      "tracked-list-unique",
    );
    // With individual tracking links always count distinct known subscribers.
    const distinct = (await analytics("campaigns", "links", [camp1.id])).body.data as {
      url: string;
      count: number;
    }[];
    same(
      distinct.sort((a, b) => a.url.localeCompare(b.url)),
      [
        { url: "https://example.test/a", count: 1 },
        { url: "https://example.test/b", count: 1 },
      ],
      "tracked-links",
    );
    same(
      (await analytics("lists", "links", [other])).body,
      { data: [{ url: "https://example.test/a", count: 0 }] },
      "tracked-list-links-unattributed",
    );

    if (!reference) {
      // Native: a real transactional send, its pixel and link, grouped by template.
      const created = await call("/api/templates", "POST", {
        name: `${marker} receipt`,
        type: "tx",
        subject: `${marker} receipt`,
        body: `<a href="{{ "https://example.test/receipt" | track_link }}">r</a>{{ track_view }}`,
      });
      check(created.status === 200, "tx-template");
      const template = created.body.data.id as number;
      owned.templates.push(template);
      const tx = await call("/api/tx", "POST", {
        subscriber_id: ada.id,
        template_id: template,
        data: {},
      });
      check(tx.status === 200, `tx-${tx.status}`);
      const [mail] = await received(`${marker} receipt`);
      check(mail, "tx-received");
      const html = (await mailpit.message(mail!.ID)).HTML;
      const tracked = /href="([^"]+\/m\/[^"]+\/link\/[^"]+)"/.exec(html)?.[1];
      const pixel = /src="([^"]+\/m\/[^"]+\/px\.png)"/.exec(html)?.[1];
      check(tracked && pixel, "tx-tracking");
      const local = (url: string) => url.replace(rootUrl, target.baseUrl);
      await fetch(local(pixel!));
      await fetch(local(pixel!));
      await fetch(local(tracked!), { redirect: "manual" });

      // They stay out of the campaign routes and charts.
      same((await charts()).campaign_views, [{ count: 9, date: today }], "sends-not-in-charts");
      const sendPath = `/api/sends/analytics?${wide}`;
      check((await call(sendPath, "GET", undefined, "")).status === 403, "sends-anon");
      check((await call(sendPath, "GET", undefined, scoped)).status === 403, "sends-permission");
      check((await call(`/api/sends/analytics?from=2000`)).status === 400, "sends-dates");
      check((await call(`${sendPath}&group_by=nope`)).status === 400, "sends-group");
      const grouped = (await call(sendPath)).body.data as any[];
      same(
        grouped.find((row) => row.template_id === template),
        {
          template_id: template,
          template_name: `${marker} receipt`,
          sends: 1,
          views: 2,
          unique_views: 1,
          clicks: 1,
          unique_clicks: 1,
        },
        "sends-by-template",
      );
      same((await call(`${sendPath}&group_by=step`)).body, { data: [] }, "sends-by-step-empty");
    }

    // Caching: the numbers hold still until the next refresh, as with materialized views.
    // The collection is what refreshes the view when caching is off.
    const members = async () =>
      (
        (await call("/api/lists?per_page=all")).body.data.results as {
          id: number;
          subscriber_count: number;
        }[]
      ).find((row) => row.id === hidden)!.subscriber_count;
    const membersBefore = await members();
    await setting("app.cache_slow_queries", true);
    const cached = await counts();
    const cachedCharts = await charts();
    await list("late", "public", "single");
    await subscriber("late", [hidden]);
    await view(camp1.uuid, ada.uuid);
    same(await counts(), cached, "cache-counts-stale");
    same(await charts(), cachedCharts, "cache-charts-stale");
    check((await members()) === membersBefore, "cache-list-stale");
    await setting("app.cache_slow_queries", false);
    check((await counts()).lists.total === cached.lists.total + 1, "cache-off-live");
    check((await members()) === membersBefore + 1, "cache-off-list-live");
    await setting("privacy.individual_tracking", false);
    if (target.restart) {
      await target.restart();
      check((await counts()).lists.total === cached.lists.total + 1, "restart-counts");
    }
  } finally {
    let failed = false;
    for (const id of owned.campaigns) await call(`/api/campaigns/${id}`, "DELETE");
    for (const id of owned.users)
      if ((await call(`/api/users/${id}`, "DELETE")).status !== 200) failed = true;
    for (const id of owned.roles.reverse()) await call(`/api/roles/${id}`, "DELETE");
    for (const id of owned.templates) await call(`/api/templates/${id}`, "DELETE");
    for (const id of owned.subscribers) await call(`/api/subscribers/${id}`, "DELETE");
    for (const id of owned.lists) await call(`/api/lists/${id}`, "DELETE");
    await mailpit.removeOwned();
    if (failed) process.stderr.write("analytics cleanup incomplete\n");
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
    await runAnalyticsContract({ mode: "reference", baseUrl, credentials: { user, token } });
    process.stdout.write("PASS analytics reference contract\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-]+$/.test(error.message) ? error.message : `Analytics contract failed: ${error instanceof Error ? error.message : ""}`}\n`,
    );
    process.exitCode = 1;
  }
}
