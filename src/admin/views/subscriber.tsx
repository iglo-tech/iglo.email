// Adapted from listmonk static/admin/views/subscriber.html, partials/subscriber-form.html,
// subscriber-info.html, subscriber-lists.html and bounces-table.html at 6fcd95f. The subscriber
// arrives from /api/subscribers/:id, which owns its permission check and list masking. The API has
// no activity or chart endpoint yet, so the overview tab shows the record without them.
import { Icon } from "@/admin/layout/icon";
import type { AdminRequest, AdminView } from "@/admin/page";
import {
  Alert,
  AvatarLink,
  Breadcrumbs,
  EmptyRow,
  ListSelector,
  ManageLists,
  Preconfirm,
} from "@/admin/views/parts";
import { subscriberKeys } from "@/admin/views/subscribers";
import type { Translation } from "@/i18n/i18n";
import { HttpError } from "@/server/response";
import { getID } from "@/server/validation";

export type SubscriberTab = "activity" | "edit" | "lists" | "bounces";

function Fields({ t }: { t: Translation }) {
  return (
    <>
      <label data-field="">
        {t.T("globals.fields.email")}
        <input name="email" type="email" maxlength="200" autofocus required x-model="form.email" />
      </label>
      <label data-field="">
        {t.T("globals.fields.name")}
        <input name="name" maxlength="200" x-model="form.name" />
      </label>
      <div data-field="">
        <label for="sub-status">{t.T("globals.fields.status")}</label>
        <select name="status" id="sub-status" required x-model="form.status">
          <option value="enabled">{t.T("globals.terms.enabled")}</option>
          <option value="blocklisted">{t.T("globals.terms.blocklisted")}</option>
        </select>
        <small data-hint="">{t.T("subscribers.blocklistedHelp")}</small>
      </div>
    </>
  );
}
function SubscriberForm(props: { t: Translation; isNew: boolean; canSave: boolean }) {
  const { t, isNew, canSave } = props;
  const submit = { "x-on:submit.prevent": isNew ? "onSubmitNew" : "onSubmitUpdate" };
  return (
    <form method="post" {...submit}>
      <div class="page-content content">
        <section>
          <fieldset class="card">
            <legend>{t.T("globals.terms.profile")}</legend>
            <Fields t={t} />
          </fieldset>
          {isNew ? (
            <fieldset class="card">
              <legend>{t.T("globals.terms.lists")}</legend>
              <ListSelector model="form.lists" id="form-lists" t={t} />
              <Preconfirm model="form.preconfirm" enabled="hasOptinList" t={t} />
            </fieldset>
          ) : null}
          <fieldset class="card">
            <legend id="subscriber-attribs-label">{t.T("globals.terms.attribs")}</legend>
            <div data-field="">
              <textarea
                name="attribs"
                aria-labelledby="subscriber-attribs-label"
                rows="4"
                x-model="form.strAttribs"
                class="monospace"
              ></textarea>
              <small data-hint="">
                {t.T("subscribers.attribsHelp")}{" "}
                <code>{`{"job": "developer", "location": "Mars", "has_rocket": true}`}</code>
              </small>
            </div>
          </fieldset>
        </section>
        <footer class="hstack justify-end mt-6">
          {canSave ? (
            <button
              type="submit"
              data-variant="primary"
              data-testid="btn-save"
              x-bind:disabled="isLoading('subscribers.save')"
              x-bind:aria-busy="isLoading('subscribers.save')"
            >
              {t.T("globals.buttons.save")}
            </button>
          ) : null}
        </footer>
      </div>
    </form>
  );
}
function Overview({ t }: { t: Translation }) {
  const copy = (name: string, field: string, label: string) => (
    <button
      type="button"
      class="small"
      data-variant="secondary"
      title={t.T("globals.messages.clickToCopy")}
      aria-label={label}
      x-on:click={`copyToClipboard(form.${field})`}
    >
      <strong>{name}</strong> <span x-text={`form.${field}`}></span>
    </button>
  );
  return (
    <div class="vstack gap-6 activity">
      <div class="card">
        <div class="row">
          <div class="col-6">
            <strong x-text="form.name"></strong>
            <div class="text-small text-light" x-text="niceDate(form.created_at)"></div>
          </div>
          <div class="col-6 hstack gap-2 justify-end">
            {copy(t.T("globals.fields.id"), "id", t.T("globals.fields.id"))}
            {copy(t.T("globals.fields.uuid"), "uuid", t.T("globals.fields.uuid"))}
          </div>
        </div>
      </div>
    </div>
  );
}
function Subscriptions({ t, canSave }: { t: Translation; canSave: boolean }) {
  const click = (handler: string) => ({ "x-on:click.prevent": handler });
  const item = (test: string, icon: string, label: string, handler: string, danger = false) => (
    <button
      type="button"
      role="menuitem"
      class="ghost"
      data-testid={test}
      {...(danger ? { "data-variant": "danger" } : {})}
      {...click(handler)}
    >
      <Icon name={icon} /> {label}
    </button>
  );
  return (
    <div class="card page-content has-table subscriptions">
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>{t.T("globals.terms.list")}</th>
              <th>{t.T("lists.optin")}</th>
              <th>{t.T("globals.fields.status")}</th>
              <th>{t.T("globals.fields.createdAt")}</th>
              <th>{t.T("globals.fields.updatedAt")}</th>
              {canSave ? <th></th> : null}
            </tr>
          </thead>
          <tbody>
            <template x-for="l in subscriptions" x-bind:key="l.id">
              <tr>
                <td>
                  <template x-if="l.restricted">
                    <span class="text-light" x-text="l.name"></span>
                  </template>
                  <template x-if="!l.restricted">
                    <div class="avatar">
                      <AvatarLink
                        kind="list"
                        name="l.name"
                        href="`/admin/lists/${l.id}`"
                        title="viewTitle(l.name)"
                      />
                      <div class="avatar-label">
                        <a
                          x-bind:href="`/admin/lists/${l.id}`"
                          class="unstyled"
                          x-text="l.name"
                        ></a>
                      </div>
                    </div>
                  </template>
                </td>
                <td data-label={t.T("lists.optin")}>
                  <span class="badge enum">
                    <svg class="icon">
                      <use x-bind:href="optinIcon(l.optin)"></use>
                    </svg>{" "}
                    <span x-text="optinLabel(l.optin)"></span>
                  </span>
                </td>
                <td data-label={t.T("globals.fields.status")}>
                  <template x-if="l.optin === 'single' && l.subscription_status === 'unconfirmed'">
                    <span class="text-light">–</span>
                  </template>
                  <template x-if="l.optin !== 'single' || l.subscription_status !== 'unconfirmed'">
                    <span class="badge enum" x-bind:class="`status-${l.subscription_status}`">
                      <span class="dot">●</span>{" "}
                      <span x-text="statusLabel(l.subscription_status)"></span>
                    </span>
                  </template>
                </td>
                <td
                  data-label={t.T("globals.fields.createdAt")}
                  x-text="niceDate(l.subscription_created_at)"
                ></td>
                <td
                  data-label={t.T("globals.fields.updatedAt")}
                  x-text="niceDate(l.subscription_updated_at)"
                ></td>
                {canSave ? (
                  <td class="actions align-right">
                    <ot-dropdown>
                      <button
                        popovertarget=""
                        x-bind:popovertarget="`sub-list-${l.id}`"
                        type="button"
                        class="ghost more icon"
                        aria-label={t.T("globals.buttons.more")}
                      >
                        <Icon name="more-vertical" />
                      </button>
                      <menu popover="" x-bind:id="`sub-list-${l.id}`">
                        <template x-if="l.optin === 'double' && l.subscription_status === 'unconfirmed'">
                          {item(
                            "btn-confirm-sub",
                            "check-circle",
                            t.T("globals.buttons.confirmSubscription"),
                            "onConfirmSub(l.id)",
                          )}
                        </template>
                        <template x-if="l.subscription_status === 'unsubscribed'">
                          {item(
                            "btn-resubscribe",
                            "refresh-cw",
                            t.T("subscribers.reSubscribe"),
                            "onResubscribe(l.id)",
                          )}
                        </template>
                        <template x-if="l.subscription_status !== 'unsubscribed'">
                          {item(
                            "btn-unsubscribe",
                            "user-x",
                            t.T("globals.buttons.unsubscribe"),
                            "onUnsubscribe(l.id)",
                          )}
                        </template>
                        {item(
                          "btn-delete-sub",
                          "trash-2",
                          t.T("globals.buttons.delete"),
                          "onDeleteSub(l.id)",
                          true,
                        )}
                      </menu>
                    </ot-dropdown>
                  </td>
                ) : null}
              </tr>
            </template>
            <EmptyRow when="!subscriptions.length" colspan={6} t={t} />
          </tbody>
        </table>
      </div>
      {canSave ? (
        <dialog x-ref="manageDialog">
          <form {...{ "x-on:submit.prevent": "onManageLists" }}>
            <div class="dialog-card content">
              <header class="dialog-head">
                <h4 class="dialog-title">{t.T("subscribers.manageLists")}</h4>
              </header>
              <section class="dialog-body">
                <ManageLists model="manage" id="manage-lists" t={t} />
              </section>
              <footer class="dialog-foot hstack gap-3 justify-end">
                <button type="button" class="outline" x-on:click="$refs.manageDialog.close()">
                  {t.T("globals.buttons.close")}
                </button>
                <button
                  type="submit"
                  data-variant="primary"
                  x-bind:disabled="manage.lists.length === 0 || isLoading('subscribers')"
                  x-bind:aria-busy="isLoading('subscribers')"
                >
                  {t.T("globals.buttons.save")}
                </button>
              </footer>
            </div>
          </form>
        </dialog>
      ) : null}
    </div>
  );
}
function Bounces({ t }: { t: Translation }) {
  return (
    <div class="card page-content has-table bounces">
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>{t.T("globals.terms.campaign")}</th>
              <th>{t.T("globals.fields.source")}</th>
              <th>{t.T("globals.fields.type")}</th>
              <th>{t.T("globals.fields.createdAt")}</th>
            </tr>
          </thead>
          <tbody>
            <template x-for="b in bounces" x-bind:key="b.id">
              <tr data-testid="bounce-row">
                <td
                  data-label={t.T("globals.terms.campaign")}
                  x-text="b.campaign?.name ?? '-'"
                ></td>
                <td data-label={t.T("globals.fields.source")} x-text="b.source"></td>
                <td data-label={t.T("globals.fields.type")}>
                  <span class="badge enum" x-bind:class="`bounce-${b.type}`" x-text="b.type"></span>
                </td>
                <td
                  data-label={t.T("globals.fields.createdAt")}
                  x-text="niceDate(b.created_at)"
                ></td>
              </tr>
            </template>
            <EmptyRow when="!bounces.length" colspan={4} t={t} />
          </tbody>
        </table>
      </div>
    </div>
  );
}
function Tabs({
  id,
  tab,
  t,
  can,
}: {
  id: string;
  tab: SubscriberTab;
  t: Translation;
  can: AdminRequest["can"];
}) {
  const base = `/admin/subscribers/${id}`;
  const selected = (name: SubscriberTab) => (tab === name ? { "aria-selected": "true" } : {});
  return (
    <div role="tablist" data-variant="primary">
      <a role="tab" href={base} {...selected("activity")}>
        <Icon name="user" /> {t.T("globals.buttons.view")}
      </a>
      <a role="tab" href={`${base}/edit`} {...selected("edit")}>
        <Icon name="edit-2" /> {t.T("globals.buttons.edit")}
      </a>
      <a role="tab" href={`${base}/lists`} {...selected("lists")}>
        <Icon name="list" />{" "}
        <span>
          {t.Tc("globals.terms.lists", 2)} <span x-text="`(${subscriptions.length})`"></span>
        </span>
      </a>
      {can("bounces:get") ? (
        <a role="tab" href={`${base}/bounces`} {...selected("bounces")}>
          <Icon name="corner-right-down" /> {t.T("globals.terms.bounces")}
        </a>
      ) : null}
    </div>
  );
}
const anySubscribers = ["subscribers:get", "subscribers:get_all"];
const keys = [...subscriberKeys, "lists.optins.single", "lists.optins.double"];

export const newSubscriberView: AdminView = ({ context, can }) => {
  const t = context.app.i18n;
  const title = t.T("subscribers.newSubscriber");
  return {
    title: `${title} / ${t.T("globals.terms.subscribers")}`,
    pageId: "subscribers.all",
    script: "subscribers",
    translationKeys: keys,
    config: { is_new: true },
    body: (
      <>
        <Breadcrumbs
          parent={t.T("globals.terms.subscribers")}
          href={can(...anySubscribers) ? "/admin/subscribers" : null}
          current={title}
        />
        <section class="subscribers" x-data="subscribersView">
          <header class="row page-header">
            <div class="col-6">
              <div class="hstack gap-1">
                <div class="avatar avatar-title">
                  <h1 class="page-title avatar-label">{title}</h1>
                </div>
              </div>
            </div>
          </header>
          <SubscriberForm t={t} isNew canSave={can("subscribers:manage")} />
        </section>
      </>
    ),
  };
};

export function subscriberView(tab: SubscriberTab): AdminView {
  return ({ context, can }) => {
    const t = context.app.i18n;
    if (tab === "bounces" && !can("bounces:get"))
      throw new HttpError(403, t.Ts("globals.messages.permissionDenied", "name", "bounces:get"));
    const id = String(getID(context));
    const canSave = can("subscribers:manage");
    return {
      title: t.T("globals.terms.subscribers"),
      pageId: "subscribers.all",
      script: "subscribers",
      translationKeys: keys,
      config: { subscriber_id: id, tab },
      body: (
        <section class="subscribers" x-data="subscribersView">
          <Breadcrumbs
            parent={t.T("globals.terms.subscribers")}
            href="/admin/subscribers"
            current={<span x-text="form.email"></span>}
          />
          <Alert name="error" />
          <div x-show="ready" style="display: none">
            <header class="row page-header">
              <div class="col-6">
                <div class="hstack gap-1">
                  <div
                    class="avatar avatar-title"
                    x-bind:class="{ disabled: form.status === 'blocklisted' }"
                  >
                    <AvatarLink
                      kind="subscriber"
                      name="form.name || form.email"
                      href="`/admin/subscribers/${form.id}`"
                      title="viewTitle(form.name || form.email)"
                    />
                    <h1 class="page-title avatar-label">
                      <span x-text="form.email"></span>{" "}
                      <template x-if="form.status !== 'enabled'">
                        <span class="badge" x-bind:class="`status-${form.status}`">
                          <span class="dot">●</span> <span x-text="statusLabel(form.status)"></span>
                        </span>
                      </template>
                    </h1>
                  </div>
                </div>
              </div>
              <div class="col-6 hstack justify-end buttons">
                {tab === "lists" && canSave ? (
                  <>
                    <template x-if="form.status !== 'blocklisted'">
                      <button
                        type="button"
                        class="outline external"
                        data-testid="btn-send-optin"
                        x-bind:disabled="!hasOptinSub"
                        {...{ "x-on:click.prevent": "onSendOptin" }}
                      >
                        <Icon name="mail" /> {t.T("subscribers.sendOptinConfirm")}
                      </button>
                    </template>
                    <button
                      type="button"
                      data-variant="primary"
                      data-testid="btn-manage"
                      {...{ "x-on:click.prevent": "onOpenManage" }}
                    >
                      <Icon name="list" /> {t.T("globals.buttons.manage")}
                    </button>
                  </>
                ) : null}
                {tab === "bounces" && can("bounces:manage") ? (
                  <template x-if="bounces.length">
                    <button
                      type="button"
                      class="outline external"
                      data-variant="danger"
                      data-testid="btn-clear-bounces"
                      {...{ "x-on:click.prevent": "onDeleteBounces" }}
                    >
                      <Icon name="trash-2" /> {t.T("globals.buttons.clear")}
                    </button>
                  </template>
                ) : null}
              </div>
            </header>
            <Tabs id={id} tab={tab} t={t} can={can} />
            {tab === "edit" ? <SubscriberForm t={t} isNew={false} canSave={canSave} /> : null}
            {tab === "lists" ? <Subscriptions t={t} canSave={canSave} /> : null}
            {tab === "bounces" ? <Bounces t={t} /> : null}
            {tab === "activity" ? <Overview t={t} /> : null}
          </div>
        </section>
      ),
    };
  };
}
