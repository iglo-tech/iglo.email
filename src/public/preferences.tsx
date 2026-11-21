// The subscription page and preference management, adapted from listmonk cmd/public.go
// (SubscriptionPage, SubscriptionPrefs) and static/public/templates/subscription.html at
// 6fcd95f. Campaign and send routes share them.
import type { Database } from "bun:sqlite";
import { writeTransaction } from "@/db/transaction";
import type { Translation } from "@/i18n/i18n";
import { raw, render } from "@/jsx/render";
import { trimSpace } from "@/lists/store";
import type { PreferenceForm } from "@/public/form";
import { PublicShell, siteText, type PageSite } from "@/public/layout";
import { publicMessage } from "@/public/message";
import { assetVersion } from "@/server/asset-manifest";
import type { SubscriberStore } from "@/subscribers/store";
import type { UnsubscribeEffects } from "@/unsubscribe/routes";

/** The site's branding and the privacy options, as the public pages read them (B121). */
export interface PageOptions extends PageSite {
  allowBlocklist: boolean;
  allowPreferences: boolean;
  allowExport: boolean;
  allowWipe: boolean;
}

/**
 * What a subscription page offers, by how its path pairs the subscriber (D126, r1).
 * - `paired`: a campaign, a marketing send or a transactional send paired them. `base` is the
 *   paired path the forms post to. The manage view changes the name and the confirmed lists.
 *   `blocklist` and `privacy` say whether those forms appear.
 * - `pending`: a mail the server sent with no campaign or send (opt-in). The manage view changes
 *   pending lists only: no name, no blocklist, no privacy form.
 */
export type PageMode =
  | {
      kind: "paired";
      base: string;
      blocklist: boolean;
      privacy: boolean;
      /**
       * The lists this link covers, when it names one (a marketing send's list). Without them every
       * membership counts (B126, D123).
       */
      lists?: bigint[];
    }
  | { kind: "pending" };

const script = (value: string) => JSON.stringify(value).replaceAll("<", "\\u003c");

/**
 * The names of the lists a revisited marketing link covers, when every one of them is unsubscribed;
 * `null` while the link still has something to unsubscribe from (B126, D123). With `lists` the link
 * covers those lists; without, every membership counts. Only public lists are named, as the manage
 * view names them.
 */
function alreadyUnsubscribed(
  subscribers: SubscriberStore,
  id: bigint,
  lists?: bigint[],
): string[] | null {
  const visible = subscribers.visibleSubscriptions(id);
  if (lists) {
    const covered = visible.filter((list) => lists.includes(list.listId));
    return covered.length && covered.every((list) => list.subscriptionStatus === "unsubscribed")
      ? covered.map((list) => list.name)
      : null;
  }
  const all = subscribers.exportSubscriptions(id);
  if (!all.length || all.some((item) => item.subscription_status !== "unsubscribed")) return null;
  return visible.map((list) => list.name);
}

export function subscriptionPage(
  t: Translation,
  subscribers: SubscriberStore,
  subscriber: { id: bigint; uuid: string; name: string },
  options: PageOptions,
  manage: boolean,
  headers: Record<string, string>,
  mode: PageMode,
): Response {
  // B126 (D123): a marketing link revisited after its unsubscribe says so, and names its lists.
  // The manage view still shows what remains, so it is not answered here.
  if (!manage && mode.kind === "paired" && mode.blocklist) {
    const names = alreadyUnsubscribed(subscribers, subscriber.id, mode.lists);
    if (names)
      return publicMessage(
        t,
        {
          status: 200,
          title: t.T("globals.terms.unsubscribed"),
          message: names.length
            ? t.T("public.alreadyUnsubscribedLists").replaceAll("{lists}", names.join(", "))
            : t.T("public.alreadyUnsubscribed"),
          site: options,
        },
        headers,
      );
  }
  const showManage = options.allowPreferences && manage;
  const pending = mode.kind === "pending";
  const subscriptions = showManage
    ? subscribers
        .visibleSubscriptions(subscriber.id)
        .filter((list) =>
          pending
            ? list.subscriptionStatus === "unconfirmed"
            : list.subscriptionStatus !== "unsubscribed",
        )
    : [];
  const blocklist = mode.kind === "paired" && mode.blocklist && options.allowBlocklist;
  const privacy =
    mode.kind === "paired" && mode.privacy && (options.allowExport || options.allowWipe);
  const base = mode.kind === "paired" ? mode.base : "";
  const body = render(
    <PublicShell
      title={t.T("public.unsubscribeTitle")}
      assetVersion={assetVersion}
      archiveTitle={t.T("public.archiveTitle")}
      site={options}
    >
      <section class="section">
        {!showManage ? (
          <>
            <h2>{t.T("globals.buttons.unsubscribe")}</h2>
            <form method="post" class="unsub-form">
              <div>
                <p>{t.T("public.unsubHelp")}</p>
                {blocklist ? (
                  <>
                    <hr />
                    <p class="small">
                      <input id="privacy-blocklist" type="checkbox" name="blocklist" value="true" />{" "}
                      <label for="privacy-blocklist">{t.T("public.unsubFull")}</label>
                    </p>
                  </>
                ) : null}
                <p>
                  <button type="submit" class="button" id="btn-unsub">
                    {t.T("globals.buttons.unsubscribe")}
                  </button>
                </p>
                {options.allowPreferences ? (
                  <a href="?manage=true">{t.T("public.managePrefs")}</a>
                ) : null}
              </div>
            </form>
          </>
        ) : (
          <form method="post" class="manage-form">
            <div>
              <input type="hidden" name="manage" value="true" />
              <h2>{t.T("public.managePrefs")}</h2>
              {pending ? null : (
                <>
                  <label for="manage-name">{t.T("globals.fields.name")}</label>
                  <input
                    id="manage-name"
                    type="text"
                    name="name"
                    value={subscriber.name}
                    maxlength="256"
                    required
                  />
                </>
              )}
              {subscriptions.length ? (
                <>
                  <br />
                  <br />
                  <h3>{t.T("public.managePrefsUnsub")}</h3>
                  <ul class="lists">
                    {subscriptions.map((list) => (
                      <li>
                        <input
                          id={`l-${list.uuid}`}
                          type="checkbox"
                          name="l"
                          value={list.uuid}
                          checked
                        />{" "}
                        <label for={`l-${list.uuid}`}>{list.name}</label>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {blocklist ? (
                <p class="small">
                  <input
                    id="privacy-blocklist"
                    type="checkbox"
                    name="blocklist"
                    value="true"
                    onchange="unsubAll(event)"
                  />{" "}
                  <label for="privacy-blocklist">{t.T("public.unsubFull")}</label>
                </p>
              ) : null}
              <p>
                <button type="submit" class="button" id="btn-unsub">
                  {t.T("globals.buttons.save")}
                </button>
              </p>
            </div>
          </form>
        )}
      </section>
      {privacy ? (
        <>
          <form
            id="data-form"
            class="data-form"
            method="post"
            action=""
            onsubmit="return handleData()"
          >
            <section>
              <h2>{t.T("public.privacyTitle")}</h2>
              {options.allowExport ? (
                <div class="row">
                  <input
                    id="privacy-export"
                    type="radio"
                    name="data-action"
                    value="export"
                    required
                  />{" "}
                  <label for="privacy-export">
                    <strong>{t.T("public.privacyExport")}</strong>
                  </label>
                  <br />
                  {t.T("public.privacyExportHelp")}
                </div>
              ) : null}
              {options.allowWipe ? (
                <div class="row">
                  <input id="privacy-wipe" type="radio" name="data-action" value="wipe" required />{" "}
                  <label for="privacy-wipe">
                    <strong>{t.T("public.privacyWipe")}</strong>
                  </label>
                  <br />
                  {siteText(t.T("public.privacyWipeHelp"), options.siteName)}
                </div>
              ) : null}
              <p>
                <input
                  type="submit"
                  value={t.T("globals.buttons.continue")}
                  class="button button-outline"
                />
              </p>
            </section>
          </form>
        </>
      ) : null}
      {raw(`<script>
${
  privacy
    ? `function handleData() {
  // B126 (D123): a wipe posts to its own confirmation page, which deletes nothing until confirmed.
  var a = document.querySelector('input[name="data-action"]:checked').value,
    f = document.querySelector("#data-form");
  f.action = a == "export"
    ? ${script(`${base}/export/${subscriber.uuid}`)}
    : ${script(`${base}/wipe/${subscriber.uuid}`)};
  return true;
}`
    : ""
}
function unsubAll(e) {
  var off = e.target.checked;
  document.querySelector("input[name=name]").disabled = off;
  document.querySelectorAll("input[type=checkbox][name=l]").forEach(function (l) {
    l.disabled = off;
  });
}
</script>`)}
    </PublicShell>,
  );
  return new Response(`<!DOCTYPE html>${body}`, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=UTF-8", ...headers },
  });
}

/**
 * The manage branch of SubscriptionPrefs for a paired page. The name change and every unsubscribe,
 * with their effects, are one transaction; `current` re-reads the subscriber inside it.
 */
export function savePreferences(
  deps: { db: Database; subscribers: SubscriberStore; effects: UnsubscribeEffects },
  t: Translation,
  options: PageOptions,
  form: PreferenceForm,
  current: () => { id: bigint } | null,
): Response | null {
  const failed = (message: string) =>
    publicMessage(t, {
      status: 400,
      title: t.T("globals.terms.error"),
      message,
      site: options,
    });
  if (!options.allowPreferences) return failed(t.T("public.invalidFeature"));
  const name = trimSpace(form.name);
  if (!name || Buffer.byteLength(name) > 256 || name.includes("\0"))
    return failed(t.T("globals.messages.invalidName"));
  const kept = new Set(form.lists.map((uuid) => uuid.toLowerCase()));
  const saved = writeTransaction(deps.db, () => {
    const subscriber = current();
    if (!subscriber) return false;
    deps.subscribers.rename(subscriber.id, name);
    for (const list of deps.subscribers.visibleSubscriptions(subscriber.id)) {
      if (kept.has(list.uuid) || list.subscriptionStatus === "unsubscribed") continue;
      const listIds = deps.subscribers.unsubscribe(subscriber.id, list.listId, false);
      deps.effects.unsubscribed({
        subscriberId: subscriber.id,
        listId: list.listId,
        listIds,
        blocklisted: false,
      });
    }
    return true;
  });
  if (!saved) return null;
  return publicMessage(t, {
    status: 200,
    title: t.T("globals.messages.done"),
    message: t.T("public.prefsSaved"),
    site: options,
    back: true,
  });
}

/**
 * The first step of a wipe (B126, D123): a page that names what the wipe removes and posts `confirm=true`
 * to the same path. Nothing is deleted by it; a browser dialog is not used.
 */
export function wipeConfirmation(t: Translation, action: string, options: PageOptions): Response {
  const title = t.T("public.wipeConfirmTitle");
  const body = render(
    <PublicShell
      title={title}
      site={options}
      assetVersion={assetVersion}
      archiveTitle={t.T("public.archiveTitle")}
    >
      <section class="section">
        <h2>{title}</h2>
        <p>{siteText(t.T("public.wipeConfirmInfo"), options.siteName)}</p>
        <form method="post" action={`${action}?confirm=true`}>
          <p>
            <button type="submit" class="button" id="btn-wipe">
              {t.T("public.wipeConfirmButton")}
            </button>
          </p>
        </form>
      </section>
    </PublicShell>,
  );
  return new Response(`<!DOCTYPE html>${body}`, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=UTF-8", "X-Robots-Tag": "noindex" },
  });
}

/**
 * The manage save of a pending-only page (D126, r1): a pending list not kept is ended. It changes no
 * name and no confirmed list, so a link from an old mail can only decline pending opt-ins.
 */
export function savePendingLists(
  deps: { db: Database; subscribers: SubscriberStore; effects: UnsubscribeEffects },
  t: Translation,
  options: PageOptions,
  form: PreferenceForm,
  current: () => { id: bigint } | null,
): Response | null {
  if (!options.allowPreferences)
    return publicMessage(t, {
      status: 400,
      title: t.T("globals.terms.error"),
      message: t.T("public.invalidFeature"),
      site: options,
    });
  const kept = new Set(form.lists.map((uuid) => uuid.toLowerCase()));
  const saved = writeTransaction(deps.db, () => {
    const subscriber = current();
    if (!subscriber) return false;
    for (const list of deps.subscribers.visibleSubscriptions(subscriber.id)) {
      if (list.subscriptionStatus !== "unconfirmed" || kept.has(list.uuid)) continue;
      const listIds = deps.subscribers.unsubscribe(subscriber.id, list.listId, false);
      deps.effects.unsubscribed({
        subscriberId: subscriber.id,
        listId: list.listId,
        listIds,
        blocklisted: false,
      });
    }
    return true;
  });
  if (!saved) return null;
  return publicMessage(t, {
    status: 200,
    title: t.T("globals.messages.done"),
    message: t.T("public.prefsSaved"),
    site: options,
    back: true,
  });
}
