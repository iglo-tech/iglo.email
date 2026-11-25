// The subscription page and preference management, adapted from listmonk cmd/public.go
// (SubscriptionPage, SubscriptionPrefs) and static/public/templates/subscription.html at
// 6fcd95f. Campaign and send routes share them.
import type { Database } from "bun:sqlite";
import { writeTransaction } from "@/db/transaction";
import type { Translation } from "@/i18n/i18n";
import { raw, render } from "@/jsx/render";
import { must } from "@/invariant";
import { trimSpace } from "@/lists/store";
import type { PreferenceForm } from "@/public/form";
import { PublicShell, siteText } from "@/public/layout";
import type { PageSite } from "@/public/layout";
import { backLink, publicMessage } from "@/public/message";
import { readProfile, storedProfile, textLimit } from "@/public/preference-fields";
import type { PreferenceField, ProfileValue } from "@/public/preference-fields";
import type { Privacy } from "@/public/privacy";
import { assetVersion } from "@/server/asset-manifest";
import type { SubscriberStore } from "@/subscribers/store";
import type { UnsubscribeEffects } from "@/unsubscribe/routes";

/** The site's branding and the privacy options, as the public pages read them (B121). */
export interface PageOptions extends PageSite {
  allowBlocklist: boolean;
  allowPreferences: boolean;
  allowExport: boolean;
  allowWipe: boolean;
  /** The preference center's profile fields (B147, D160). */
  preferenceFields: Array<PreferenceField>;
}

/** A stored attribute as a form control's value: text as is, a number in JSON, anything else empty. */
const attribText = (value: ProfileValue | undefined) =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
/** A field's bound as an attribute value; none omits the attribute. */
const boundText = (value: number | null) => (value === null ? undefined : String(value));

/**
 * B147 (D160): one profile field of the manage view. An editable field is a control named
 * `attribs.<key>` with its type's browser rules (the server checks them again); a read-only field shows
 * its stored value as text and posts nothing.
 */
function ProfileField(props: { field: PreferenceField; value: ProfileValue | undefined }) {
  const { field, value } = props;
  const id = `attrib-${field.key}`;
  const name = `attribs.${field.key}`;
  if (!field.editable) {
    const shown =
      field.type === "boolean" ? (value === true ? "✓" : "—") : attribText(value) || "—";
    return (
      <p class="profile-field">
        <strong>{field.label}</strong>: <span>{shown}</span>
      </p>
    );
  }
  if (field.type === "boolean") {
    return (
      <p class="profile-field">
        <input id={id} type="checkbox" name={name} value="true" checked={value === true} />{" "}
        <label for={id}>{field.label}</label>
      </p>
    );
  }
  if (field.type === "select") {
    const current = attribText(value);
    return (
      <p class="profile-field">
        <label for={id}>{field.label}</label>
        <select id={id} name={name} required={field.required}>
          {field.required ? null : <option value="">—</option>}
          {field.options.map((option) => (
            <option value={option} selected={option === current}>
              {option}
            </option>
          ))}
        </select>
      </p>
    );
  }
  const isText = field.type === "text";
  const isNumber = field.type === "number";
  return (
    <p class="profile-field">
      <label for={id}>{field.label}</label>
      <input
        id={id}
        name={name}
        type={field.type}
        value={attribText(value)}
        required={field.required}
        maxlength={isText ? String(Math.min(field.max ?? textLimit, textLimit)) : undefined}
        minlength={isText ? boundText(field.min) : undefined}
        step={isNumber ? "any" : undefined}
        min={isNumber ? boundText(field.min) : undefined}
        max={isNumber ? boundText(field.max) : undefined}
      />
    </p>
  );
}

/**
 * What a subscription page offers, by how its path pairs the subscriber (D126, r1).
 * - `paired`: a campaign or a marketing send paired them. `base` is the paired path the forms post to.
 *   The manage view changes the name and the confirmed lists. `blocklist` and `privacy` say whether
 *   those forms appear. `lists` are the lists the link covers: a marketing send's list, a campaign's lists.
 * - `transactional`: a transactional send paired them through its journal row (D126, r1). Its form
 *   cancels pending opt-ins only, which are unconfirmed memberships of double opt-in lists; with no open
 *   membership it says already unsubscribed; an active subscriber gets the manage view, or with
 *   preferences off a pointer to a marketing link (B126 r2, D123 item 8). Its manage view changes the
 *   confirmed lists and never the name (D137 item 1). It has no blocklist and no wipe; its export form
 *   posts to `base`.
 * - `pending`: a mail the server sent with no campaign or send (opt-in). The manage view changes
 *   pending lists only: no name, no blocklist, no privacy form.
 */
export type PageMode =
  | {
      kind: "paired";
      base: string;
      blocklist: boolean;
      privacy: boolean;
      lists: Array<bigint>;
    }
  | { kind: "transactional"; base: string }
  | { kind: "pending" };

const script = (value: string) => JSON.stringify(value).replaceAll("<", String.raw`\u003c`);

/**
 * A pending opt-in: an unconfirmed membership of a double opt-in list (B117b, D137 item 3). An unconfirmed
 * membership of a single opt-in list is an active subscription, so the pending-only pages never list it or end it.
 */
const pendingOptin = (list: { subscriptionStatus: string; optin: string }) =>
  list.subscriptionStatus === "unconfirmed" && list.optin === "double";

/**
 * The public lists a revisited link covers, when every membership it covers is unsubscribed; `null`
 * while the link still has something to unsubscribe from (B126, D123). The memberships decide,
 * whatever the list's type, so a private list counts. Only public lists are named, as the manage view
 * names them: a link that covers private lists alone names none.
 */
function alreadyUnsubscribed(
  subscribers: SubscriberStore,
  id: bigint,
  lists: Array<bigint>,
): Array<string> | null {
  const covered = subscribers.allSubscriptions(id).filter((list) => lists.includes(list.listId));
  if (!covered.length || covered.some((list) => list.subscriptionStatus !== "unsubscribed")) {
    return null;
  }
  return covered.filter((list) => list.type === "public").map((list) => list.name);
}

/**
 * What a transactional link's page reads from the subscriber's memberships (B126 r2, D123 item 8).
 * `pending` is an unconfirmed membership of a double opt-in list only: the open opt-in its form cancels.
 * An unconfirmed membership of a single opt-in list is an active subscription (an API create without
 * `preconfirm_subscriptions`, or an import), so `active` counts it with the confirmed ones, which the
 * link cannot end (D126). A pending list names the page only when it is public.
 */
function transactionalMemberships(subscribers: SubscriberStore, id: bigint) {
  const all = subscribers.allSubscriptions(id);
  const pending = all.filter(pendingOptin);
  return {
    pending: pending.length > 0,
    pendingNames: pending.filter((list) => list.type === "public").map((list) => list.name),
    active: all.some(
      (list) =>
        list.subscriptionStatus === "confirmed" ||
        (list.subscriptionStatus === "unconfirmed" && list.optin === "single"),
    ),
  };
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
  const transactional = mode.kind === "transactional";
  const memberships = transactional ? transactionalMemberships(subscribers, subscriber.id) : null;
  // The manage view needs preferences. A transactional link with an active subscription and no open
  // opt-in is the manage view, since its page has no unsubscribe button to offer (B126 r2).
  const showManage =
    options.allowPreferences &&
    (manage || (memberships !== null && memberships.active && !memberships.pending));
  // B126 (D123): a marketing or campaign link revisited after every list it covers is unsubscribed says
  // so, with the privacy forms and the manage link it offered before. The check follows the manage view
  // actually shown, so a `?manage=true` with preferences off is answered here too.
  const already =
    !showManage && mode.kind === "paired" && mode.blocklist
      ? alreadyUnsubscribed(subscribers, subscriber.id, mode.lists)
      : null;
  // A transactional link: an open opt-in gets the form, an active subscription without preferences gets
  // the pointer page, and nothing open gets the already page, which names no list (D126 r2).
  const transactionalView =
    memberships !== null && !showManage
      ? memberships.pending
        ? "form"
        : memberships.active
          ? "confirmed"
          : "already"
      : null;
  const alreadyNames = already ?? (transactionalView === "already" ? [] : null);
  // B126 (D123 item 8): a transactional link with an active subscription and no manage view is the email
  // settings page. Its pending form is titled as its button, and its already-unsubscribed page is titled
  // as a marketing link's already-unsubscribed page is.
  // B117b (D137 item 2): a transactional manage view is the email settings page too, with preferences on.
  const pageTitle =
    transactionalView === "confirmed" || (transactional && showManage)
      ? t.T("public.emailSettings")
      : transactionalView === "form"
        ? t.T("public.cancelPending")
        : alreadyNames
          ? t.T("globals.terms.unsubscribed")
          : t.T("public.unsubscribeTitle");
  const pending = mode.kind === "pending";
  // B117b (D137 item 1): only a paired marketing or campaign page changes the name. The transactional and
  // pending pages never do, with or without copies.
  const renames = mode.kind === "paired";
  // The public lists a manage view changes: those not unsubscribed (pending opt-ins, for a pending link).
  const manageable = subscribers
    .visibleSubscriptions(subscriber.id)
    .filter((list) => (pending ? pendingOptin(list) : list.subscriptionStatus !== "unsubscribed"));
  // B147 (D160): a paired or transactional manage view is a preference center. It offers every active
  // public list the subscriber is not on (or left) to opt in to; a pending page offers none, and a
  // blocklisted or suppressed subscriber gets none. Profile fields follow the name: paired pages only.
  const joinable = pending ? [] : subscribers.joinableLists(subscriber.id);
  const profileFields = renames ? options.preferenceFields : [];
  // B130 (D128): with no public list to manage, the page has no manage link and no preference form, and
  // the manage view keeps only the privacy actions. `privacy.allow_preferences` stays the explicit switch.
  const managePrefs =
    options.allowPreferences &&
    (manageable.length > 0 || joinable.length > 0 || profileFields.length > 0);
  const subscriptions = showManage ? manageable : [];
  const offered = showManage ? joinable : [];
  const profile = showManage ? profileFields : [];
  const attribs = storedProfile(subscribers.get(subscriber.id)?.attribs ?? "{}", profile);
  const hasForm = subscriptions.length > 0 || offered.length > 0 || profile.length > 0;
  // A manage view with nothing to show (no public list, not a transactional link) has no preference section.
  const emptyManage = showManage && !hasForm && !transactional;
  const blocklist = mode.kind === "paired" && mode.blocklist && options.allowBlocklist;
  // B126 (D123 item 8): a transactional link offers export only. A wipe is a marketing or campaign link's.
  const privacyPaired = mode.kind === "paired" ? mode.privacy : transactional;
  const offersExport = privacyPaired && options.allowExport;
  const offersWipe = mode.kind === "paired" && mode.privacy && options.allowWipe;
  const privacy = offersExport || offersWipe;
  // B130 (D128, review r1): a manage view with neither a preference section nor a privacy action says so,
  // rather than rendering a page with only its header.
  const nothingToManage = emptyManage && !privacy;
  const base = mode.kind === "pending" ? "" : mode.base;
  const body = render(
    <PublicShell
      title={pageTitle}
      assetVersion={assetVersion}
      archiveTitle={t.T("public.archiveTitle")}
      site={options}
    >
      {emptyManage ? null : (
        <section class="section">
          {alreadyNames ? (
            <>
              <h2>{t.T("globals.terms.unsubscribed")}</h2>
              <div>
                <p>
                  {alreadyNames.length
                    ? t
                        .T("public.alreadyUnsubscribedLists")
                        .replaceAll("{lists}", () => alreadyNames.join(", "))
                    : t.T("public.alreadyUnsubscribed")}
                </p>
                {managePrefs ? (
                  <p>
                    <a href="?manage=true">{t.T("public.managePrefs")}</a>
                  </p>
                ) : null}
              </div>
            </>
          ) : transactionalView === "confirmed" ? (
            <>
              <h2>{t.T("public.emailSettings")}</h2>
              <p>{siteText(t.T("public.txConfirmedInfo"), options.siteName)}</p>
            </>
          ) : !showManage ? (
            <>
              <h2>
                {transactional ? t.T("public.cancelPending") : t.T("globals.buttons.unsubscribe")}
              </h2>
              <form method="post" class="unsub-form">
                <div>
                  {transactional ? (
                    <p>
                      {must(memberships, "transactional memberships").pendingNames.length
                        ? t
                            .T("public.pendingNamed")
                            .replaceAll("{lists}", () =>
                              must(memberships, "transactional memberships").pendingNames.join(
                                ", ",
                              ),
                            )
                        : t.T("public.pendingGeneric")}
                    </p>
                  ) : (
                    <p>{t.T("public.unsubHelp")}</p>
                  )}
                  {blocklist ? (
                    <>
                      <hr />
                      <p class="small">
                        <input
                          id="privacy-blocklist"
                          type="checkbox"
                          name="blocklist"
                          value="true"
                        />{" "}
                        <label for="privacy-blocklist">{t.T("public.unsubAllLists")}</label>
                      </p>
                    </>
                  ) : null}
                  <p>
                    <button type="submit" class="button" id="btn-unsub">
                      {transactional
                        ? t.T("public.cancelPending")
                        : t.T("globals.buttons.unsubscribe")}
                    </button>
                  </p>
                  {managePrefs ? <a href="?manage=true">{t.T("public.managePrefs")}</a> : null}
                </div>
              </form>
            </>
          ) : hasForm ? (
            <form method="post" class="manage-form">
              <div>
                <input type="hidden" name="manage" value="true" />
                <h2>{transactional ? t.T("public.emailSettings") : t.T("public.managePrefs")}</h2>
                {renames ? (
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
                ) : null}
                {profile.length ? (
                  <fieldset class="profile">
                    <input type="hidden" name="profile" value="true" />
                    <legend>{t.T("public.profileTitle")}</legend>
                    {profile.map((field) => (
                      <ProfileField field={field} value={attribs.get(field.key)} />
                    ))}
                  </fieldset>
                ) : null}
                {subscriptions.length || offered.length ? (
                  <>
                    <br />
                    <br />
                    <h3>
                      {offered.length
                        ? t.T("public.managePrefsLists")
                        : t.T("public.managePrefsUnsub")}
                    </h3>
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
                          {list.description ? <p class="small">{list.description}</p> : null}
                        </li>
                      ))}
                      {offered.map((list) => (
                        <li>
                          <input id={`l-${list.uuid}`} type="checkbox" name="l" value={list.uuid} />{" "}
                          <label for={`l-${list.uuid}`}>{list.name}</label>
                          {list.description ? <p class="small">{list.description}</p> : null}
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
                    <label for="privacy-blocklist">{t.T("public.unsubAllLists")}</label>
                  </p>
                ) : null}
                <p>
                  <button type="submit" class="button" id="btn-unsub">
                    {t.T("globals.buttons.save")}
                  </button>
                </p>
              </div>
            </form>
          ) : transactional ? (
            <p>{siteText(t.T("public.txConfirmedInfo"), options.siteName)}</p>
          ) : null}
        </section>
      )}
      {nothingToManage ? (
        <section class="section">
          <h2>{t.T("public.managePrefs")}</h2>
          <p>{t.T("public.nothingToManage")}</p>
        </section>
      ) : null}
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
              {offersExport ? (
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
              {offersWipe ? (
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
      {alreadyNames || transactionalView === "confirmed" || nothingToManage
        ? backLink(t, options)
        : null}
      {raw(`<script>
${
  privacy
    ? `function handleData() {
  // B126 (D123): a wipe posts to its own confirmation page, which deletes nothing until confirmed.
  var f = document.querySelector("#data-form");
  ${
    offersWipe
      ? `var a = document.querySelector('input[name="data-action"]:checked').value;
  f.action = a == "export"
    ? ${script(`${base}/export/${subscriber.uuid}`)}
    : ${script(`${base}/wipe/${subscriber.uuid}`)};`
      : `f.action = ${script(`${base}/export/${subscriber.uuid}`)};`
  }
  return true;
}`
    : ""
}
function unsubAll(e) {
  var off = e.target.checked;
  document.querySelector("input[name=name]").disabled = off;
  document.querySelectorAll("input[type=checkbox][name=l], [name^='attribs.']").forEach(function (l) {
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
 * The manage branch of SubscriptionPrefs for a paired page. The name change, the profile fields, every
 * unsubscribe with its effects and every opt-in are one transaction; `current` re-reads the subscriber
 * inside it. B147 (D160): a checked public list the subscriber is not on is joined as a public signup
 * joins it, and the opt-in mail is queued after the commit.
 */
export function savePreferences(
  deps: {
    db: Database;
    subscribers: SubscriberStore;
    effects: UnsubscribeEffects;
    privacy: Pick<Privacy, "signup">;
  },
  t: Translation,
  options: PageOptions,
  form: PreferenceForm,
  current: () => { id: bigint } | null,
  // Whether the page may change the name: a marketing or campaign page does, a transactional page never
  // does (B117b, D137 item 1). A name sent to a transactional page is ignored, not refused.
  rename: boolean,
): Response | null {
  const failed = (message: string) =>
    publicMessage(t, {
      status: 400,
      title: t.T("globals.terms.error"),
      message,
      site: options,
    });
  if (!options.allowPreferences) {
    return failed(t.T("public.invalidFeature"));
  }
  const name = trimSpace(form.name);
  if (rename && (!name || Buffer.byteLength(name) > 256 || name.includes("\0"))) {
    return failed(t.T("globals.messages.invalidName"));
  }
  // B147 (D160): only a paired page edits the profile, as only it renames, and only when the form carries
  // it. Only the editable fields are read; any other submitted key is never written.
  const change = rename && form.profile ? readProfile(options.preferenceFields, form) : null;
  if (change && !change.ok) {
    return failed(t.T("globals.messages.invalidFields").replaceAll("{name}", change.field.label));
  }
  const kept = new Set(form.lists.map((uuid) => uuid.toLowerCase()));
  const saved = writeTransaction(deps.db, () => {
    const subscriber = current();
    if (!subscriber) {
      return null;
    }
    if (rename) {
      deps.subscribers.rename(subscriber.id, name);
    }
    if (change?.ok) {
      deps.subscribers.setAttribs(subscriber.id, change.values, change.removed);
    }
    for (const list of deps.subscribers.visibleSubscriptions(subscriber.id)) {
      if (kept.has(list.uuid) || list.subscriptionStatus === "unsubscribed") {
        continue;
      }
      const listIds = deps.subscribers.unsubscribe(subscriber.id, list.listId);
      deps.effects.unsubscribed({
        subscriberId: subscriber.id,
        listId: list.listId,
        listIds,
      });
    }
    const wanted = deps.subscribers
      .joinableLists(subscriber.id)
      .filter((list) => kept.has(list.uuid))
      .map((list) => list.id);
    const joined = wanted.length ? deps.subscribers.publicOptin(subscriber.id, wanted) : [];
    return { id: subscriber.id, joined: joined.length > 0 };
  });
  if (!saved) {
    return null;
  }
  // Outside the write: the opt-in loop mails the pending double opt-in lists, as for a public signup.
  if (saved.joined) {
    deps.privacy.signup(saved.id);
  }
  return publicMessage(t, {
    status: 200,
    title: t.T("globals.messages.done"),
    message: t.T("public.prefsSaved"),
    site: options,
  });
}

/**
 * The first step of a wipe (B126, D123): a page that names what the wipe removes and posts `confirm=true`
 * to the same path. Nothing is deleted by it; a browser dialog is not used.
 */
export function wipeConfirmation(
  t: Translation,
  action: string,
  manage: string,
  options: PageOptions,
): Response {
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
        <p>
          <a href={manage}>{t.T("public.wipeKeep")}</a>
        </p>
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
  if (!options.allowPreferences) {
    return publicMessage(t, {
      status: 400,
      title: t.T("globals.terms.error"),
      message: t.T("public.invalidFeature"),
      site: options,
    });
  }
  const kept = new Set(form.lists.map((uuid) => uuid.toLowerCase()));
  const saved = writeTransaction(deps.db, () => {
    const subscriber = current();
    if (!subscriber) {
      return false;
    }
    for (const list of deps.subscribers.visibleSubscriptions(subscriber.id)) {
      // B117b (D137 item 3): only a pending double opt-in is ended; an active single opt-in stays.
      if (!pendingOptin(list) || kept.has(list.uuid)) {
        continue;
      }
      const listIds = deps.subscribers.unsubscribe(subscriber.id, list.listId);
      deps.effects.unsubscribed({
        subscriberId: subscriber.id,
        listId: list.listId,
        listIds,
      });
    }
    return true;
  });
  if (!saved) {
    return null;
  }
  return publicMessage(t, {
    status: 200,
    title: t.T("globals.messages.done"),
    message: t.T("public.prefsSaved"),
    site: options,
  });
}
