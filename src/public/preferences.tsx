// The subscription page and preference management, adapted from listmonk cmd/public.go
// (SubscriptionPage, SubscriptionPrefs) and static/public/templates/subscription.html at
// 6fcd95f. Campaign and send routes share them.
import type { Database } from "bun:sqlite";
import { writeTransaction } from "@/db/transaction";
import type { Translation } from "@/i18n/i18n";
import { raw, render } from "@/jsx/render";
import { trimSpace } from "@/lists/store";
import type { PreferenceForm } from "@/public/form";
import { PublicShell, type ShellSite } from "@/public/layout";
import { publicMessage } from "@/public/message";
import { assetVersion } from "@/server/asset-manifest";
import type { SubscriberStore } from "@/subscribers/store";
import type { UnsubscribeEffects } from "@/unsubscribe/routes";

export interface PageOptions {
  siteName: string;
  allowBlocklist: boolean;
  allowPreferences: boolean;
  allowExport: boolean;
  allowWipe: boolean;
  site?: ShellSite;
}
const script = (value: string) => JSON.stringify(value).replaceAll("<", "\\u003c");

export function subscriptionPage(
  t: Translation,
  subscribers: SubscriberStore,
  subscriber: { id: bigint; uuid: string; name: string },
  options: PageOptions,
  manage: boolean,
  headers: Record<string, string>,
): Response {
  const showManage = options.allowPreferences && manage;
  const subscriptions = showManage
    ? subscribers
        .visibleSubscriptions(subscriber.id)
        .filter((list) => list.subscriptionStatus !== "unsubscribed")
    : [];
  const privacy = options.allowExport || options.allowWipe;
  const body = render(
    <PublicShell
      title={t.T("public.unsubscribeTitle")}
      siteName={options.siteName}
      assetVersion={assetVersion}
      poweredBy={t.T("public.poweredBy")}
      archiveTitle={t.T("public.archiveTitle")}
      {...(options.site ? { site: options.site } : {})}
    >
      <section class="section">
        {!showManage ? (
          <>
            <h2>{t.T("globals.buttons.unsubscribe")}</h2>
            <form method="post" class="unsub-form">
              <div>
                <p>{t.T("public.unsubHelp")}</p>
                {options.allowBlocklist ? (
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
              <label>{t.T("globals.fields.name")}</label>
              <input type="text" name="name" value={subscriber.name} maxlength="256" required />
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
              {options.allowBlocklist ? (
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
                  {t.T("public.privacyWipeHelp")}
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
function handleData() {
  var a = document.querySelector('input[name="data-action"]:checked').value,
    f = document.querySelector("#data-form");
  if (a == "export") {
    f.action = ${script(`/subscription/export/${subscriber.uuid}`)};
    return true;
  } else if (confirm(${script(t.T("public.privacyConfirmWipe"))})) {
    f.action = ${script(`/subscription/wipe/${subscriber.uuid}`)};
    return true;
  }
  return false;
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
 * The manage branch of SubscriptionPrefs. The name change and every unsubscribe, with their
 * effects, are one transaction; `current` re-reads the subscriber inside it.
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
      siteName: options.siteName,
      ...(options.site ? { site: options.site } : {}),
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
    siteName: options.siteName,
    ...(options.site ? { site: options.site } : {}),
  });
}
