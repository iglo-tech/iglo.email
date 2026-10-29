// Reference: listmonk cmd/public.go (SubscriptionPage, SubscriptionPrefs, LinkRedirect,
// RegisterCampaignView), cmd/handlers.go (hasUUID, hasSub, noIndex) and
// internal/manager/manager.go (List-Unsubscribe headers, TrackLink, TrackView) at 6fcd95f.
// Production-only: listmonk has no marketing tx sends or /m/:sendUUID pages, so these
// native routes are checked against upstream-derived results, through mail received by
// the invocation-owned Mailpit (docs/design/04-sending.md, 07-api-and-ui.md).
import { randomBytes } from "node:crypto";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { header } from "@/test/perf/runtime-compat/smtp-expect";
import type { Credentials } from "@/test/contract/types";

type SendRow = { id: number; uuid: string; status: string };

export async function runUnsubscribeContract(target: {
  baseUrl: string;
  credentials: Credentials;
  restart?: () => Promise<void>;
}) {
  const sink = referenceMailpit(process.env);
  await assertOwnedMailpit(sink);
  const marker = `m08${randomBytes(10).toString("hex")}`;
  const mailpit = new Mailpit(sink, marker);
  const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL unsubscribe-${label}`);
  };
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  // Public pages are fetched like a browser or mail provider: no credentials.
  const visit = (url: string, init: RequestInit = {}) =>
    fetch(url, { redirect: "manual", ...init, signal: AbortSignal.timeout(20_000) });
  const received = async (subject: string) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = (await mailpit.list()).filter((m) => m.Subject === subject);
      if (found.length || Date.now() > deadline) return found;
      await Bun.sleep(25);
    }
  };
  const membership = async (subscriber: number, list: number) =>
    (await api(`/api/subscribers/${subscriber}`)).body.data.lists.find(
      (l: { id: number }) => l.id === list,
    )?.subscription_status as string | undefined;

  const owned = { templates: [] as number[], subscribers: [] as number[], lists: [] as number[] };
  let cleanupFailed = false;
  try {
    const current = await api("/api/settings");
    check(current.status === 200, "settings-get");
    check(current.body.data["marketing.min_interval"] === "P7D", "cap-default");
    const smtp = [
      {
        ...current.body.data.smtp[0],
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
    check((await api("/api/settings/smtp", "PUT", smtp)).status === 200, "smtp-settings");
    // The native cap setting validates as ISO 8601 and survives listmonk-shaped full writes.
    check(
      (await api("/api/settings/marketing.min_interval", "PUT", "7 days")).status === 400,
      "cap-invalid",
    );
    check(
      (await api("/api/settings/marketing.min_interval", "PUT", "P2D")).status === 200,
      "cap-set",
    );
    const full = (await api("/api/settings")).body.data;
    delete full["marketing.min_interval"];
    check((await api("/api/settings", "PUT", full)).status === 200, "full-put");
    check(
      (await api("/api/settings")).body.data["marketing.min_interval"] === "P2D",
      "cap-preserved",
    );

    const list = async (name: string, optin: string) => {
      const response = await api("/api/lists", "POST", {
        name: `${marker} ${name}`,
        type: "public",
        optin,
      });
      check(response.status === 200, "list-create");
      owned.lists.push(response.body.data.id);
      return response.body.data.id as number;
    };
    const subscriber = async (name: string, lists: number[]) => {
      const response = await api("/api/subscribers", "POST", {
        email: `${name}-${marker}@example.test`,
        name,
        lists,
      });
      check(response.status === 200, "subscriber-create");
      owned.subscribers.push(response.body.data.id);
      return { id: response.body.data.id as number, uuid: response.body.data.uuid as string };
    };
    const news = await list("news", "single");
    const other = await list("other", "single");
    const double = await list("double", "double");
    const ada = await subscriber("ada", [news, other]);
    const bob = await subscriber("bob", [news]);
    const carol = await subscriber("carol", [double]);
    const templateResponse = await api("/api/templates", "POST", {
      name: `${marker} marketing`,
      type: "tx",
      subject: `${marker} {{ data.n }}`,
      body: `<p>Hi {{ subscriber.name }} <a href="{{ unsubscribe_url }}">Unsubscribe</a> <a href="{{ "https://example.test/offer?a=1&b=2" | track_link }}">Offer</a></p>{{ track_view }}`,
    });
    check(templateResponse.status === 200, "template-create");
    const template = templateResponse.body.data.id as number;
    owned.templates.push(template);
    const send = async (to: number, list: number, n: string) => {
      const response = await api("/api/tx", "POST", {
        subscriber_id: to,
        template_id: template,
        kind: "marketing",
        list_id: list,
        data: { n },
      });
      check(response.status === 200, `tx-${n}`);
      const row = response.body.data.sends[0] as SendRow;
      const journal = (await api(`/api/sends/${row.id}`)).body.data;
      return { ...row, skip_reason: journal.skip_reason as string | null };
    };

    // A received marketing message carries the link, the RFC 8058 pair and tracking.
    const first = await send(ada.id, news, "A1");
    check(first.status === "sent", "sent");
    const [mail] = await received(`${marker} A1`);
    check(mail, "mail-received");
    const raw = await mailpit.raw(mail!.ID);
    const html = (await mailpit.message(mail!.ID)).HTML;
    const unsubscribe = `${target.baseUrl}/m/${first.uuid}/unsubscribe/${ada.uuid}`;
    check(header(raw, "List-Unsubscribe") === `<${unsubscribe}>`, "list-unsubscribe");
    check(header(raw, "List-Unsubscribe-Post") === "List-Unsubscribe=One-Click", "one-click");
    check(html.includes(`<a href="${unsubscribe}">Unsubscribe</a>`), "body-link");
    const offer = new RegExp(
      `<a href="(${target.baseUrl.replace(/[.]/g, "\\.")}/m/${first.uuid}/link/[0-9a-f-]{36})">Offer</a>`,
    ).exec(html)?.[1];
    check(offer, "tracked-link");
    check(html.includes(`<img src="${target.baseUrl}/m/${first.uuid}/px.png"`), "pixel");

    // Consent and cap skips never reach Mailpit.
    check((await send(carol.id, double, "C1")).skip_reason === "unconfirmed", "skip-unconfirmed");
    const stranger = await api("/api/tx", "POST", {
      subscriber_email: `stranger-${marker}@example.test`,
      template_id: template,
      kind: "marketing",
      list_id: news,
      data: { n: "S1" },
    });
    check(stranger.body.data.sends[0].status === "skipped", "skip-stranger");
    check((await send(ada.id, other, "A2")).skip_reason === "frequency_cap", "skip-cap");
    await Bun.sleep(200);
    const subjects = (await mailpit.list()).map((m) => m.Subject);
    check(
      !subjects.includes(`${marker} C1`) &&
        !subjects.includes(`${marker} S1`) &&
        !subjects.includes(`${marker} A2`),
      "skips-no-mail",
    );

    // Tracking: an upstream-style 307 redirect and a no-cache PNG pixel.
    const redirect = await visit(offer!);
    check(
      redirect.status === 307 &&
        redirect.headers.get("location") === "https://example.test/offer?a=1&b=2" &&
        redirect.headers.get("x-robots-tag") === "noindex",
      "redirect",
    );
    const pixel = await visit(`${target.baseUrl}/m/${first.uuid}/px.png`);
    check(
      pixel.status === 200 &&
        pixel.headers.get("content-type") === "image/png" &&
        pixel.headers.get("cache-control") === "no-cache",
      "pixel-response",
    );

    // Unsubscribe through the link: the page confirms, its form posts.
    const page = await visit(unsubscribe);
    const pageHtml = await page.text();
    check(
      page.status === 200 &&
        page.headers.get("x-robots-tag") === "noindex" &&
        pageHtml.includes('<form method="post" class="unsub-form">') &&
        pageHtml.includes('name="blocklist"'),
      "page",
    );
    check((await membership(ada.id, news)) === "unconfirmed", "page-no-change");
    // A forged pairing (bob's subscriber UUID on ada's send) changes nothing.
    const forged = await visit(`${target.baseUrl}/m/${first.uuid}/unsubscribe/${bob.uuid}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    check(forged.status === 404 && (await membership(bob.id, news)) === "unconfirmed", "forged");
    const submitted = await visit(unsubscribe, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    check(
      submitted.status === 200 &&
        (await submitted.text()).includes("You have unsubscribed successfully."),
      "page-post",
    );
    check(
      (await membership(ada.id, news)) === "unsubscribed" &&
        (await membership(ada.id, other)) === "unconfirmed",
      "page-scoped",
    );

    // Unsubscribe through RFC 8058 one-click, using the received header as a provider would.
    const second = await send(bob.id, news, "B1");
    check(second.status === "sent", "bob-sent");
    const [bobMail] = await received(`${marker} B1`);
    check(bobMail, "bob-received");
    const oneClick = header(await mailpit.raw(bobMail!.ID), "List-Unsubscribe").slice(1, -1);
    const posted = await visit(oneClick, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    check(posted.status === 200, "one-click-post");
    check((await membership(bob.id, news)) === "unsubscribed", "one-click-scoped");

    // Unsubscribed members are skipped, and the state survives a restart.
    check((await api("/api/settings/marketing.min_interval", "PUT", "")).status === 200, "no-cap");
    check((await send(bob.id, news, "B2")).skip_reason === "unsubscribed", "skip-unsubscribed");
    if (target.restart) {
      await target.restart();
      check((await membership(bob.id, news)) === "unsubscribed", "restart");
      check((await send(ada.id, other, "A3")).status === "sent", "restart-send");
    }
  } finally {
    for (const id of owned.subscribers)
      if ((await api(`/api/subscribers/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    for (const id of owned.lists)
      if ((await api(`/api/lists/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    for (const id of owned.templates)
      if ((await api(`/api/templates/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    await mailpit.removeOwned();
  }
  if (cleanupFailed) throw new Error("FAIL unsubscribe-cleanup");
}
