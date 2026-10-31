// Reference: listmonk cmd/maintenance.go, cmd/settings.go (GetLogs), queries/subscribers.sql and
// queries/campaigns.sql at 6fcd95f. The shared corpus runs against both targets. Where production
// differs on purpose (07-api-and-ui.md) the check is on `reference`.
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Credentials, Mode } from "@/test/contract/types";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { startReceiver } from "@/test/webhooks/receiver";

const past = "1970-01-01T00:00:00Z";
const future = "2099-01-01T00:00:00Z";
const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export async function runMaintenanceContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
  dataDir?: string;
}) {
  const reference = target.mode === "reference";
  const sink = referenceMailpit(process.env);
  await assertOwnedMailpit(sink);
  const marker = `m08${randomBytes(10).toString("hex")}`;
  const mailpit = new Mailpit(sink, marker);
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL maintenance-${label}`);
  };
  const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
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
    const json = response.headers.get("content-type")?.startsWith("application/json");
    return {
      status: response.status,
      body: (json ? JSON.parse(text) : null) as any,
      text,
      headers: response.headers,
    };
  };
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
  const owned = {
    campaigns: [] as number[],
    subscribers: [] as number[],
    lists: [] as number[],
    users: [] as number[],
    roles: [] as number[],
  };
  const list = async (name: string, optin: string) => {
    const created = await call("/api/lists", "POST", {
      name: `${marker} ${name}`,
      type: "private",
      optin,
    });
    check(created.status === 200, `list-${name}`);
    owned.lists.push(created.body.data.id);
    return created.body.data.id as number;
  };
  const subscriber = async (name: string, lists: number[], status = "enabled") => {
    const created = await call("/api/subscribers", "POST", {
      email: `${name}-${marker}@example.test`,
      name,
      status,
      lists,
    });
    check(created.status === 200, `subscriber-${name}`);
    owned.subscribers.push(created.body.data.id);
    return created.body.data as { id: number; uuid: string; email: string };
  };
  const exists = async (id: number) => (await call(`/api/subscribers/${id}`)).status === 200;
  const memberships = async (id: number) =>
    (await call(`/api/subscribers/${id}`)).body.data.lists.map((l: { id: number }) => l.id);
  const apiUser = async (name: string, permissions: string[]) => {
    const role = await call("/api/roles/users", "POST", {
      name: `${name}-${marker}`,
      permissions,
    });
    check(role.status === 200, `role-${name}`);
    owned.roles.push(role.body.data.id);
    const username = `${name}-${marker}`;
    const user = await call("/api/users", "POST", {
      username,
      type: "api",
      status: "enabled",
      name,
      user_role_id: role.body.data.id,
    });
    check(user.status === 200, `user-${name}`);
    owned.users.push(user.body.data.id);
    return `Basic ${btoa(`${username}:${user.body.data.password}`)}`;
  };
  const del = (path: string, auth?: string) => call(path, "DELETE", undefined, auth);
  const when = encodeURIComponent;
  const invalid = (response: { status: number; body: any }, label: string) => {
    check(response.status === 400, `${label}-status-${response.status}`);
    check(response.body?.message === "Invalid data", `${label}-message`);
  };

  /** The native owners a maintenance delete goes through, and what only this store holds. */
  const production = async (list: number) => {
    const db = new Database(join(target.dataDir!, "iglo-email.db"));
    const receiver = startReceiver();
    try {
      const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
      const hook = await call("/api/webhooks", "POST", {
        url: receiver.url(),
        events: ["subscriber.blocklisted", "subscriber.deleted"],
      });
      check(hook.status === 200, "hook");
      const person = await call("/api/subscribers", "POST", {
        email: `person-${marker}@example.test`,
        name: "Person",
        status: "enabled",
        lists: [list],
        external_id: `person-${marker}`,
      });
      check(person.status === 200, "person");
      const { id, email, uuid } = person.body.data;
      owned.subscribers.push(id);
      const send = (linked: number | null) =>
        db.run(
          `INSERT INTO sends (uuid, source, kind, subscriber_id, to_email, status, payload)
           VALUES (?, 'tx', 'transactional', ?, ?, 'sent', '{}')`,
          [crypto.randomUUID(), linked, email],
        );
      send(id);
      send(null);
      db.run(`INSERT INTO campaign_views (send_id, subscriber_id, created_at)
        SELECT id, ${id}, '2000-01-01T00:00:00.000Z' FROM sends WHERE subscriber_id = ${id}`);
      check((await call(`/api/subscribers/${id}/blocklist`, "PUT")).status === 200, "blocklist");

      // D25 and D61: the delete is the subscriber owner's.
      const gone = await del("/api/maintenance/subscribers/blocklisted");
      check(gone.status === 200 && gone.body.data.count === 1, "owner-delete");
      check(
        count(`SELECT count(*) AS n FROM subscriber_lists WHERE subscriber_id = ${id}`) === 0,
        "m",
      );
      check(
        count(`SELECT count(*) AS n FROM sends WHERE to_email = '${email}'`) === 0 &&
          count("SELECT count(*) AS n FROM sends WHERE to_email = '' AND payload IS NULL") === 2,
        "owner-anonymized",
      );
      check(
        count(`SELECT count(*) AS n FROM webhook_deliveries WHERE payload LIKE '%${email}%'`) === 0,
        "cleared",
      );
      const deliveries = await receiver.waitFor(2);
      const deleted = deliveries.find((entry) => entry.body.event === "subscriber.deleted");
      const subject = deleted?.body.data.subscriber;
      check(subject?.uuid === uuid && subject.email === "", "owner-webhook");
      check(subject.external_id === `person-${marker}`, "owner-webhook-external");
      // History stays, without the person, and rows of sends are not campaign analytics.
      check(
        count("SELECT count(*) AS n FROM campaign_views WHERE send_id IS NOT NULL") === 1 &&
          count("SELECT count(*) AS n FROM campaign_views WHERE subscriber_id IS NULL") === 1,
        "owner-history",
      );
      const purged = await del(`/api/maintenance/analytics/all?before_date=${future}`);
      check(purged.status === 200, "purge-send-rows");
      check(count("SELECT count(*) AS n FROM campaign_views") === 1, "purge-keeps-send-rows");
      const empty = await call(`/api/maintenance/analytics/views/export?since=${past}`);
      check(empty.status === 200 && empty.text === "", "export-no-send-rows");

      // The bulk budget: refused before any write, whatever the selection.
      db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50001)
        INSERT INTO subscribers (uuid, email, name, status)
        SELECT lower(hex(randomblob(16))), 'budget' || i || '@example.test', 'b', 'blocklisted' FROM n`);
      const over = await del("/api/maintenance/subscribers/blocklisted");
      check(over.status === 400 && over.body.message.includes("50,001"), "budget-refused");
      check(
        count("SELECT count(*) AS n FROM subscribers WHERE status = 'blocklisted'") === 50_001,
        "budget-no-write",
      );
      const off = await call(`/api/webhooks/${hook.body.data.id}`, "DELETE");
      check(off.status === 200, "hook-delete");

      // One operation at a time; the running one finishes.
      const running = del("/api/maintenance/subscribers/blocklisted");
      await Bun.sleep(100);
      const second = await del(`/api/maintenance/analytics/all?before_date=${future}`);
      check(second.status === 429, `busy-${second.status}`);
      const finished = await running;
      check(finished.status === 200 && finished.body.data.count === 50_001, "busy-finished");
      check(
        count("SELECT count(*) AS n FROM subscribers WHERE status = 'blocklisted'") === 0,
        "budget-deleted",
      );
    } finally {
      db.close();
      receiver.close();
    }
  };

  try {
    // Who may call what.
    const reader = await apiUser("reader", ["settings:get"]);
    const maintainer = await apiUser("maintainer", ["settings:maintain"]);
    check((await call("/api/logs", "GET", undefined, maintainer)).status === 403, "logs-denied");
    const logs = await call("/api/logs", "GET", undefined, reader);
    check(logs.status === 200 && Array.isArray(logs.body.data), "logs-shape");
    check(
      logs.body.data.every((line: unknown) => typeof line === "string"),
      "logs-strings",
    );
    for (const [method, path] of [
      ["DELETE", "/api/maintenance/subscribers/orphan"],
      ["DELETE", `/api/maintenance/analytics/all?before_date=${past}`],
      ["GET", `/api/maintenance/analytics/views/export?since=${past}`],
      ["DELETE", `/api/maintenance/subscriptions/unconfirmed?before_date=${past}`],
    ] as const) {
      check((await call(path, method, undefined, reader)).status === 403, `denied-${path}`);
      check((await call(path, method, undefined, "")).status === 403, `anonymous-${path}`);
    }

    // Validation: the date comes before the type, as upstream parses it first.
    invalid(await del("/api/maintenance/subscribers/nope"), "subscriber-type");
    for (const bad of ["", "invalid", "2026-01-01", "2026-02-30T00:00:00Z", "2026-01-01 00:00:00Z"])
      invalid(
        await del(`/api/maintenance/analytics/all?before_date=${when(bad)}`),
        `analytics-date-${bad}`,
      );
    invalid(await del(`/api/maintenance/analytics/nope?before_date=${past}`), "analytics-type");
    invalid(await del("/api/maintenance/analytics/nope"), "analytics-type-no-date");
    // Upstream's types are all, views and clicks: there is no `subscribers`.
    invalid(await del(`/api/maintenance/analytics/subscribers?before_date=${past}`), "subscribers");
    invalid(await del("/api/maintenance/subscriptions/unconfirmed"), "subscriptions-no-date");
    invalid(
      await del("/api/maintenance/subscriptions/unconfirmed?before_date=nope"),
      "subscriptions-date",
    );
    invalid(await call("/api/maintenance/analytics/views/export"), "export-no-since");
    invalid(await call("/api/maintenance/analytics/views/export?since=nope"), "export-since");
    invalid(await call(`/api/maintenance/analytics/all/export?since=${past}`), "export-all");
    invalid(await call(`/api/maintenance/analytics/nope/export?since=${past}`), "export-type");

    // Subscribers.
    const single = await list("single, list", "single");
    const double = await list("double", "double");
    const member = await subscriber("member", [single]);
    const orphan = await subscriber("orphan", []);
    const blocked = await subscriber("blocked", [single], "blocklisted");
    const blockedOrphan = await subscriber("blocked-orphan", [], "blocklisted");
    const removed = await del("/api/maintenance/subscribers/blocklisted", maintainer);
    check(removed.status === 200 && removed.body.data.count >= 2, "blocklisted-count");
    check(Object.keys(removed.body.data).join() === "count", "blocklisted-shape");
    check(!(await exists(blocked.id)) && !(await exists(blockedOrphan.id)), "blocklisted-gone");
    check((await exists(member.id)) && (await exists(orphan.id)), "blocklisted-others-stay");
    const orphans = await del("/api/maintenance/subscribers/orphan");
    check(orphans.status === 200 && orphans.body.data.count >= 1, "orphan-count");
    check(!(await exists(orphan.id)) && (await exists(member.id)), "orphan-gone");
    check((await del("/api/maintenance/subscribers/orphan")).body.data.count === 0, "orphan-again");

    // Unconfirmed subscriptions of double opt-in lists only, older than the date.
    const waiting = await subscriber("waiting", [single, double]);
    const confirmed = await subscriber("confirmed", []);
    check(
      (
        await call("/api/subscribers/lists", "PUT", {
          ids: [confirmed.id],
          action: "add",
          target_list_ids: [double],
          status: "confirmed",
        })
      ).status === 200,
      "confirm",
    );
    const none = await del(`/api/maintenance/subscriptions/unconfirmed?before_date=${past}`);
    check(none.status === 200 && none.body.data.count === 0, "subscriptions-none");
    check((await memberships(waiting.id)).length === 2, "subscriptions-untouched");
    const offset = when("2099-01-01T02:00:00+02:00");
    const deleted = await del(`/api/maintenance/subscriptions/unconfirmed?before_date=${offset}`);
    check(deleted.status === 200 && deleted.body.data.count >= 1, "subscriptions-count");
    check((await memberships(waiting.id)).join() === String(single), "subscriptions-double-only");
    check((await memberships(confirmed.id)).join() === String(double), "subscriptions-confirmed");

    // Analytics, through the real pixel and redirect.
    await setting("privacy.individual_tracking", true);
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
    const created = await call("/api/campaigns", "POST", {
      name: `${marker} one, "two"`,
      subject: "s",
      lists: [single],
      content_type: "richtext",
      body: "<p>b</p>",
    });
    check(created.status === 200, "campaign");
    owned.campaigns.push(created.body.data.id);
    const campaign = created.body.data as { id: number; uuid: string };
    const templates = (await call("/api/templates?no_body=true")).body.data as any[];
    const subject = `${marker} links`;
    const url = "https://example.test/maintenance";
    const sent = await call(`/api/campaigns/${campaign.id}/test`, "POST", {
      name: "links",
      subject,
      lists: [single],
      messenger: "email",
      content_type: "richtext",
      template_id: templates.find((t) => t.is_default).id,
      body: `<a href="${reference ? `{{ TrackLink "${url}" }}` : `{{ "${url}" | track_link }}`}">a</a>`,
      subscribers: [member.email],
    });
    check(sent.status === 200, "test-send");
    let mails = await mailpit.list();
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; await Bun.sleep(25)) {
      mails = (await mailpit.list()).filter((m) => m.Subject === subject);
      if (mails.length) break;
    }
    check(mails.length === 1, "test-received");
    const link = /\/link\/([0-9a-f-]{36})\//.exec((await mailpit.message(mails[0]!.ID)).HTML)?.[1];
    check(link, "test-link");
    const view = async () =>
      check(
        (await fetch(`${rootUrl}/campaign/${campaign.uuid}/${member.uuid}/px.png`)).status === 200,
        "view",
      );
    const click = async () =>
      check(
        [302, 307].includes(
          (
            await fetch(`${rootUrl}/link/${link}/${campaign.uuid}/${member.uuid}`, {
              redirect: "manual",
            })
          ).status,
        ),
        "click",
      );
    const since = when(new Date(Date.now() - 86_400_000).toISOString());
    const exported = async (type: string) => {
      const response = await call(`/api/maintenance/analytics/${type}/export?since=${since}`);
      check(response.status === 200, `export-${type}`);
      check(response.headers.get("content-type") === "text/csv", `export-${type}-type`);
      check(
        response.headers.get("content-disposition") === `attachment; filename=campaign_${type}.csv`,
        `export-${type}-name`,
      );
      check(response.headers.get("cache-control") === "no-cache", `export-${type}-cache`);
      return response.text.split("\n").filter(Boolean);
    };
    const quoted = `"${marker} one, ""two"""`;
    await view();
    await view();
    await click();
    const views = await exported("views");
    check(
      views[0] ===
        "campaign_id,campaign_uuid,campaign_name,subscriber_id,subscriber_uuid,email,subscriber_name,created_at",
      "export-views-header",
    );
    check(views.length === 3, "export-views-rows");
    const prefix = `${campaign.id},${campaign.uuid},${quoted},`;
    const person = `${member.id},${member.uuid},${member.email},member,`;
    check(views[1]!.startsWith(prefix + person), "export-views-row");
    check(stamp.test(views[1]!.slice((prefix + person).length)), "export-views-time");
    const clicks = await exported("clicks");
    check(
      clicks[0] ===
        "campaign_id,campaign_uuid,campaign_name,subscriber_id,subscriber_uuid,email,subscriber_name,url,created_at",
      "export-clicks-header",
    );
    check(clicks.length === 2, "export-clicks-rows");
    check(clicks[1]!.startsWith(`${prefix}${person}${url},`), "export-clicks-row");
    // Upstream flushes its writer after each batch, so no rows is an empty body, without a header.
    const nothing = await call(`/api/maintenance/analytics/views/export?since=${future}`);
    check(nothing.status === 200 && nothing.text === "", "export-since-filters");

    // Turning individual tracking off keeps subscribers out of an export of older rows; upstream
    // writes them out, because its rows stay attributed.
    await setting("privacy.individual_tracking", false);
    const anonymous = await exported("views");
    check(anonymous.length === 3, "anonymous-rows");
    if (reference) check(anonymous[1]!.startsWith(prefix + person), "reference-keeps-subscriber");
    else {
      check(anonymous[1]!.startsWith(`${prefix}0,,,,`), "anonymous-row");
      check(!anonymous.join().includes(member.email), "anonymous-no-address");
      const clicked = await exported("clicks");
      check(clicked[1]!.startsWith(`${prefix}0,,,,${url},`), "anonymous-click");
    }

    // Deleting: before the date only, one type at a time, then all.
    const kept = await del(`/api/maintenance/analytics/all?before_date=${past}`);
    check(kept.status === 200 && kept.body.data === true, "analytics-none");
    check((await exported("views")).length === 3, "analytics-kept");
    const onlyViews = await del(
      `/api/maintenance/analytics/views?before_date=${future}`,
      maintainer,
    );
    check(onlyViews.status === 200 && onlyViews.body.data === true, "analytics-views");
    check((await exported("views")).length === 0, "analytics-views-gone");
    check((await exported("clicks")).length === 2, "analytics-clicks-stay");
    await view();
    const all = await del(`/api/maintenance/analytics/all?before_date=${when(future)}`);
    check(all.status === 200 && all.body.data === true, "analytics-all");
    check((await exported("views")).length === 0, "analytics-all-views");
    check((await exported("clicks")).length === 0, "analytics-all-clicks");

    if (!reference) await production(single);
  } finally {
    await call("/api/settings/privacy.individual_tracking", "PUT", false).catch(() => {});
    for (const id of owned.campaigns) await call(`/api/campaigns/${id}`, "DELETE");
    for (const id of owned.users) await call(`/api/users/${id}`, "DELETE");
    for (const id of owned.roles) await call(`/api/roles/${id}`, "DELETE");
    for (const id of owned.subscribers) await call(`/api/subscribers/${id}`, "DELETE");
    for (const id of owned.lists) await call(`/api/lists/${id}`, "DELETE");
    await mailpit.removeOwned();
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
    await runMaintenanceContract({ mode: "reference", baseUrl, credentials: { user, token } });
    process.stdout.write("PASS maintenance reference contract\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [^\n]+$/.test(error.message) ? error.message : `Maintenance contract failed: ${error}`}\n`,
    );
    process.exitCode = 1;
  }
}
