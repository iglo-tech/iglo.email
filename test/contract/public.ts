// Reference: listmonk cmd/public.go, cmd/archive.go, cmd/handlers.go (public routes, hasUUID,
// hasSub, noIndex, serveCustomAppearance), cmd/subscribers.go (makeOptinNotifyHook,
// SubscriberSendOptin, exportSubscriberData), internal/core/subscribers.go and
// static/public/templates at 6fcd95f. Shared results run against both the pinned reference
// and the compiled executable; declared differences are marked D-public-… below and listed
// in docs/design/07-api-and-ui.md. Mail is read from the invocation-owned Mailpit.
import { randomBytes } from "node:crypto";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { header } from "@/test/perf/runtime-compat/smtp-expect";
import { settingsFetch } from "@/test/contract/settings-reference-fetch";
import type { Credentials, Mode } from "@/test/contract/types";

const uuidText = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const dummy = "00000000-0000-0000-0000-000000000000";
const missing = "11111111-1111-4111-8111-111111111111";
const form = { "content-type": "application/x-www-form-urlencoded" };
const decodeEntities = (html: string) =>
  html.replaceAll("&amp;", "&").replaceAll("&#43;", "+").replaceAll("&#x2B;", "+");

export async function runPublicContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
  restart?: () => Promise<void>;
}) {
  const reference = target.mode === "reference";
  const sink = referenceMailpit(process.env);
  await assertOwnedMailpit(sink);
  const marker = `m25${randomBytes(8).toString("hex")}`;
  const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL public-${label}`);
  };
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await settingsFetch(
      `${target.baseUrl}${path}`,
      {
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      },
      reference,
    );
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* Not JSON. */
    }
    return { status: response.status, body: parsed, text };
  };
  // Public pages are fetched like a browser or mail provider: no credentials.
  const visit = async (path: string, init: RequestInit = {}) => {
    const response = await settingsFetch(
      path.startsWith("http") ? path : `${target.baseUrl}${path}`,
      { redirect: "manual", ...init, signal: AbortSignal.timeout(20_000) },
      reference,
    );
    return {
      status: response.status,
      headers: response.headers,
      text: await response.text(),
    };
  };
  const post = (path: string, body: string | URLSearchParams = "") =>
    visit(path, { method: "POST", headers: form, body: body.toString() });
  const postJson = (path: string, body: unknown) =>
    visit(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const mailpit = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${sink.api}${path}`, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`FAIL public-mailpit-${response.status}`);
    return response;
  };
  const mails = async (address: string) => {
    const query = new URLSearchParams({
      query: `to:"${address}"`,
      limit: "50",
    });
    const found = (await (await mailpit(`/api/v1/search?${query}`)).json()) as {
      messages: { ID: string; Subject: string }[];
    };
    return found.messages;
  };
  const received = async (address: string, count = 1) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = await mails(address);
      if (found.length >= count || Date.now() > deadline) return found;
      await Bun.sleep(25);
    }
  };
  const message = async (id: string) =>
    (await (await mailpit(`/api/v1/message/${encodeURIComponent(id)}`)).json()) as {
      HTML: string;
      Attachments: { PartID: string; FileName: string; ContentType: string }[];
    };
  const raw = async (id: string) =>
    await (await mailpit(`/api/v1/message/${encodeURIComponent(id)}/raw`)).text();
  const owned = {
    lists: [] as number[],
    subscribers: new Set<number>(),
    campaigns: [] as number[],
    addresses: [] as string[],
  };
  const address = (name: string) => {
    const value = `${name}-${marker}@example.test`;
    owned.addresses.push(value);
    return value;
  };
  /** Find a public signup's subscriber through the admin API and own it. */
  const adminSubscriber = async (email: string) => {
    const query = new URLSearchParams({
      query: `subscribers.email = '${email}'`,
      per_page: "1",
    });
    const found = (await call(`/api/subscribers?${query}`)).body?.data?.results?.[0];
    if (found) owned.subscribers.add(found.id);
    return found as {
      id: number;
      uuid: string;
      name: string;
      status: string;
      lists: any[];
    };
  };
  const membership = async (id: number, list: number) =>
    (await call(`/api/subscribers/${id}`)).body?.data?.lists?.find(
      (l: { id: number }) => l.id === list,
    );
  const status = async (id: number, list: number) =>
    (await membership(id, list))?.subscription_status as string | undefined;
  const createList = async (name: string, type: string, optin: string) => {
    const response = await call("/api/lists", "POST", {
      name: `${marker} ${name}`,
      type,
      optin,
    });
    check(response.status === 200, `list-${name}`);
    owned.lists.push(response.body.data.id);
    return response.body.data as { id: number; uuid: string; name: string };
  };
  const createSubscriber = async (name: string, lists: number[], preconfirm = false) => {
    const email = address(name);
    const response = await call("/api/subscribers", "POST", {
      email,
      name,
      lists,
      preconfirm_subscriptions: preconfirm,
    });
    check(response.status === 200, `subscriber-${name}`);
    owned.subscribers.add(response.body.data.id);
    return {
      id: response.body.data.id as number,
      uuid: response.body.data.uuid as string,
      email,
    };
  };
  const setSetting = async (key: string, value: unknown) => {
    const response = await call(`/api/settings/${key}`, "PUT", value);
    check(response.status === 200, `setting-${key}`);
    // Upstream reloads asynchronously after a settings write.
    if (reference) {
      await Bun.sleep(1200);
      for (const deadline = Date.now() + 15_000; Date.now() < deadline; await Bun.sleep(100)) {
        try {
          const health = await fetch(`${target.baseUrl}/health`, {
            signal: AbortSignal.timeout(1000),
          });
          if (health.ok) break;
        } catch {
          /* Still reloading. */
        }
      }
    }
  };
  const originals = new Map<string, unknown>();
  const withSetting = async (key: string, value: unknown, run: () => Promise<void>) => {
    const settings = (await call("/api/settings")).body.data;
    originals.set(key, settings[key]);
    await setSetting(key, value);
    try {
      await run();
    } finally {
      await setSetting(key, originals.get(key));
      originals.delete(key);
    }
  };

  let cleanupFailed = false;
  try {
    const settings = (await call("/api/settings")).body.data;
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
    const rootUrl = (settings["app.root_url"] as string).replace(/\/+$/, "");
    const single = await createList("single", "public", "single");
    const double = await createList("double", "public", "double");
    const hidden = await createList("hidden", "private", "single");
    const hiddenDouble = await createList("hidden-double", "private", "double");

    // GET /api/public/lists: minimal fields, public lists only.
    const lists = await visit("/api/public/lists");
    const listed = JSON.parse(lists.text) as Record<string, unknown>[];
    check(
      lists.status === 200 &&
        listed.some((l) => l.uuid === single.uuid && l.name === single.name) &&
        listed.some((l) => l.uuid === double.uuid) &&
        !listed.some((l) => l.uuid === hidden.uuid || l.uuid === hiddenDouble.uuid) &&
        listed.every((l) => Object.keys(l).sort().join() === "name,uuid"),
      "lists",
    );
    check(
      (await visit("/api/public/captcha/altcha")).status === 404 &&
        JSON.parse((await visit("/api/public/captcha/altcha")).text).message ===
          "captcha not enabled",
      "altcha-disabled",
    );

    // The form page lists public lists only and carries the bot field.
    const page = await visit("/subscription/form");
    check(
      page.status === 200 &&
        page.headers.get("content-type")?.toLowerCase().startsWith("text/html") &&
        page.text.includes('<form method="post"') &&
        page.text.includes('name="email"') &&
        page.text.includes('name="nonce"') &&
        page.text.includes(`value="${single.uuid}"`) &&
        page.text.includes(`value="${double.uuid}"`) &&
        !page.text.includes(hidden.uuid) &&
        !page.text.includes(hidden.name),
      "form-page",
    );

    // JSON signup to a single opt-in list.
    const adaEmail = address("ada");
    const ada = await postJson("/api/public/subscription", {
      email: adaEmail,
      name: "Ada",
      list_uuids: [single.uuid],
    });
    check(ada.status === 200 && JSON.parse(ada.text).data.has_optin === false, "api-single");
    const adaRow = await adminSubscriber(adaEmail);
    check(
      adaRow?.name === "Ada" &&
        adaRow.status === "enabled" &&
        (await status(adaRow.id, single.id)) === "unconfirmed",
      "api-single-stored",
    );
    check((await mails(adaEmail)).length === 0, "api-single-no-mail");

    // A missing name becomes the raw local part, not the admin title-cased default.
    const lowEmail = address("low.part");
    check(
      (
        await postJson("/api/public/subscription", {
          email: lowEmail,
          list_uuids: [single.uuid],
        })
      ).status === 200,
      "api-no-name",
    );
    check((await adminSubscriber(lowEmail))?.name === lowEmail.split("@")[0], "api-no-name-stored");

    // Double opt-in: unconfirmed, confirmation mail, then the link confirms.
    const bobEmail = address("bob");
    const bob = await postJson("/api/public/subscription", {
      email: bobEmail,
      name: "Bob Builder",
      list_uuids: [double.uuid],
    });
    check(bob.status === 200 && JSON.parse(bob.text).data.has_optin === true, "api-double");
    const bobRow = await adminSubscriber(bobEmail);
    check((await status(bobRow.id, double.id)) === "unconfirmed", "api-double-unconfirmed");
    const [bobMail] = await received(bobEmail);
    check(bobMail?.Subject === "Confirm subscription", "optin-subject");
    const bobHtml = decodeEntities((await message(bobMail!.ID)).HTML);
    const bobRaw = await raw(bobMail!.ID);
    const optinLink = new RegExp(`href="([^"]*/subscription/optin/${uuidText}\\?[^"]*)"`).exec(
      bobHtml,
    )?.[1];
    check(optinLink === `${rootUrl}/subscription/optin/${bobRow.uuid}?l=${double.uuid}`, "link");
    check(bobHtml.includes("Hi Bob"), "optin-greeting");
    check(bobHtml.includes(double.name), "optin-list-name");
    check(
      bobHtml.includes(`${rootUrl}/subscription/${dummy}/${bobRow.uuid}?manage=true`),
      "optin-manage-link",
    );
    check(
      header(bobRaw, "X-Listmonk-Subscriber") === bobRow.uuid &&
        header(bobRaw, "List-Unsubscribe") ===
          `<${rootUrl}/subscription/${dummy}/${bobRow.uuid}>` &&
        header(bobRaw, "List-Unsubscribe-Post") === "List-Unsubscribe=One-Click",
      "optin-headers",
    );

    // A repeated signup for the same pending lists is throttled to one mail.
    const again = await postJson("/api/public/subscription", {
      email: bobEmail,
      name: "Another Name",
      list_uuids: [double.uuid],
    });
    check(again.status === 200 && JSON.parse(again.text).data.has_optin === true, "api-repeat");
    await Bun.sleep(200);
    check((await mails(bobEmail)).length === 1, "optin-throttled");
    // An existing subscriber's stored name is not overwritten by a public request.
    check((await adminSubscriber(bobEmail)).name === "Bob Builder", "api-repeat-name");

    // GET shows the page and never confirms.
    const optinPath = optinLink!.slice(rootUrl.length);
    const optinPage = await visit(optinPath);
    check(
      optinPage.status === 200 &&
        optinPage.headers.get("x-robots-tag") === "noindex" &&
        optinPage.text.includes('class="optin-form"') &&
        optinPage.text.includes(`value="${double.uuid}"`) &&
        optinPage.text.includes('name="confirm"') &&
        optinPage.text.includes(double.name),
      "optin-page",
    );
    check((await status(bobRow.id, double.id)) === "unconfirmed", "optin-get-no-change");
    // A POST without confirm shows the same page.
    check(
      (await post(optinPath)).text.includes('class="optin-form"') &&
        (await status(bobRow.id, double.id)) === "unconfirmed",
      "optin-post-unconfirmed",
    );
    // A hostile prefetch with confirm in the query (D-public-get-confirm).
    const prefetch = await visit(`${optinPath}&confirm=true`);
    if (reference) {
      check((await status(bobRow.id, double.id)) === "confirmed", "reference-get-confirm");
      check(
        (
          await call(`/api/subscribers/lists/${bobRow.id}`, "PUT", {
            ids: [bobRow.id],
            action: "add",
            target_list_ids: [double.id],
            status: "unconfirmed",
          })
        ).status === 200,
        "reference-reset",
      );
    } else {
      check(
        prefetch.status === 200 && (await status(bobRow.id, double.id)) === "unconfirmed",
        "optin-get-query-no-change",
      );
    }
    // Malformed list filter and identifiers.
    check((await visit(`/subscription/optin/${bobRow.uuid}?l=nope`)).status === 400, "optin-bad-l");
    check((await visit("/subscription/optin/not-a-uuid")).status === 400, "optin-bad-uuid");
    check((await visit(`/subscription/optin/${missing}`)).status === 404, "optin-missing");
    check((await post(`/subscription/optin/${missing}`, "confirm=true")).status === 404, "forged");
    // Confirm.
    const confirmed = await post(
      `/subscription/optin/${bobRow.uuid}`,
      new URLSearchParams({ confirm: "true", l: double.uuid }),
    );
    check(
      confirmed.status === 200 &&
        confirmed.text.includes("Subscribed successfully.") &&
        (await status(bobRow.id, double.id)) === "confirmed",
      "optin-confirm",
    );
    const none = await visit(`/subscription/optin/${bobRow.uuid}`);
    check(
      none.status === 200 && none.text.includes("There are no subscriptions to confirm."),
      "optin-none",
    );

    // Existing subscribers are not revealed (D-public-enumeration): a confirmed one signing
    // up to the same double opt-in list gets a new address's answer; upstream says false.
    const repeat = await postJson("/api/public/subscription", {
      email: bobEmail,
      list_uuids: [double.uuid],
    });
    check(
      repeat.status === 200 && JSON.parse(repeat.text).data.has_optin === !reference,
      "api-existing-confirmed",
    );
    check((await status(bobRow.id, double.id)) === "confirmed", "api-existing-stays-confirmed");

    // An unsubscribed membership resubscribes as unconfirmed; only a public signup can.
    const carol = await createSubscriber("carol", [single.id], true);
    check(
      (await post(`/subscription/${dummy}/${carol.uuid}`)).status === 200,
      "dummy-unsubscribe-page",
    );
    check((await status(carol.id, single.id)) === "confirmed", "dummy-keeps-confirmed");
    check(
      (
        await call(`/api/subscribers/lists/${carol.id}`, "PUT", {
          ids: [carol.id],
          action: "unsubscribe",
          target_list_ids: [single.id],
        })
      ).status === 200,
      "carol-unsubscribe",
    );
    check(
      (
        await postJson("/api/public/subscription", {
          email: carol.email,
          list_uuids: [single.uuid],
        })
      ).status === 200 && (await status(carol.id, single.id)) === "unconfirmed",
      "api-resubscribe",
    );

    // A blocklisted subscriber stays blocked, gets no mail and is not revealed.
    const dora = await createSubscriber("dora", []);
    check((await call(`/api/subscribers/${dora.id}/blocklist`, "PUT")).status === 200, "dora");
    const doraSignup = await postJson("/api/public/subscription", {
      email: dora.email,
      list_uuids: [double.uuid],
    });
    check(
      doraSignup.status === 200 &&
        JSON.parse(doraSignup.text).data.has_optin === !reference &&
        (await status(dora.id, double.id)) === "unsubscribed" &&
        (await adminSubscriber(dora.email)).status === "blocklisted",
      "api-blocklisted",
    );
    await Bun.sleep(200);
    check((await mails(dora.email)).length === 0, "blocklisted-no-mail");

    // Input errors.
    const fail = async (body: unknown, code: number, text: string, label: string) => {
      const response = await postJson("/api/public/subscription", body);
      check(response.status === code && JSON.parse(response.text).message === text, label);
    };
    await fail(
      { email: address("none"), list_uuids: [] },
      400,
      "No valid lists selected to subscribe.",
      "api-no-lists",
    );
    await fail({ email: "bad", list_uuids: [single.uuid] }, 400, "Invalid email.", "api-email");
    await fail(
      { email: `${"a".repeat(1001)}@example.test`, list_uuids: [single.uuid] },
      400,
      "Invalid email.",
      "api-email-long",
    );
    await fail(
      { email: address("private"), list_uuids: [hidden.uuid] },
      400,
      "Invalid UUID(s)",
      "api-private",
    );
    await fail(
      { email: address("mixed"), list_uuids: [single.uuid, hiddenDouble.uuid] },
      400,
      "Invalid UUID(s)",
      "api-private-mixed",
    );
    await fail(
      {
        email: address("long"),
        name: "n".repeat(2001),
        list_uuids: [single.uuid],
      },
      400,
      "Invalid name.",
      "api-name-long",
    );
    // An unknown but well-formed list UUID subscribes to nothing.
    const stray = address("stray");
    const unknown = await postJson("/api/public/subscription", {
      email: stray,
      list_uuids: [missing],
    });
    check(
      unknown.status === 200 &&
        JSON.parse(unknown.text).data.has_optin === false &&
        (await adminSubscriber(stray))?.lists.length === 0,
      "api-unknown-list",
    );

    // The HTML form post, url-encoded and multipart.
    const formData = (email: string) =>
      new URLSearchParams({ email, name: "Form", nonce: "", l: double.uuid });
    const eveEmail = address("eve");
    const posted = await post("/subscription/form", formData(eveEmail));
    check(
      posted.status === 200 &&
        posted.text.includes("An e-mail has been sent to you to confirm your subscription(s)."),
      "form-optin",
    );
    const eveRow = await adminSubscriber(eveEmail);
    check(eveRow?.name === "Form", "form-stored");
    const fredEmail = address("fred");
    const multipart = new FormData();
    multipart.set("email", fredEmail);
    multipart.append("l", single.uuid);
    multipart.append("l", double.uuid);
    const posted2 = await visit("/subscription/form", {
      method: "POST",
      body: multipart,
    });
    check(posted2.status === 200, "form-multipart");
    const fredRow = await adminSubscriber(fredEmail);
    check(fredRow?.lists.length === 2, "form-multipart-lists");
    await received(fredEmail);
    const [fredMail] = await mails(fredEmail);
    const fredHtml = decodeEntities((await message(fredMail!.ID)).HTML);
    // The confirmation names only the double opt-in list.
    check(
      fredHtml.includes(double.name) &&
        !fredHtml.includes(single.name) &&
        fredHtml.includes(`?l=${double.uuid}"`),
      "form-mail-double-only",
    );
    const gusEmail = address("gus");
    const gus = await post(
      "/subscription/form",
      new URLSearchParams({
        email: gusEmail,
        l: single.uuid,
      }),
    );
    check(gus.status === 200 && gus.text.includes("Subscribed successfully."), "form-single");
    await adminSubscriber(gusEmail);
    // Bot field: Echo's 502 JSON error.
    const bot = await post(
      "/subscription/form",
      new URLSearchParams({
        email: address("bot"),
        nonce: "x",
        l: single.uuid,
      }),
    );
    check(bot.status === 502, "form-nonce");
    check(!(await adminSubscriber(`bot-${marker}@example.test`)), "form-nonce-no-write");
    const noLists = await post("/subscription/form", new URLSearchParams({ email: eveEmail }));
    check(
      noLists.status === 400 &&
        noLists.headers.get("content-type")?.toLowerCase().startsWith("text/html") &&
        noLists.text.includes("No valid lists selected to subscribe."),
      "form-no-lists",
    );

    // Opt-in of a private double opt-in list reads as a private list.
    const henry = await createSubscriber("henry", [hiddenDouble.id]);
    const [henryMail] = await received(henry.email);
    check(henryMail?.Subject === "Confirm subscription", "admin-create-mail");
    const henryHtml = decodeEntities((await message(henryMail!.ID)).HTML);
    check(
      henryHtml.includes("Private list") && !henryHtml.includes(hiddenDouble.name),
      "admin-create-private",
    );
    check(
      (await visit(`/subscription/optin/${henry.uuid}`)).text.includes("Private list"),
      "optin-page-private",
    );
    // preconfirm_subscriptions and single opt-in lists send nothing.
    const ida = await createSubscriber("ida", [double.id], true);
    const jay = await createSubscriber("jay", [single.id]);
    await Bun.sleep(200);
    check((await mails(ida.email)).length === 0, "admin-preconfirm-no-mail");
    check((await mails(jay.email)).length === 0, "admin-single-no-mail");
    // Updating with a new double list mails for the unconfirmed one.
    check(
      (
        await call(`/api/subscribers/${jay.id}`, "PUT", {
          email: jay.email,
          name: "jay",
          lists: [single.id, double.id],
        })
      ).status === 200,
      "admin-update",
    );
    check((await received(jay.email)).length === 1, "admin-update-mail");
    // The explicit endpoint.
    check(
      (await call(`/api/subscribers/${jay.id}/optin`, "POST")).body?.data === true,
      "admin-optin",
    );
    check((await received(jay.email, 2)).length === 2, "admin-optin-mail");
    check(
      (await call(`/api/subscribers/${ida.id}/optin`, "POST")).body?.data === true,
      "admin-optin-nothing",
    );
    await Bun.sleep(200);
    check((await mails(ida.email)).length === 0, "admin-optin-no-pending");
    check(
      (await call("/api/subscribers/2000000000/optin", "POST")).status === 400,
      "admin-optin-missing",
    );

    // Preferences.
    const kim = await createSubscriber("kim", [single.id, double.id, hidden.id], true);
    const prefs = `/subscription/${dummy}/${kim.uuid}`;
    const unsubPage = await visit(prefs);
    check(
      unsubPage.status === 200 &&
        unsubPage.headers.get("x-robots-tag") === "noindex" &&
        unsubPage.text.includes('class="unsub-form"') &&
        unsubPage.text.includes('href="?manage=true"') &&
        unsubPage.text.includes('id="data-form"') &&
        unsubPage.text.includes('value="export"') &&
        unsubPage.text.includes('value="wipe"') &&
        !unsubPage.text.includes("manage-form"),
      "prefs-unsub-page",
    );
    const managePage = await visit(`${prefs}?manage=true`);
    check(
      managePage.status === 200 &&
        managePage.text.includes('class="manage-form"') &&
        managePage.text.includes('name="manage"') &&
        managePage.text.includes('value="kim"') &&
        managePage.text.includes(`value="${single.uuid}"`) &&
        managePage.text.includes(`value="${double.uuid}"`) &&
        !managePage.text.includes(hidden.uuid) &&
        !managePage.text.includes(hidden.name),
      "prefs-manage-page",
    );
    check(
      (await post(prefs, new URLSearchParams({ manage: "true", name: "  " }))).status === 400,
      "prefs-empty-name",
    );
    check(
      (await post(prefs, new URLSearchParams({ manage: "true", name: "n".repeat(257) }))).status ===
        400,
      "prefs-long-name",
    );
    const saved = await post(
      prefs,
      new URLSearchParams({
        manage: "true",
        name: " Kim Renamed ",
        l: single.uuid,
      }),
    );
    check(
      saved.status === 200 && saved.text.includes("Your preferences have been saved."),
      "prefs-saved",
    );
    check(
      (await call(`/api/subscribers/${kim.id}`)).body.data.name === "Kim Renamed" &&
        (await status(kim.id, single.id)) === "confirmed" &&
        (await status(kim.id, double.id)) === "unsubscribed" &&
        (await status(kim.id, hidden.id)) === "confirmed",
      "prefs-stored",
    );
    // The manage page lists only current subscriptions.
    check(
      !(await visit(`${prefs}?manage=true`)).text.includes(`value="${double.uuid}"`),
      "prefs-unsubscribed-hidden",
    );
    // Blocklist through the manage form.
    const lee = await createSubscriber("lee", [single.id, hidden.id], true);
    const blocked = await post(
      `/subscription/${dummy}/${lee.uuid}`,
      new URLSearchParams({ manage: "true", blocklist: "true", name: "Lee" }),
    );
    check(
      blocked.status === 200 &&
        blocked.text.includes("You have unsubscribed successfully.") &&
        (await call(`/api/subscribers/${lee.id}`)).body.data.status === "blocklisted" &&
        (await status(lee.id, hidden.id)) === "unsubscribed",
      "prefs-blocklist",
    );
    const leePage = await visit(`/subscription/${dummy}/${lee.uuid}?manage=true`);
    check(
      leePage.status === 200 && leePage.text.includes("Permanently unsubscribed."),
      "prefs-blocklisted-page",
    );
    // The dummy campaign (the opt-in mail's unsubscribe link) ends unconfirmed memberships.
    const mia = await createSubscriber("mia", [single.id, double.id]);
    await received(mia.email);
    check(
      (
        await call(`/api/subscribers/lists/${mia.id}`, "PUT", {
          ids: [mia.id],
          action: "add",
          target_list_ids: [single.id],
          status: "confirmed",
        })
      ).status === 200,
      "mia-confirm",
    );
    check((await post(`/subscription/${dummy}/${mia.uuid}`)).status === 200, "dummy-post");
    check(
      (await status(mia.id, double.id)) === "unsubscribed" &&
        (await status(mia.id, single.id)) === "confirmed",
      "dummy-unsub-unconfirmed",
    );
    // Forged UUIDs.
    check((await visit(`/subscription/${dummy}/${missing}`)).status === 404, "prefs-forged");
    check((await post(`/subscription/${dummy}/${missing}`)).status === 404, "prefs-forged-post");
    check((await visit(`/subscription/nope/${kim.uuid}`)).status === 400, "prefs-bad-camp");

    // Export: a data file by mail, nothing in the response.
    const noa = await createSubscriber("noa", [single.id, hidden.id], true);
    const exported = await post(`/subscription/export/${noa.uuid}`);
    check(
      exported.status === 200 &&
        exported.text.includes("Your data has been e-mailed to you as an attachment.") &&
        !exported.text.includes(noa.email),
      "export",
    );
    const [noaMail] = await received(noa.email);
    check(noaMail?.Subject === "Your data", "export-subject");
    const noaMessage = await message(noaMail!.ID);
    check(noaMessage.Attachments.length === 1, "export-attachment");
    const attachment = noaMessage.Attachments[0]!;
    check(
      attachment.FileName === "data.json" && attachment.ContentType.includes("application/json"),
      "export-attachment-type",
    );
    const data = JSON.parse(
      Buffer.from(
        await (
          await mailpit(
            `/api/v1/message/${encodeURIComponent(noaMail!.ID)}/part/${encodeURIComponent(attachment.PartID)}`,
          )
        ).arrayBuffer(),
      ).toString("utf8"),
    );
    check(
      data.profile[0].email === noa.email &&
        data.profile[0].uuid === noa.uuid &&
        data.subscriptions.length === 2 &&
        data.subscriptions.some((s: any) => s.name === single.name) &&
        data.subscriptions.some((s: any) => s.name === "Private list") &&
        !JSON.stringify(data).includes(hidden.name) &&
        Array.isArray(data.campaign_views) &&
        Array.isArray(data.link_clicks) &&
        // D-public-export: sends and events are native additions.
        (reference || (Array.isArray(data.sends) && Array.isArray(data.events))),
      "export-data",
    );
    check((await post(`/subscription/export/${missing}`)).status === 404, "export-forged");
    check((await post("/subscription/export/nope")).status === 400, "export-bad-uuid");

    // Wipe.
    const oli = await createSubscriber("oli", [single.id], true);
    const wiped = await post(`/subscription/wipe/${oli.uuid}`);
    check(
      wiped.status === 200 && wiped.text.includes("Your subscriptions and all associated data"),
      "wipe",
    );
    check((await call(`/api/subscribers/${oli.id}`)).status === 400, "wipe-gone");
    owned.subscribers.delete(oli.id);
    check((await post(`/subscription/wipe/${oli.uuid}`)).status === 404, "wipe-repeat");
    check((await post(`/subscription/wipe/${missing}`)).status === 404, "wipe-forged");
    if (!reference) {
      // D25: every subscriber deletion anonymizes the retained send journal.
      const created = await call("/api/templates", "POST", {
        name: `tx-${marker}`,
        type: "tx",
        subject: "Receipt",
        body: "<p>Receipt</p>",
      });
      check(created.status === 200, "wipe-template");
      const removals: [string, (who: { id: number; uuid: string }) => Promise<number>][] = [
        ["wipe", async (who) => (await post(`/subscription/wipe/${who.uuid}`)).status],
        [
          "bulk",
          async (who) =>
            (
              await call("/api/subscribers/query/delete", "POST", {
                query: `subscribers.id = ${who.id}`,
              })
            ).status,
        ],
      ];
      for (const [label, remove] of removals) {
        const who = await createSubscriber(`anon-${label}`, [single.id], true);
        const sent = await call("/api/tx", "POST", {
          subscriber_email: who.email,
          template_id: created.body.data.id,
        });
        check(sent.status === 200, `anon-${label}-send`);
        await received(who.email);
        const listed = await call(`/api/sends?subscriber_id=${who.id}`);
        const send = listed.body.data.results[0].id as number;
        check((await remove(who)) === 200, `anon-${label}-remove`);
        owned.subscribers.delete(who.id);
        const row = (await call(`/api/sends/${send}`)).body.data;
        check(
          row.to_email === "" && row.subscriber_id === null && row.status === "sent",
          `anon-${label}-row`,
        );
      }
      check(
        (await call(`/api/templates/${created.body.data.id}`, "DELETE")).status === 200,
        "anon-end",
      );
    }

    // A finished campaign: view in browser, template URLs and the archive.
    const reader = await createSubscriber("reader", [single.id], true);
    const templates = (await call("/api/templates?no_body=true")).body.data as any[];
    const archiveTemplate = templates.find((t) => t.name === "Default archive template")
      .id as number;
    const defaultTemplate = templates.find((t) => t.is_default).id as number;
    const urls = reference
      ? `<a href="{{ MessageURL }}">view</a> <a href="{{ ManageURL }}">manage</a> <a href="{{ ArchiveURL }}">all</a> <a href="{{ OptinURL }}">confirm</a> Hi {{ .Subscriber.FirstName }}`
      : `<a href="{{ message_url }}">view</a> <a href="{{ manage_url }}">manage</a> <a href="{{ archive_url }}">all</a> <a href="{{ optin_url }}">confirm</a> Hi {{ subscriber.first_name }}`;
    const created = await call("/api/campaigns", "POST", {
      name: `${marker} campaign`,
      subject: `${marker} subject`,
      lists: [single.id],
      type: "regular",
      content_type: "html",
      messenger: "email",
      from_email: settings["app.from_email"][0],
      body: urls,
      template_id: defaultTemplate,
      archive: true,
      archive_template_id: archiveTemplate,
      archive_meta: { name: "Archive Reader", email: "archive@example.test" },
      archive_slug: `${marker}-slug`,
    });
    check(created.status === 200, "campaign-create");
    const campaign = created.body.data as { id: number; uuid: string };
    owned.campaigns.push(campaign.id);

    const view = `/campaign/${campaign.uuid}/${reader.uuid}`;
    const draftView = await visit(view);
    check(
      draftView.status === 200 && draftView.headers.get("x-robots-tag") === "noindex",
      "view-draft",
    );
    // Upstream falls through to a 500 page; a forged UUID is a safe 404 here.
    check(
      (await visit(`/campaign/${campaign.uuid}/${missing}`)).status === (reference ? 500 : 404),
      "view-no-sub",
    );
    check((await visit(`/campaign/${missing}/${reader.uuid}`)).status === 404, "view-no-camp");
    check((await visit(`/campaign/nope/${reader.uuid}`)).status === 400, "view-bad-uuid");
    const notYet = await visit(`/archive/${campaign.uuid}`);
    // D-public-archive-draft: upstream publishes an unsent draft by its UUID or slug.
    check(notYet.status === (reference ? 200 : 404), "archive-draft-hidden");
    check(
      (
        await call(`/api/campaigns/${campaign.id}/status`, "PUT", {
          status: "running",
        })
      ).status === 200,
      "campaign-start",
    );
    for (const deadline = Date.now() + 30_000; ; await Bun.sleep(100)) {
      const current = (await call(`/api/campaigns/${campaign.id}`)).body.data.status;
      if (current === "finished") break;
      check(Date.now() < deadline, "campaign-finish");
    }
    const [readerMail] = (await received(reader.email)).filter(
      (m) => m.Subject === `${marker} subject`,
    );
    check(readerMail, "campaign-mail");
    const readerHtml = decodeEntities((await message(readerMail!.ID)).HTML);
    check(
      readerHtml.includes(`href="${rootUrl}/campaign/${campaign.uuid}/${reader.uuid}"`) &&
        readerHtml.includes(
          `href="${rootUrl}/subscription/${campaign.uuid}/${reader.uuid}?manage=true"`,
        ) &&
        readerHtml.includes(`href="${rootUrl}/archive"`) &&
        // Upstream appends an empty query mark; the link resolves identically.
        readerHtml.includes(
          `href="${rootUrl}/subscription/optin/${reader.uuid}${reference ? "?" : ""}"`,
        ),
      "campaign-urls",
    );
    const viewed = await visit(view);
    check(
      viewed.status === 200 &&
        viewed.headers.get("content-type")?.toLowerCase().startsWith("text/html") &&
        viewed.text.includes(`/campaign/${campaign.uuid}/${reader.uuid}`) &&
        viewed.text.includes("Hi reader"),
      "view",
    );

    // Archive API, list page, feed, single and latest pages. Only sample data shows.
    const archive = await visit("/api/public/archive?per_page=50");
    const archived = JSON.parse(archive.text).data;
    const entry = archived.results.find((r: any) => r.uuid === campaign.uuid);
    check(
      archive.status === 200 &&
        entry?.subject === `${marker} subject` &&
        entry.content === "" &&
        entry.url === `${rootUrl}/archive/${marker}-slug` &&
        typeof entry.created_at === "string" &&
        archived.per_page === 50 &&
        archived.page === 1 &&
        archived.total >= 1,
      "archive-api",
    );
    const archivePage = await visit("/archive");
    check(
      archivePage.status === 200 &&
        archivePage.text.includes(`href="${rootUrl}/archive/${marker}-slug"`) &&
        archivePage.text.includes(`${marker} subject`) &&
        archivePage.text.includes("Mailing list archive") &&
        archivePage.text.includes(`${rootUrl}/archive.xml`),
      "archive-page",
    );
    const feed = await visit("/archive.xml");
    check(
      feed.status === 200 &&
        feed.text.includes('<rss version="2.0"') &&
        feed.text.includes(`<title>${marker} subject</title>`) &&
        feed.text.includes(`<link>${rootUrl}/archive/${marker}-slug</link>`) &&
        feed.text.includes("<description>Mailing list archive</description>"),
      "archive-feed",
    );
    const bySlug = await visit(`/archive/${marker}-slug`);
    const byUuid = await visit(`/archive/${campaign.uuid}`);
    check(
      bySlug.status === 200 &&
        byUuid.status === 200 &&
        bySlug.text.includes("Hi Archive") &&
        !bySlug.text.includes(reader.email) &&
        !bySlug.text.includes(reader.uuid),
      "archive-single",
    );
    const latest = await visit("/archive/latest");
    check(latest.status === 200 && latest.text.includes("Hi Archive"), "archive-latest");
    check((await visit(`/archive/${missing}`)).status === 404, "archive-missing");
    check((await visit(`/archive/no-such-${marker}`)).status === 404, "archive-missing-slug");
    const pageTwo = await visit("/api/public/archive?page=5000&per_page=1");
    check(
      pageTwo.status === 200 && JSON.parse(pageTwo.text).data.results.length === 0,
      "archive-past-end",
    );

    // Custom appearance.
    await withSetting("appearance.public.custom_css", `/* ${marker} */`, async () => {
      const css = await visit("/public/custom.css");
      check(
        css.status === 200 &&
          css.headers.get("content-type") === "text/css; charset=utf-8" &&
          css.text === `/* ${marker} */`,
        "custom-css",
      );
    });
    const js = await visit("/public/custom.js");
    check(
      js.status === 200 &&
        js.headers.get("content-type") === "application/javascript; charset=utf-8",
      "custom-js",
    );
    check((await visit("/subscription/form")).text.includes("/public/custom.css"), "custom-link");

    // Settings gates.
    await withSetting("app.enable_public_subscription_page", false, async () => {
      check((await visit("/subscription/form")).status === 404, "gate-form-page");
      check(
        (await post("/subscription/form", new URLSearchParams({ email: address("gate") })))
          .status === 404,
        "gate-form-post",
      );
      const api = await postJson("/api/public/subscription", {
        email: address("gate"),
        list_uuids: [single.uuid],
      });
      check(
        api.status === 400 && JSON.parse(api.text).message === "That feature is not available.",
        "gate-api",
      );
      check((await visit("/api/public/lists")).status === 200, "gate-lists-open");
    });
    await withSetting("security.trusted_urls", ["https://example.test/thanks"], async () => {
      const trusted = await post(
        "/subscription/form",
        new URLSearchParams({
          email: address("next"),
          l: single.uuid,
          next: "https://example.test/thanks",
        }),
      );
      check(
        trusted.status === 303 && trusted.headers.get("location") === "https://example.test/thanks",
        "next-trusted",
      );
      const foreign = await post(
        "/subscription/form",
        new URLSearchParams({
          email: address("next2"),
          l: single.uuid,
          next: "https://attacker.test/",
        }),
      );
      check(foreign.status === 200 && !foreign.headers.get("location"), "next-foreign");
      await adminSubscriber(`next-${marker}@example.test`);
      await adminSubscriber(`next2-${marker}@example.test`);
    });
    if (!reference) {
      // D60: forwarded addresses count only from a configured proxy, for public and login limits.
      const signup = (client: string) =>
        visit("/api/public/subscription", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": client },
          body: "{}",
        });
      const login = (client: string) =>
        visit("/admin/login", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-forwarded-for": client,
          },
          body: "username=nobody&password=wrong",
        });
      const budget = { subscribe: 3, optin: 60, unsubscribe: 300, privacy: 10 };
      for (const bad of ["not-an-ip", "10.0.0.0/33", "0.0.0.0/0", "::/0", "1.2.3.4/8/8"])
        check(
          (await call("/api/settings/security.trusted_proxies", "PUT", [bad])).status === 400,
          "proxy-invalid",
        );
      check(
        (
          await call("/api/settings/security.public_rate_limit", "PUT", {
            ...budget,
            subscribe: 0,
          })
        ).status === 400,
        "budget-invalid",
      );
      await withSetting("security.public_rate_limit", budget, async () => {
        await withSetting("security.trusted_proxies", ["127.0.0.0/8", "::1"], async () => {
          for (let i = 0; i < 3; i++)
            check((await signup("203.0.113.1")).status === 400, "proxy-own-budget");
          const limited = await signup("203.0.113.1");
          check(
            limited.status === 429 && Number(limited.headers.get("retry-after")) > 0,
            "proxy-limited",
          );
          check((await signup("203.0.113.2")).status === 400, "proxy-other-visitor");
          check((await signup("9.9.9.9, 203.0.113.1")).status === 429, "proxy-spoofed-prefix");
          for (let i = 0; i < 20; i++)
            check((await login("203.0.113.3")).status !== 429, "proxy-login-budget");
          const locked = await login("203.0.113.3");
          check(
            locked.status === 429 && Number(locked.headers.get("retry-after")) > 0,
            "proxy-login-limited",
          );
          check((await login("203.0.113.4")).status !== 429, "proxy-login-other");
        });
        // Without a configured proxy the same header is only client input.
        for (let i = 0; i < 3; i++)
          check((await signup(`198.51.100.${i}`)).status === 400, "proxy-untrusted");
        check((await signup("198.51.100.200")).status === 429, "proxy-untrusted-limited");
      });
    }
    await withSetting("privacy.domain_blocklist", ["blocked.example"], async () => {
      const response = await postJson("/api/public/subscription", {
        email: `someone-${marker}@blocked.example`,
        list_uuids: [single.uuid],
      });
      check(
        response.status === 400 &&
          JSON.parse(response.text).message === "The e-mail domain is blocklisted.",
        "gate-blocklist",
      );
    });
    await withSetting("privacy.allow_preferences", false, async () => {
      const off = await visit(`${prefs}?manage=true`);
      check(
        off.status === 200 &&
          off.text.includes('class="unsub-form"') &&
          !off.text.includes('href="?manage=true"') &&
          !off.text.includes('class="manage-form"'),
        "gate-prefs-page",
      );
      check(
        (await post(prefs, new URLSearchParams({ manage: "true", name: "X" }))).status === 400,
        "gate-prefs-post",
      );
    });
    await withSetting("privacy.allow_export", false, async () => {
      check((await post(`/subscription/export/${noa.uuid}`)).status === 400, "gate-export");
      const withoutExport = await visit(`/subscription/${dummy}/${noa.uuid}`);
      check(!withoutExport.text.includes('value="export"'), "gate-export-page");
    });
    await withSetting("privacy.allow_wipe", false, async () => {
      check((await post(`/subscription/wipe/${noa.uuid}`)).status === 400, "gate-wipe");
      check((await call(`/api/subscribers/${noa.id}`)).status === 200, "gate-wipe-kept");
    });
    await withSetting("app.send_optin_confirmation", false, async () => {
      const email = address("quiet");
      const quiet = await postJson("/api/public/subscription", {
        email,
        list_uuids: [double.uuid],
      });
      // Without the confirmation hook no signup reports an opt-in.
      check(
        quiet.status === 200 && JSON.parse(quiet.text).data.has_optin === false,
        "gate-no-optin-mail",
      );
      await adminSubscriber(email);
      await Bun.sleep(200);
      check((await mails(email)).length === 0, "gate-no-mail");
    });
    await withSetting("app.show_optin_page", false, async () => {
      const rae = await createSubscriber("rae", [double.id]);
      const direct = await visit(`/subscription/optin/${rae.uuid}`);
      // D-public-get-confirm: GET never confirms, even with the page setting off.
      check(
        direct.status === 200 &&
          (await status(rae.id, double.id)) === (reference ? "confirmed" : "unconfirmed"),
        "gate-optin-page",
      );
    });
    await withSetting("privacy.record_optin_ip", true, async () => {
      const sam = await createSubscriber("sam", [double.id]);
      const headers = { ...form, "x-forwarded-for": "203.0.113.7" };
      await visit(`/subscription/optin/${sam.uuid}`, {
        method: "POST",
        headers,
        body: "confirm=true",
      });
      const stored = (await membership(sam.id, double.id))?.subscription_meta?.optin_ip;
      // D-public-optin-ip: the transport peer, not a client-supplied header.
      check(stored === (reference ? "203.0.113.7" : "127.0.0.1"), "gate-optin-ip");
    });
    await withSetting("app.enable_public_archive", false, async () => {
      check((await visit("/archive")).status === 404, "gate-archive");
      check((await visit("/archive.xml")).status === 404, "gate-archive-xml");
      check((await visit(`/archive/${campaign.uuid}`)).status === 404, "gate-archive-one");
      check((await visit("/archive/latest")).status === 404, "gate-archive-latest");
      check((await visit("/api/public/archive")).status === 404, "gate-archive-api");
    });

    if (target.restart) {
      await target.restart();
      check((await status(bobRow.id, double.id)) === "confirmed", "restart");
    }

    // Excess public requests get 429 per peer; these bad addresses write nothing.
    if (!reference) {
      let limited: Awaited<ReturnType<typeof post>> | undefined;
      for (let i = 0; i < 40 && !limited; i++) {
        const response = await post("/subscription/form", "email=bad&l=" + single.uuid);
        if (response.status === 429) limited = response;
      }
      check(limited?.headers.get("retry-after"), "rate-limit");
    }
  } finally {
    for (const [key, value] of originals) await setSetting(key, value);
    for (const id of owned.campaigns) {
      const response = await call(`/api/campaigns/${id}`, "DELETE");
      if (response.status !== 200 && response.status !== 400) cleanupFailed = true;
    }
    for (const id of owned.subscribers) {
      const response = await call(`/api/subscribers/${id}`, "DELETE");
      if (response.status !== 200 && response.status !== 400) cleanupFailed = true;
    }
    for (const id of owned.lists)
      if ((await call(`/api/lists/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    for (const email of owned.addresses)
      for (const found of await mails(email).catch(() => []))
        await mailpit("/api/v1/messages", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ IDs: [found.ID] }),
        }).catch(() => {});
  }
  if (cleanupFailed) throw new Error("FAIL public-cleanup");
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
    await runPublicContract({
      mode: "reference",
      baseUrl,
      credentials: { user, token },
    });
    process.stdout.write("PASS public reference contract\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-]+$/.test(error.message) ? error.message : `Public contract failed: ${error instanceof Error ? error.message : ""}`}\n`,
    );
    process.exitCode = 1;
  }
}
