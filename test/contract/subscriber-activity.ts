// Reference: listmonk cmd/subscribers.go (GetSubscriberActivity, DeleteSubscriberActivity,
// ExportSubscriberData), cmd/handlers.go, internal/core/subscribers.go and queries/subscribers.sql
// at 6fcd95f. Views and clicks go through the real pixel and redirect routes.
import type { Credentials, Mode } from "@/test/contract/types";

export async function runSubscriberActivity(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
}) {
  const suffix = crypto.randomUUID();
  const reference = target.mode === "reference";
  const basic = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const resources: { path: string; id: number }[] = [];
  let cleanupFailed = false;
  function check(value: unknown, label: string): asserts value {
    if (!value) throw new Error(`FAIL ${label}`);
  }
  const request = (path: string, method = "GET", body?: unknown, authorization = basic) =>
    fetch(`${target.baseUrl}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const setting = async (key: string, value: unknown) => {
    check((await request(`/api/settings/${key}`, "PUT", value)).status === 200, `setting-${key}`);
    if (!reference) return;
    // The pinned reference restarts itself to apply a setting.
    await Bun.sleep(1500);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const up = await fetch(`${target.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      }).catch(() => null);
      if (up?.ok) return;
      check(Date.now() < deadline, "subscriber-activity-restart-wait");
      await Bun.sleep(100);
    }
  };
  const create = async (path: string, data: unknown) => {
    const response = await request(path, "POST", data);
    const value = (await response.json()).data;
    check(response.status === 200 && value?.id, `subscriber-activity-setup-${path}`);
    resources.push({ path, id: value.id });
    return value;
  };
  const denied = async (response: Response, message: string, label: string) => {
    check(response.status === 403, `${label}-status`);
    check((await response.json()).message === message, `${label}-message`);
  };
  /** An API user, by the permissions and per-list grants of a role made for it. */
  const caller = async (name: string, permissions: string[], lists: unknown[] = []) => {
    const role = await create("/api/roles/users", { name: `${name}-${suffix}`, permissions });
    const listRole = await create("/api/roles/lists", { name: `${name}-l-${suffix}`, lists });
    const user = await create("/api/users", {
      username: `${name}-${suffix}`,
      type: "api",
      status: "enabled",
      user_role_id: role.id,
      list_role_id: listRole.id,
    });
    return `Basic ${btoa(`${user.username}:${user.password}`)}`;
  };

  /** A tracked link as a real send registers it. The reference's preview already does. */
  const trackedLink = async (campaign: Record<string, unknown>, listId: number, to: string) => {
    if (reference)
      return /\/link\/([0-9a-f-]{36})\//.exec(
        await (await request(`/api/campaigns/${campaign.id}/preview`)).text(),
      )?.[1];
    let mail = "";
    const sink = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => void socket.write("220 fixture\r\n"),
        data(socket, chunk) {
          const text = chunk.toString();
          if (mail) mail += text;
          if (mail.endsWith("\r\n.\r\n")) return void socket.write("250 ok\r\n");
          if (mail) return;
          if (/^DATA/i.test(text)) mail = " ";
          socket.write(mail ? "354 go\r\n" : "250 ok\r\n");
        },
      },
    });
    try {
      const smtp = before.smtp.map((server: object) => ({
        ...server,
        enabled: true,
        host: "127.0.0.1",
        port: sink.port,
        auth_protocol: "none",
        username: "",
        password: "",
        tls_type: "none",
        email_headers: [],
      }));
      check(
        (await request("/api/settings/smtp", "PUT", smtp)).status === 200,
        "subscriber-activity-smtp",
      );
      const sent = await request(`/api/campaigns/${campaign.id}/test`, "POST", {
        ...campaign,
        lists: [listId],
        subscribers: [to],
      });
      if (sent.status !== 200)
        throw new Error(`FAIL subscriber-activity-test-send ${await sent.text()}`);
      for (const deadline = Date.now() + 10_000; !mail.endsWith("\r\n.\r\n"); await Bun.sleep(25))
        check(Date.now() < deadline, "subscriber-activity-mail");
      return /\/link\/([0-9a-f-]{36})\//.exec(mail.replaceAll("=\r\n", ""))?.[1];
    } finally {
      sink.stop(true);
      await request("/api/settings/smtp", "PUT", before.smtp);
    }
  };

  const before = (await (await request("/api/settings")).json()).data;
  try {
    await setting("privacy.individual_tracking", true);
    const list = await create("/api/lists", { name: `activity-${suffix}`, type: "public" });
    const hidden = await create("/api/lists", {
      name: `activity-private-${suffix}`,
      type: "private",
    });
    const other = await create("/api/lists", { name: `activity-other-${suffix}` });
    const subscriber = await create("/api/subscribers", {
      email: `activity-${suffix}@example.test`,
      name: "Activity",
      attribs: { plan: "a" },
      lists: [list.id, hidden.id],
      preconfirm_subscriptions: true,
    });
    const outsider = await create("/api/subscribers", {
      email: `activity-other-${suffix}@example.test`,
      lists: [other.id],
      preconfirm_subscriptions: true,
    });
    const url = `https://example.test/activity/${suffix}`;
    const campaign = await create("/api/campaigns", {
      name: `activity-${suffix}`,
      subject: `activity subject ${suffix}`,
      lists: [list.id],
      content_type: "richtext",
      messenger: "email",
      body: `<a href="${reference ? `{{ TrackLink "${url}" }}` : `{{ "${url}" | track_link }}`}">a</a>`,
    });
    const link = await trackedLink(campaign, list.id, subscriber.email);
    check(link, "subscriber-activity-link");

    // No activity yet: both are empty arrays, never null.
    const path = `/api/subscribers/${subscriber.id}`;
    let response = await request(`${path}/activity`);
    check(response.status === 200, "subscriber-activity-empty-status");
    check(
      JSON.stringify(await response.json()) === '{"data":{"campaign_views":[],"link_clicks":[]}}',
      "subscriber-activity-empty",
    );

    const view = async () =>
      check(
        (
          await request(
            `/campaign/${campaign.uuid}/${subscriber.uuid}/px.png`,
            "GET",
            undefined,
            "",
          )
        ).status === 200,
        "subscriber-activity-view",
      );
    const click = async () =>
      check(
        [302, 307].includes(
          (await request(`/link/${link}/${campaign.uuid}/${subscriber.uuid}`, "GET", undefined, ""))
            .status,
        ),
        "subscriber-activity-click",
      );
    const track = async () => {
      await view();
      await view();
      await click();
      await click();
      await click();
    };
    await track();

    // One row per campaign and per link and campaign, with upstream's fields.
    const activity = async () => (await (await request(`${path}/activity`)).json()).data;
    let data = await activity();
    check(
      Object.keys(data).sort().join() === "campaign_views,link_clicks",
      "subscriber-activity-keys",
    );
    check(data.campaign_views.length === 1, "subscriber-activity-views-rows");
    const views = data.campaign_views[0];
    check(
      Object.keys(views).sort().join() === "id,last_viewed_at,name,subject,uuid,view_count",
      "subscriber-activity-view-fields",
    );
    check(
      views.id === campaign.id &&
        views.uuid === campaign.uuid &&
        views.name === campaign.name &&
        views.subject === campaign.subject &&
        views.view_count === 2 &&
        !Number.isNaN(Date.parse(views.last_viewed_at)),
      "subscriber-activity-view-values",
    );
    check(data.link_clicks.length === 1, "subscriber-activity-clicks-rows");
    const clicks = data.link_clicks[0];
    check(
      Object.keys(clicks).sort().join() ===
        "campaign_id,campaign_name,campaign_subject,campaign_uuid,click_count,last_clicked_at,link_id,url",
      "subscriber-activity-click-fields",
    );
    check(
      typeof clicks.link_id === "number" &&
        clicks.url === url &&
        clicks.campaign_id === campaign.id &&
        clicks.campaign_uuid === campaign.uuid &&
        clicks.campaign_name === campaign.name &&
        clicks.campaign_subject === campaign.subject &&
        clicks.click_count === 3 &&
        !Number.isNaN(Date.parse(clicks.last_clicked_at)),
      "subscriber-activity-click-values",
    );

    // The privacy export: a download of the sections `privacy.exportable` allows.
    const exported = async (authorization = basic) => {
      const reply = await request(`${path}/export`, "GET", undefined, authorization);
      check(reply.status === 200, "subscriber-export-status");
      check(
        reply.headers.get("content-type")?.split(";", 1)[0] === "application/json",
        "subscriber-export-type",
      );
      check(reply.headers.get("cache-control") === "no-cache", "subscriber-export-cache");
      check(
        reply.headers.get("content-disposition") === 'attachment; filename="data.json"',
        "subscriber-export-attachment",
      );
      const text = await reply.text();
      check(text.startsWith('{\n  "'), "subscriber-export-indented");
      return JSON.parse(text);
    };
    let file = await exported();
    check(
      file.profile.length === 1 &&
        Object.keys(file.profile[0]).sort().join() ===
          "attribs,created_at,email,id,name,status,updated_at,uuid" &&
        file.profile[0].id === subscriber.id &&
        file.profile[0].uuid === subscriber.uuid &&
        file.profile[0].email === subscriber.email &&
        file.profile[0].attribs.plan === "a",
      "subscriber-export-profile",
    );
    const secret = file.subscriptions.find(({ type }: { type: string }) => type === "private");
    const open = file.subscriptions.find(({ type }: { type: string }) => type === "public");
    check(
      file.subscriptions.length === 2 &&
        Object.keys(open).sort().join() === "created_at,name,subscription_status,type" &&
        secret.name === "Private list" &&
        open.name === list.name &&
        open.subscription_status === "confirmed",
      "subscriber-export-subscriptions",
    );
    check(
      JSON.stringify(file.campaign_views) ===
        JSON.stringify([{ campaign: campaign.subject, views: 2 }]),
      "subscriber-export-views",
    );
    check(
      JSON.stringify(file.link_clicks) === JSON.stringify([{ url, clicks: 3 }]),
      "subscriber-export-clicks",
    );
    if (!reference)
      check(
        ["sends", "events", "bounces"].every((name) => Array.isArray(file[name])),
        "subscriber-export-native-sections",
      );

    // Only the configured sections, and the keys of the others are absent.
    await setting("privacy.exportable", ["profile", "link_clicks"]);
    file = await exported();
    check(
      Object.keys(file).sort().join() ===
        (reference ? "link_clicks,profile" : "events,link_clicks,profile"),
      "subscriber-export-exportable",
    );
    await setting("privacy.exportable", before["privacy.exportable"]);

    // Either subscriber read permission, and the subscriber's lists.
    const noRead = await caller("activity-none", ["lists:get_all"]);
    const reader = await caller(
      "activity-reader",
      ["subscribers:get"],
      [{ id: list.id, permissions: ["list:get"] }],
    );
    const manager = await caller(
      "activity-manager",
      ["subscribers:get_all"],
      [{ id: list.id, permissions: ["list:manage"] }],
    );
    const outside = await caller(
      "activity-outside",
      ["subscribers:get", "subscribers:manage"],
      [{ id: other.id, permissions: ["list:get", "list:manage"] }],
    );
    for (const route of ["activity", "export"]) {
      const at = `${path}/${route}`;
      await denied(
        await request(at, "GET", undefined, noRead),
        "permission denied: subscribers:get",
        `subscriber-${route}-no-permission`,
      );
      check(
        (await request(at, "GET", undefined, reader)).status === 200,
        `subscriber-${route}-list-get`,
      );
      check(
        (await request(at, "GET", undefined, manager)).status === 200,
        `subscriber-${route}-list-manage`,
      );
      await denied(
        await request(at, "GET", undefined, outside),
        `Permission denied: subscriber: ${subscriber.id}`,
        `subscriber-${route}-list-scope`,
      );
      check((await request(at, "GET", undefined, "")).status === 403, `subscriber-${route}-anon`);
      check(
        (await request(`/api/subscribers/not-a-number/${route}`)).status === 400,
        `subscriber-${route}-bad-id`,
      );
    }

    // Clearing needs subscribers:manage and a managed list; reading a list is not enough.
    const editor = await caller(
      "activity-editor",
      ["subscribers:manage"],
      [{ id: list.id, permissions: ["list:manage"] }],
    );
    const viewer = await caller(
      "activity-viewer",
      ["subscribers:manage"],
      [{ id: list.id, permissions: ["list:get"] }],
    );
    const clear = (type: string, authorization = basic) =>
      request(`${path}/activity/${type}`, "DELETE", undefined, authorization);
    await denied(
      await clear("campaign_views", reader),
      "permission denied: subscribers:manage",
      "subscriber-activity-delete-no-permission",
    );
    await denied(
      await clear("campaign_views", viewer),
      `Permission denied: subscriber: ${subscriber.id}`,
      "subscriber-activity-delete-list-get",
    );
    await denied(
      await clear("campaign_views", outside),
      `Permission denied: subscriber: ${subscriber.id}`,
      "subscriber-activity-delete-list-scope",
    );
    check((await clear("campaign_views", "")).status === 403, "subscriber-activity-delete-anon");
    response = await clear("views");
    check(response.status === 400, "subscriber-activity-delete-type-status");
    check(
      (await response.json()).message === "Invalid activity type.",
      "subscriber-activity-delete-type",
    );
    data = await activity();
    check(
      data.campaign_views.length === 1 && data.link_clicks.length === 1,
      "subscriber-activity-delete-refused-keeps",
    );

    // Each type clears only itself, for only this subscriber.
    await request(`/campaign/${campaign.uuid}/${outsider.uuid}/px.png`, "GET", undefined, "");
    response = await clear("campaign_views", editor);
    check(
      response.status === 200 && JSON.stringify(await response.json()) === '{"data":true}',
      "subscriber-activity-delete-views",
    );
    data = await activity();
    check(
      data.campaign_views.length === 0 && data.link_clicks.length === 1,
      "subscriber-activity-delete-views-only",
    );
    check(
      (await (await request(`/api/subscribers/${outsider.id}/activity`)).json()).data.campaign_views
        .length === 1,
      "subscriber-activity-delete-other-subscriber",
    );
    await view();
    check((await clear("link_clicks")).status === 200, "subscriber-activity-delete-clicks");
    data = await activity();
    check(
      data.campaign_views.length === 1 && data.link_clicks.length === 0,
      "subscriber-activity-delete-clicks-only",
    );
    // Repeating is not an error.
    check((await clear("link_clicks")).status === 200, "subscriber-activity-delete-repeat");

    // The subscriber and its consent records stay.
    const after = (await (await request(path)).json()).data;
    check(
      after.email === subscriber.email &&
        after.status === subscriber.status &&
        after.lists.length === 2 &&
        after.lists.every(
          (entry: { subscription_status: string }) => entry.subscription_status === "confirmed",
        ),
      "subscriber-activity-delete-keeps-subscriber",
    );

    // A subscriber that does not exist: an empty history, but no file. Upstream fails with a 500.
    const missing = 2_000_000_000;
    response = await request(`/api/subscribers/${missing}/activity`);
    check(response.status === 200, "subscriber-activity-missing");
    check(
      JSON.stringify(await response.json()) === '{"data":{"campaign_views":[],"link_clicks":[]}}',
      "subscriber-activity-missing-body",
    );
    response = await request(`/api/subscribers/${missing}/export`);
    check(response.status === (reference ? 500 : 400), "subscriber-export-missing");
    response = await request(`/api/subscribers/${missing}/activity/link_clicks`, "DELETE");
    check(response.status === 200, "subscriber-activity-delete-missing");
  } finally {
    await setting("privacy.exportable", before["privacy.exportable"]).catch(() => {
      cleanupFailed = true;
    });
    await setting("privacy.individual_tracking", before["privacy.individual_tracking"]).catch(
      () => {
        cleanupFailed = true;
      },
    );
    for (const { path, id } of resources.reverse()) {
      const owner = path.startsWith("/api/roles/") ? "/api/roles" : path;
      if ((await request(`${owner}/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    }
  }
  if (cleanupFailed) throw new Error("FAIL subscriber-activity-cleanup");
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
    await runSubscriberActivity({ mode: "reference", baseUrl, credentials: { user, token } });
    process.stdout.write("PASS subscriber activity reference contract\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "failed"}\n`);
    process.exitCode = 1;
  }
}
