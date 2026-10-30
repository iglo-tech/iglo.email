// Reference: listmonk cmd/campaigns.go, internal/core/campaigns.go, queries/campaigns.sql,
// models/campaigns.go, cmd/public.go (SubscriptionPage, SubscriptionPrefs, LinkRedirect,
// RegisterCampaignView) and internal/manager (TemplateFuncs, message headers) at 6fcd95f.
// Shared results run against both the pinned reference and the compiled executable. Bodies
// use Go templates upstream and Liquid natively (D9); declared differences are marked D-…
// below and listed in docs/design/07-api-and-ui.md. Test mail is read from the
// invocation-owned Mailpit.
import { randomBytes } from "node:crypto";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { header } from "@/test/perf/runtime-compat/smtp-expect";
import type { Credentials, Mode } from "@/test/contract/types";

type Campaign = Record<string, any> & { id: number; uuid: string };
const fields = [
  "id",
  "created_at",
  "updated_at",
  "views",
  "clicks",
  "bounces",
  "lists",
  "media",
  "started_at",
  "to_send",
  "sent",
  "uuid",
  "type",
  "name",
  "subject",
  "from_email",
  "body",
  "body_source",
  "altbody",
  "send_at",
  "status",
  "content_type",
  "tags",
  "headers",
  "attribs",
  "template_id",
  "messenger",
  "archive",
  "archive_slug",
  "archive_template_id",
  "archive_meta",
].join(",");

export async function runCampaignsContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
  restart?: () => Promise<void>;
}) {
  const reference = target.mode === "reference";
  const sink = referenceMailpit(process.env);
  await assertOwnedMailpit(sink);
  const marker = `m08${randomBytes(10).toString("hex")}`;
  const mailpit = new Mailpit(sink, marker);
  const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL campaigns-${label}`);
  };
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    auth: string = authorization,
    contentType = "application/json",
  ) => {
    const response = await fetch(`${target.baseUrl}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(auth ? { authorization: auth } : {}),
        ...(body === undefined ? {} : { "content-type": contentType }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let parsed: any = text;
    if (response.headers.get("content-type")?.startsWith("application/json"))
      parsed = JSON.parse(text);
    return { status: response.status, headers: response.headers, body: parsed };
  };
  const message = (response: { body: any }) => response.body?.message as string | undefined;
  const form = (path: string, values: Record<string, string>, auth = authorization) =>
    call(
      path,
      "POST",
      new URLSearchParams(values).toString(),
      auth,
      "application/x-www-form-urlencoded",
    );
  const received = async (subject: string, count = 1) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = (await mailpit.list()).filter((m) => m.Subject === subject);
      if (found.length >= count || Date.now() > deadline) return found;
      await Bun.sleep(25);
    }
  };
  // Go templates upstream, Liquid natively (06-templates.md).
  const tpl = {
    name: reference ? "{{ .Subscriber.Name }}" : "{{ subscriber.name }}",
    first: reference ? "{{ .Subscriber.FirstName }}" : "{{ subscriber.first_name }}",
    email: reference ? "{{ .Subscriber.Email }}" : "{{ subscriber.email }}",
    city: reference ? "{{ .Subscriber.Attribs.city }}" : "{{ subscriber.attribs.city }}",
    campaign: reference ? "{{ .Campaign.Name }}" : "{{ campaign.name }}",
    track: (url: string) =>
      reference ? `{{ TrackLink "${url}" }}` : `{{ "${url}" | track_link }}`,
    unsubscribe: reference ? "{{ UnsubscribeURL }}" : "{{ unsubscribe_url }}",
    broken: reference ? "{{ if }}" : "{% if %}",
  };

  const owned = {
    campaigns: [] as number[],
    subscribers: [] as number[],
    lists: [] as number[],
    users: [] as number[],
    roles: [] as number[],
    templates: [] as number[],
  };
  let cleanupFailed = false;
  const create = async (input: object, label: string, auth = authorization) => {
    const response = await call("/api/campaigns", "POST", input, auth);
    check(response.status === 200, `${label}-status`);
    owned.campaigns.push(response.body.data.id);
    return response.body.data as Campaign;
  };
  const get = async (id: number) => (await call(`/api/campaigns/${id}`)).body.data as Campaign;

  try {
    // Authentication and route permissions.
    check((await call("/api/campaigns", "GET", undefined, "")).status === 403, "auth");

    const settings = (await call("/api/settings")).body.data;
    const fromEmail = settings["app.from_email"][0] as string;
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
    const archiveTemplate = templates.find((t) => t.name === "Default archive template")
      .id as number;

    const list = async (name: string, type: string, optin: string) => {
      const response = await call("/api/lists", "POST", { name: `${marker} ${name}`, type, optin });
      check(response.status === 200, "list-create");
      owned.lists.push(response.body.data.id);
      return response.body.data as { id: number; uuid: string; name: string };
    };
    const subscriber = async (name: string, lists: number[]) => {
      const response = await call("/api/subscribers", "POST", {
        email: `${name.split(" ")[0]!.toLowerCase()}-${marker}@example.test`,
        name,
        lists,
        attribs: { city: "Kraków" },
      });
      check(response.status === 200, "subscriber-create");
      owned.subscribers.push(response.body.data.id);
      return response.body.data as { id: number; uuid: string; email: string };
    };
    const news = await list("news", "public", "single");
    const other = await list("other", "public", "single");
    const double = await list("double", "private", "double");
    const empty = await list("empty", "public", "single");
    const ada = await subscriber("Ada Lovelace", [news.id, double.id]);
    const bob = await subscriber("Bob Other", [other.id]);

    // Creation defaults, projection and normalization.
    const minimal = await create(
      { name: `${marker} minimal`, subject: "Minimal", lists: [news.id] },
      "create",
    );
    check(Object.keys(minimal).join(",") === fields, "projection-fields");
    check(
      minimal.type === "regular" &&
        minimal.status === "draft" &&
        minimal.content_type === "richtext" &&
        minimal.body === "" &&
        minimal.body_source === null &&
        minimal.altbody === null &&
        minimal.send_at === null &&
        minimal.started_at === null &&
        minimal.from_email === fromEmail &&
        minimal.messenger === "email" &&
        minimal.template_id === defaultTemplate &&
        minimal.archive === false &&
        minimal.archive_slug === null &&
        minimal.archive_template_id === null &&
        JSON.stringify(minimal.archive_meta) === "{}" &&
        JSON.stringify(minimal.tags) === "[]" &&
        JSON.stringify(minimal.headers) === "[]" &&
        JSON.stringify(minimal.attribs) === "{}" &&
        JSON.stringify(minimal.media) === "[]" &&
        JSON.stringify(minimal.lists) === JSON.stringify([{ id: news.id, name: news.name }]) &&
        minimal.views === 0 &&
        minimal.clicks === 0 &&
        minimal.bounces === 0 &&
        minimal.to_send === 0 &&
        minimal.sent === 0 &&
        /^[0-9a-f-]{36}$/.test(minimal.uuid) &&
        typeof minimal.created_at === "string",
      "create-defaults",
    );
    const full = await create(
      {
        name: `${marker} full`,
        subject: "Full",
        lists: [news.id, other.id],
        content_type: "markdown",
        body: "# Hi **x**",
        tags: ["a b", " T "],
        headers: [{ "X-A": "1" }],
        attribs: { k: 1 },
        altbody: "alt",
        send_at: "2099-01-01T00:00:00Z",
        messenger: "email",
        from_email: "Me <me@example.test>",
        archive: true,
        archive_slug: `${marker} Hello World!`,
        archive_meta: { a: 1 },
        archive_template_id: archiveTemplate,
        template_id: defaultTemplate,
      },
      "create-full",
    );
    check(
      full.content_type === "markdown" &&
        full.body === "# Hi **x**" &&
        JSON.stringify(full.tags) === '["a-b","T"]' &&
        JSON.stringify(full.headers) === '[{"X-A":"1"}]' &&
        JSON.stringify(full.attribs) === '{"k":1}' &&
        full.altbody === "alt" &&
        Date.parse(full.send_at) === Date.parse("2099-01-01T00:00:00Z") &&
        full.from_email === "Me <me@example.test>" &&
        full.archive === true &&
        full.archive_slug === `${marker}-hello-world` &&
        // Upstream replaces a nonzero archive template with the campaign template.
        full.archive_template_id === defaultTemplate &&
        JSON.stringify(full.archive_meta) === '{"a":1}' &&
        JSON.stringify(full.lists.map((l: any) => l.id)) === JSON.stringify([news.id, other.id]),
      "create-full-projection",
    );
    const noTemplate = await create(
      { name: `${marker} gone`, subject: "s", lists: [news.id], template_id: 2_000_000_000 },
      "create-missing-template",
    );
    check(noTemplate.template_id === null, "create-missing-template-null");
    const unknownType = await create(
      { name: `${marker} ct`, subject: "s", lists: [news.id], content_type: "zzz" },
      "create-content-type",
    );
    check(unknownType.content_type === "richtext", "create-content-type-default");

    const invalid = async (input: object, expected: string, label: string) => {
      const response = await call("/api/campaigns", "POST", input);
      if (response.status === 200) owned.campaigns.push(response.body.data.id);
      check(response.status === 400 && message(response) === expected, label);
    };
    const base = { name: `${marker} invalid`, subject: "s", lists: [news.id] };
    await invalid({ ...base, name: "" }, "Invalid length for name.", "invalid-name");
    await invalid({ ...base, subject: "" }, "Invalid length for subject.", "invalid-subject");
    await invalid({ ...base, lists: [] }, "Invalid list IDs.", "invalid-lists");
    await invalid({ ...base, type: "bad" }, "Invalid fields: type", "invalid-type");
    await invalid({ ...base, messenger: "nope" }, "Unknown messenger nope.", "invalid-messenger");
    await invalid(
      { ...base, send_at: "2001-01-01T00:00:00Z" },
      "Scheduled date should be in the future.",
      "invalid-send-at",
    );
    await invalid({ ...base, from_email: "bad" }, "Invalid `from_email`.", "invalid-from");
    await invalid(
      { ...base, type: "optin" },
      "No opt-in lists found to create campaign.",
      "optin-no-double",
    );
    const brokenBody = await call("/api/campaigns", "POST", { ...base, body: tpl.broken });
    check(
      brokenBody.status === 400 && message(brokenBody)?.startsWith("Error compiling campaign body"),
      "invalid-body",
    );

    // Opt-in campaigns get a generated confirmation body for the double opt-in lists.
    const optin = await create(
      { name: `${marker} optin`, subject: "Confirm", lists: [news.id, double.id], type: "optin" },
      "optin",
    );
    check(
      optin.type === "optin" &&
        optin.lists.length === 2 &&
        optin.body.includes(`l=${double.uuid}`) &&
        !optin.body.includes(news.uuid) &&
        optin.body.includes("<li>Private list</li>") &&
        optin.body.includes(reference ? "{{ OptinURL }}" : "{{ optin_url }}"),
      "optin-body",
    );

    // Retrieval.
    check(JSON.stringify(await get(minimal.id)) === JSON.stringify(minimal), "get");
    const missing = await call("/api/campaigns/2000000000");
    check(missing.status === 400 && message(missing) === "Campaign not found", "get-missing");
    const fullNoBody = (await call(`/api/campaigns/${full.id}?no_body=true`)).body.data;
    check(fullNoBody.body === "" && fullNoBody.altbody === "alt", "get-no-body");

    // Collection search, filters, ordering and paging.
    const collection = async (query: string) =>
      (await call(`/api/campaigns?${query}`)).body.data as {
        results: Campaign[];
        query: string;
        total: number;
        per_page: number;
        page: number;
      };
    const ownedNames = (rows: Campaign[]) =>
      rows.map((row) => row.name.slice(marker.length + 1)).join(",");
    const searched = await collection(`query=${marker}&order_by=name&order=asc&per_page=all`);
    check(
      ownedNames(searched.results) === "ct,full,gone,minimal,optin" &&
        searched.total === 5 &&
        searched.query === marker,
      "collection-search-order",
    );
    const paged = await collection(`query=${marker}&per_page=2&page=2&order_by=name&order=asc`);
    check(
      ownedNames(paged.results) === "gone,minimal" &&
        paged.total === 5 &&
        paged.per_page === 2 &&
        paged.page === 2,
      "collection-page",
    );
    const defaultOrder = await collection(`query=${marker}`);
    check(
      ownedNames(defaultOrder.results) === "optin,ct,gone,full,minimal" &&
        defaultOrder.per_page === 20,
      "collection-default-order",
    );
    check(
      ownedNames((await collection(`query=${marker}&tag=a-b`)).results) === "full",
      "collection-tag",
    );
    check(
      ownedNames((await collection(`query=${marker}&type=optin`)).results) === "optin",
      "collection-type",
    );
    check(
      (await collection(`query=${marker}&status=scheduled&status=running`)).results.length === 0,
      "collection-status",
    );
    check(
      (await collection(`query=${marker}&no_body=true`)).results.every(
        (row) => row.body === "" && row.body_source === null,
      ),
      "collection-no-body",
    );
    check(
      JSON.stringify(await collection(`query=${marker}-nomatch`)) ===
        JSON.stringify({ results: [], search: "", query: "", total: 0, per_page: 0, page: 0 }),
      "collection-empty",
    );

    // Updates: the request replaces sent fields; lists must always be sent.
    const noLists = await call(`/api/campaigns/${minimal.id}`, "PUT", { name: "x" });
    check(noLists.status === 400 && message(noLists) === "Invalid list IDs.", "update-no-lists");
    const updated = (
      await call(`/api/campaigns/${minimal.id}`, "PUT", {
        name: `${marker} minimal2`,
        lists: [other.id],
        attribs: { b: 2 },
        send_at: "2099-01-01T00:00:00Z",
        tags: ["new tag"],
      })
    ).body.data as Campaign;
    check(
      updated.name === `${marker} minimal2` &&
        updated.subject === "Minimal" &&
        JSON.stringify(updated.lists) === JSON.stringify([{ id: other.id, name: other.name }]) &&
        JSON.stringify(updated.attribs) === '{"b":2}' &&
        JSON.stringify(updated.tags) === '["new-tag"]' &&
        Date.parse(updated.send_at) === Date.parse("2099-01-01T00:00:00Z") &&
        updated.created_at === minimal.created_at,
      "update",
    );
    const missingUpdate = await call("/api/campaigns/2000000000", "PUT", {
      name: "x",
      subject: "s",
      lists: [news.id],
    });
    check(
      missingUpdate.status === 400 && message(missingUpdate) === "Campaign not found",
      "update-missing",
    );
    const badUpdate = await call(`/api/campaigns/${minimal.id}`, "PUT", {
      lists: [news.id],
      subject: tpl.broken,
    });
    check(
      badUpdate.status === 400 && message(badUpdate)?.startsWith("Error compiling campaign body"),
      "update-invalid-subject",
    );
    check(
      (await call(`/api/campaigns/${minimal.id}`, "PUT", { lists: "x" })).status === 400,
      "update-bad-json",
    );

    // Status changes record state only; scheduling needs send_at.
    const status = (id: number, value: string) =>
      call(`/api/campaigns/${id}/status`, "PUT", { status: value });
    const expectStatus = async (id: number, value: string, expected: string, label: string) => {
      const response = await status(id, value);
      check(response.status === 200 && response.body.data.status === expected, label);
      return response.body.data as Campaign;
    };
    const expectRefused = async (id: number, value: string, expected: string, label: string) => {
      const response = await status(id, value);
      check(response.status === 400 && message(response) === expected, label);
    };
    const scheduled = await expectStatus(minimal.id, "scheduled", "scheduled", "status-schedule");
    check(Object.keys(scheduled).join(",") === fields, "status-projection");
    await expectRefused(
      minimal.id,
      "paused",
      "Only active campaigns can be paused.",
      "status-pause-refused",
    );
    await expectRefused(
      minimal.id,
      "cancelled",
      "Only active campaigns can be cancelled.",
      "status-cancel-refused",
    );
    // A scheduled campaign whose send_at is cleared becomes a draft again.
    const unscheduled = (
      await call(`/api/campaigns/${minimal.id}`, "PUT", {
        lists: [other.id],
        send_at: null,
      })
    ).body.data as Campaign;
    check(unscheduled.status === "draft" && unscheduled.send_at === null, "update-unschedule");
    await expectRefused(
      minimal.id,
      "scheduled",
      "Campaign needs a date to be scheduled.",
      "status-needs-send-at",
    );
    await expectRefused(
      minimal.id,
      "draft",
      "Only scheduled campaigns can be saved as drafts.",
      "status-draft-refused",
    );
    // With send_at, "running" schedules instead of starting.
    // The response echoes the requested status; the stored one is "scheduled".
    await expectStatus(full.id, "running", "running", "status-running-echo");
    check((await get(full.id)).status === "scheduled", "status-running-scheduled");
    await expectStatus(full.id, "draft", "draft", "status-unschedule");
    // An empty list keeps the reference runner from finishing the campaign mid-test.
    const run = await create(
      { name: `${marker} run`, subject: "Run", lists: [empty.id] },
      "run-create",
    );
    await expectStatus(run.id, "running", "running", "status-start");
    const runningEdit = await call(`/api/campaigns/${run.id}`, "PUT", {
      name: "x",
      subject: "s",
      lists: [empty.id],
    });
    check(
      runningEdit.status === 400 &&
        message(runningEdit) === "Cannot update a running or a finished campaign.",
      "update-running-refused",
    );
    await expectRefused(
      run.id,
      "running",
      "Only paused campaigns and drafts can be started.",
      "status-restart-refused",
    );
    await expectStatus(run.id, "paused", "paused", "status-pause");
    check(
      (
        await call(`/api/campaigns/${run.id}`, "PUT", {
          name: `${marker} run2`,
          subject: "Run",
          lists: [empty.id],
        })
      ).status === 200,
      "update-paused",
    );
    await expectStatus(run.id, "cancelled", "cancelled", "status-cancel");
    check((await get(run.id)).sent === 0, "status-no-send");
    check(
      (await call(`/api/campaigns/2000000000/status`, "PUT", { status: "draft" })).status === 400,
      "status-missing",
    );

    // Archive settings.
    const archived = await call(`/api/campaigns/${minimal.id}/archive`, "PUT", {
      archive: true,
      archive_template_id: archiveTemplate,
      archive_meta: { name: "Archive reader" },
      archive_slug: `${marker} My Slug  Here!`,
    });
    check(
      archived.status === 200 &&
        JSON.stringify(archived.body.data) ===
          JSON.stringify({
            archive: true,
            archive_template_id: archiveTemplate,
            archive_meta: { name: "Archive reader" },
            archive_slug: `${marker}-my-slug-here`,
          }),
      "archive-update",
    );
    const afterArchive = await get(minimal.id);
    check(
      afterArchive.archive === true &&
        afterArchive.archive_slug === `${marker}-my-slug-here` &&
        afterArchive.archive_template_id === archiveTemplate &&
        JSON.stringify(afterArchive.archive_meta) === '{"name":"Archive reader"}',
      "archive-stored",
    );
    const archiveOff = await call(`/api/campaigns/${minimal.id}/archive`, "PUT", {
      archive: false,
    });
    check(
      archiveOff.status === 200 &&
        JSON.stringify(archiveOff.body.data) ===
          '{"archive":false,"archive_template_id":0,"archive_meta":null,"archive_slug":""}',
      "archive-off",
    );
    const afterOff = await get(minimal.id);
    check(
      afterOff.archive === false &&
        afterOff.archive_slug === null &&
        afterOff.archive_template_id === archiveTemplate &&
        // D-campaign-json: omitted meta keeps the stored object instead of storing null.
        JSON.stringify(afterOff.archive_meta) ===
          (reference ? "null" : '{"name":"Archive reader"}'),
      "archive-off-stored",
    );
    const duplicateSlug = await call("/api/campaigns", "POST", {
      ...base,
      archive_slug: `${marker} Hello World!`,
    });
    if (duplicateSlug.status === 200) owned.campaigns.push(duplicateSlug.body.data.id);
    // D-campaign-slug: a duplicate slug is a safe 409 instead of a database error 500.
    check(duplicateSlug.status === (reference ? 500 : 409), "archive-slug-duplicate");

    // Content conversion.
    const converted = await call(`/api/campaigns/${minimal.id}/content`, "POST", {
      body: "# Hi\n\n**b** and *c*",
      from: "markdown",
      to: "html",
    });
    // D-campaign-markdown: marked does not add goldmark's automatic heading IDs.
    check(
      converted.status === 200 &&
        converted.body.data ===
          (reference
            ? '<h1 id="hi">Hi</h1>\n<p><strong>b</strong> and <em>c</em></p>\n'
            : "<h1>Hi</h1>\n<p><strong>b</strong> and <em>c</em></p>\n"),
      "content-markdown",
    );
    const keeps = await call(`/api/campaigns/${minimal.id}/content`, "POST", {
      body: `Hi ${tpl.name} [x](https://example.test/a?b=1&c=2)`,
      from: "markdown",
      to: "richtext",
    });
    check(keeps.status === 200 && keeps.body.data.includes(tpl.name), "content-keeps-template");
    const unknownConversion = await call(`/api/campaigns/${minimal.id}/content`, "POST", {
      body: "<p>x</p>",
      from: "html",
      to: "markdown",
    });
    check(
      unknownConversion.status === 400 &&
        message(unknownConversion) === "unknown formats to convert",
      "content-unknown",
    );

    // Previews render the campaign in its template with a sample subscriber.
    const preview = await create(
      {
        name: `${marker} preview`,
        subject: "Preview subject",
        lists: [news.id],
        body: `<p>Dear ${tpl.name} from ${tpl.city}</p><p>${tpl.campaign}</p>`,
      },
      "preview-create",
    );
    const previewed = await call(`/api/campaigns/${preview.id}/preview`);
    check(
      previewed.status === 200 &&
        previewed.headers.get("content-type") === "text/html; charset=UTF-8" &&
        previewed.headers.get("content-security-policy")?.startsWith("sandbox") &&
        previewed.body.includes("<title>Preview subject</title>") &&
        previewed.body.includes("<p>Dear Demo Subscriber from Bengaluru</p>") &&
        previewed.body.includes(`<p>${marker} preview</p>`),
      "preview",
    );
    const plain = await form(`/api/campaigns/${preview.id}/preview`, {
      content_type: "plain",
      body: `Plain ${tpl.name} <b>`,
    });
    check(
      plain.status === 200 &&
        plain.headers.get("content-type") === "text/plain; charset=UTF-8" &&
        plain.body.includes("Plain Demo Subscriber <b>"),
      "preview-plain",
    );
    const markdown = await form(`/api/campaigns/${preview.id}/preview`, {
      content_type: "markdown",
      body: "# Title",
      template_id: String(archiveTemplate),
    });
    check(
      markdown.status === 200 && /<h1[^>]*>Title<\/h1>/.test(markdown.body),
      "preview-markdown",
    );
    const text = await form(`/api/campaigns/${preview.id}/text`, {
      content_type: "html",
      body: "<p>Text route</p>",
    });
    check(text.status === 200 && text.body.includes("<p>Text route</p>"), "preview-text");
    const archivePreview = await form(`/api/campaigns/${preview.id}/preview/archive`, {
      template_id: String(archiveTemplate),
      archive_meta: JSON.stringify({ name: "Archive Reader", email: "reader@example.test" }),
    });
    check(
      archivePreview.status === 200 && archivePreview.body.includes("<p>Dear Archive Reader from"),
      "preview-archive",
    );
    check((await call("/api/campaigns/2000000000/preview")).status === 400, "preview-missing");
    const brokenPreview = await form(`/api/campaigns/${preview.id}/preview`, {
      content_type: "html",
      body: tpl.broken,
    });
    check(brokenPreview.status === 400, "preview-invalid");

    // Test sends render per recipient and go directly to the given addresses.
    const testCampaign = await create(
      { name: `${marker} test`, subject: "Stored", lists: [news.id], body: "<p>Stored</p>" },
      "test-create",
    );
    const testSubject = `${marker} Hi ${tpl.name}`;
    const testBody = `<p>Dear ${tpl.first} <a href="${tpl.track("https://example.test/x?a=1&b=2")}">x</a> <a href="${tpl.unsubscribe}">Leave</a></p>`;
    const sent = await call(`/api/campaigns/${testCampaign.id}/test`, "POST", {
      name: testCampaign.name,
      subject: testSubject,
      lists: [news.id],
      messenger: "email",
      content_type: "richtext",
      template_id: defaultTemplate,
      body: testBody,
      altbody: `Alt ${tpl.name}`,
      headers: [{ "X-Test": `v-${tpl.email}` }],
      subscribers: [` ${ada.email.toUpperCase()} `],
    });
    check(sent.status === 200 && sent.body.data === true, "test-send");
    const mails = await received(`${marker} Hi Ada Lovelace`);
    check(mails.length === 1, "test-received");
    const mail = await mailpit.message(mails[0]!.ID);
    const raw = await mailpit.raw(mails[0]!.ID);
    const unsubscribeUrl = `${rootUrl}/subscription/${testCampaign.uuid}/${ada.uuid}`;
    check(
      mail.To.length === 1 &&
        mail.To[0]!.Address === ada.email &&
        header(raw, "X-Listmonk-Campaign") === testCampaign.uuid &&
        header(raw, "X-Listmonk-Subscriber") === ada.uuid &&
        header(raw, "X-Test") === `v-${ada.email}` &&
        header(raw, "List-Unsubscribe") === `<${unsubscribeUrl}>` &&
        header(raw, "List-Unsubscribe-Post") === "List-Unsubscribe=One-Click" &&
        mail.HTML.includes("<p>Dear Ada ") &&
        mail.HTML.includes(`href="${unsubscribeUrl}"`) &&
        mail.Text.trim() === "Alt Ada Lovelace",
      "test-message",
    );
    const tracked = new RegExp(
      `href="(${rootUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/link/[0-9a-f-]{36}/${testCampaign.uuid}/[0-9a-f-]{36})"`,
    ).exec(mail.HTML)?.[1];
    check(tracked, "test-tracked-link");
    const redirect = await fetch(tracked!, { redirect: "manual" });
    check(
      redirect.status === 307 &&
        redirect.headers.get("location") === "https://example.test/x?a=1&b=2",
      "test-link-redirect",
    );
    const page = await fetch(unsubscribeUrl, { signal: AbortSignal.timeout(20_000) });
    check(page.status === 200 && (await page.text()).includes("<form"), "unsubscribe-page");
    const oneClick = await fetch(unsubscribeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      signal: AbortSignal.timeout(20_000),
    });
    check(oneClick.status === 200, "unsubscribe-one-click");
    const memberships = (await call(`/api/subscribers/${ada.id}`)).body.data.lists as any[];
    check(
      memberships.find((l) => l.id === news.id)?.subscription_status === "unsubscribed" &&
        memberships.find((l) => l.id === double.id)?.subscription_status === "unconfirmed",
      "unsubscribe-campaign-lists",
    );
    const badSubscriber = await fetch(unsubscribeUrl.replace(ada.uuid, crypto.randomUUID()), {
      method: "POST",
    });
    check(badSubscriber.status === 404, "unsubscribe-unknown-subscriber");
    check(
      (await fetch(`${rootUrl}/subscription/${testCampaign.uuid}/nope`)).status === 400,
      "unsubscribe-invalid-uuid",
    );
    const pixel = await fetch(`${rootUrl}/campaign/${testCampaign.uuid}/${ada.uuid}/px.png`);
    check(
      pixel.status === 200 &&
        pixel.headers.get("content-type") === "image/png" &&
        pixel.headers.get("cache-control") === "no-cache",
      "view-pixel",
    );
    const afterTest = await get(testCampaign.id);
    check(
      afterTest.sent === 0 &&
        afterTest.to_send === 0 &&
        afterTest.status === "draft" &&
        afterTest.subject === "Stored" &&
        afterTest.views === 1 &&
        afterTest.clicks === 1,
      "test-counters",
    );
    const plainSent = await call(`/api/campaigns/${testCampaign.id}/test`, "POST", {
      name: testCampaign.name,
      subject: `${marker} Plain`,
      lists: [news.id],
      messenger: "email",
      content_type: "plain",
      body: `Plain ${tpl.name} <b>`,
      subscribers: [bob.email],
    });
    check(plainSent.status === 200, "test-plain");
    const plainMail = await received(`${marker} Plain`);
    check(plainMail.length === 1, "test-plain-received");
    const plainMessage = await mailpit.message(plainMail[0]!.ID);
    check(
      plainMessage.HTML === "" && plainMessage.Text.includes("Plain Bob Other <b>"),
      "test-plain-message",
    );
    const testFailure = async (input: object, expected: string, label: string) => {
      const response = await call(`/api/campaigns/${testCampaign.id}/test`, "POST", {
        name: "t",
        subject: "t",
        lists: [news.id],
        messenger: "email",
        ...input,
      });
      check(response.status === 400 && message(response) === expected, label);
    };
    await testFailure(
      { subscribers: [] },
      "There are no subscribers to target.",
      "test-no-subscribers",
    );
    await testFailure(
      { subscribers: [`nobody-${marker}@example.test`] },
      "No known subscribers to test.",
      "test-unknown-subscribers",
    );
    await testFailure({ subscribers: [ada.email], lists: [] }, "Invalid list IDs.", "test-lists");
    await testFailure(
      { subscribers: [ada.email], messenger: "" },
      "Unknown messenger .",
      "test-messenger",
    );

    // List-scoped permissions.
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
    const scopeNews = await create(
      { name: `${marker} scope news`, subject: "s", lists: [news.id] },
      "scope-news",
    );
    const scopeOther = await create(
      { name: `${marker} scope other`, subject: "s", lists: [other.id] },
      "scope-other",
    );
    const reader = await apiUser(
      "reader",
      ["campaigns:get"],
      [{ id: news.id, permissions: ["list:get"] }],
    );
    const manager = await apiUser(
      "manager",
      ["campaigns:get", "campaigns:manage"],
      [{ id: news.id, permissions: ["list:manage"] }],
    );
    const nobody = await apiUser("nobody", ["subscribers:get"], []);
    const sender = await apiUser(
      "sender",
      ["campaigns:send"],
      [{ id: news.id, permissions: ["list:get"] }],
    );
    // D-campaign-link-scope: the campaign redirect follows only links registered by that
    // campaign's content. Upstream redirects any registered link, so a tx:send-only account
    // can register a URL through track_link in a tx subject and replay its link UUID with a
    // received campaign UUID: an anonymous open redirect (307) on the campaign domain.
    if (!reference) {
      const txSender = await apiUser("txsender", ["tx:send"], []);
      const txTemplate = await call("/api/templates", "POST", {
        name: `${marker} tx`,
        type: "tx",
        subject: "fixed",
        body: "<p>fixed</p>",
      });
      check(txTemplate.status === 200, "tx-template-create");
      owned.templates.push(txTemplate.body.data.id);
      const txSent = await call(
        "/api/tx",
        "POST",
        {
          subscriber_email: ada.email,
          template_id: txTemplate.body.data.id,
          subject: `${marker} tx {{ "https://attacker.example/phish" | track_link }}`,
        },
        txSender,
      );
      check(txSent.status === 200, "tx-link-send");
      const deadline = Date.now() + 10_000;
      let txSubject: string | undefined;
      while (!txSubject && Date.now() < deadline) {
        txSubject = (await mailpit.list()).find((m) =>
          m.Subject.startsWith(`${marker} tx `),
        )?.Subject;
        if (!txSubject) await Bun.sleep(25);
      }
      const txLink = /\/link\/([0-9a-f-]{36})/.exec(txSubject ?? "")?.[1];
      check(txLink, "tx-link-registered");
      const replay = await fetch(
        `${rootUrl}/link/${txLink}/${testCampaign.uuid}/00000000-0000-0000-0000-000000000000`,
        { redirect: "manual", signal: AbortSignal.timeout(20_000) },
      );
      check(
        replay.status === 404 && replay.headers.get("location") === null,
        "link-other-registration",
      );
    }
    const denied = async (
      response: { status: number; body: any },
      expected: string,
      label: string,
    ) => check(response.status === 403 && message(response) === expected, label);
    await denied(
      await call("/api/campaigns", "GET", undefined, nobody),
      "permission denied: campaigns:get",
      "perm-route",
    );
    const visible = (
      await call(`/api/campaigns?query=${marker}%20scope&per_page=all`, "GET", undefined, reader)
    ).body.data.results as Campaign[];
    check(visible.length === 1 && visible[0]!.id === scopeNews.id, "perm-collection-scope");
    check(
      (await call(`/api/campaigns/${scopeNews.id}`, "GET", undefined, reader)).status === 200,
      "perm-get",
    );
    await denied(
      await call(`/api/campaigns/${scopeOther.id}`, "GET", undefined, reader),
      "Permission denied: campaigns:get",
      "perm-get-other",
    );
    await denied(
      await call(`/api/campaigns/${scopeOther.id}/preview`, "GET", undefined, reader),
      "Permission denied: campaigns:get",
      "perm-preview-other",
    );
    await denied(
      await call(
        `/api/campaigns/${scopeNews.id}`,
        "PUT",
        { name: "x", subject: "s", lists: [news.id] },
        reader,
      ),
      "permission denied: campaigns:manage",
      "perm-update-route",
    );
    const managed = await call(
      `/api/campaigns/${scopeNews.id}`,
      "PUT",
      { name: `${marker} scope news`, subject: "s", lists: [news.id, other.id] },
      manager,
    );
    check(
      managed.status === 200 &&
        JSON.stringify(managed.body.data.lists.map((l: any) => l.id)) === `[${news.id}]`,
      "perm-update-filters-lists",
    );
    await denied(
      await call(
        `/api/campaigns/${scopeOther.id}`,
        "PUT",
        { name: "x", subject: "s", lists: [news.id] },
        manager,
      ),
      "Permission denied: campaigns:manage",
      "perm-update-other",
    );
    const unmanaged = await call(
      "/api/campaigns",
      "POST",
      { name: `${marker} x`, subject: "s", lists: [other.id] },
      manager,
    );
    if (unmanaged.status === 200) owned.campaigns.push(unmanaged.body.data.id);
    check(
      unmanaged.status === 400 && message(unmanaged) === "Invalid list IDs.",
      "perm-create-filters-lists",
    );
    await denied(
      await call(`/api/campaigns/${scopeNews.id}/status`, "PUT", { status: "running" }, sender),
      "Permission denied: campaigns:manage",
      "perm-status-manage",
    );
    await denied(
      await call(`/api/campaigns/${scopeNews.id}/status`, "PUT", { status: "running" }, manager),
      "permission denied: campaigns:send",
      "perm-status-route",
    );
    await denied(
      await call(
        `/api/campaigns/${scopeNews.id}/content`,
        "POST",
        { body: "# x", from: "markdown", to: "html" },
        reader,
      ),
      "permission denied: campaigns:manage",
      "perm-content-route",
    );
    const scopedTest = await call(
      `/api/campaigns/${scopeNews.id}/test`,
      "POST",
      {
        name: "t",
        subject: `${marker} scoped`,
        lists: [news.id],
        messenger: "email",
        subscribers: [bob.email],
      },
      manager,
    );
    check(
      scopedTest.status === 400 && message(scopedTest) === "No known subscribers to test.",
      "perm-test-subscribers",
    );
    check(
      (await call(`/api/campaigns?id=${scopeOther.id}`, "DELETE", undefined, manager)).status ===
        200 && (await call(`/api/campaigns/${scopeOther.id}`)).status === 200,
      "perm-bulk-delete-scope",
    );
    await denied(
      await call(`/api/campaigns/${scopeOther.id}`, "DELETE", undefined, manager),
      "Permission denied: campaigns:manage",
      "perm-delete-other",
    );

    // Restart keeps campaigns.
    if (target.restart) {
      await target.restart();
      check(JSON.stringify((await get(full.id)).lists) === JSON.stringify(full.lists), "restart");
    }

    // Deletion.
    const deleteMissing = await call("/api/campaigns/2000000000", "DELETE");
    check(
      deleteMissing.status === 400 && message(deleteMissing) === "Campaign not found",
      "delete-missing",
    );
    const bulkRefused = async (query: string, expected: string, label: string) => {
      const response = await call(`/api/campaigns${query}`, "DELETE");
      check(response.status === 400 && message(response) === expected, label);
    };
    await bulkRefused("", "One or more IDs are invalid: id or query required", "bulk-none");
    await bulkRefused(
      "?id=abc",
      'One or more IDs are invalid: strconv.Atoi: parsing "abc": invalid syntax',
      "bulk-invalid",
    );
    await bulkRefused("?id=0", "One or more IDs are invalid: 0 is not a valid ID", "bulk-zero");
    const delA = await create({ name: `${marker} del-a`, subject: "s", lists: [news.id] }, "del-a");
    const delB = await create({ name: `${marker} del-b`, subject: "s", lists: [news.id] }, "del-b");
    check(
      (await call(`/api/campaigns?id=${delA.id}&id=2000000000`, "DELETE")).status === 200 &&
        (await call(`/api/campaigns/${delA.id}`)).status === 400 &&
        (await call(`/api/campaigns/${delB.id}`)).status === 200,
      "bulk-ids",
    );
    check(
      (await call(`/api/campaigns?query=${marker}%20del-b`, "DELETE")).status === 200 &&
        (await call(`/api/campaigns/${delB.id}`)).status === 400,
      "bulk-query",
    );
    // A paused campaign (and upstream, a running one) can be deleted.
    check((await call(`/api/campaigns/${run.id}`, "DELETE")).status === 200, "delete-cancelled");
    check((await call(`/api/campaigns/${run.id}`)).status === 400, "deleted");
  } finally {
    for (const id of owned.campaigns) {
      const response = await call(`/api/campaigns/${id}`, "DELETE");
      if (response.status !== 200 && response.status !== 400) cleanupFailed = true;
    }
    for (const id of owned.users)
      if ((await call(`/api/users/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    for (const id of owned.roles.reverse())
      if ((await call(`/api/roles/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    for (const id of owned.templates)
      if ((await call(`/api/templates/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    for (const id of owned.subscribers)
      if ((await call(`/api/subscribers/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    for (const id of owned.lists)
      if ((await call(`/api/lists/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    await mailpit.removeOwned();
  }
  if (cleanupFailed) throw new Error("FAIL campaigns-cleanup");
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
    await runCampaignsContract({ mode: "reference", baseUrl, credentials: { user, token } });
    process.stdout.write("PASS campaigns reference contract\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-]+$/.test(error.message) ? error.message : `Campaigns contract failed: ${error instanceof Error ? error.message : ""}`}\n`,
    );
    process.exitCode = 1;
  }
}
