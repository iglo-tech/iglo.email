// Adapted from listmonk static/admin/views/list.html, partials/list-form.html and list-info.html at
// 6fcd95f. The list arrives from /api/lists/:id. The list charts and its campaign table have no
// endpoint at this stage (and the table is M4.3's), so the overview links to list analytics.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import { listKeys } from "@/admin/views/lists";
import { Alert, AvatarLink, Breadcrumbs } from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";
import { HttpError } from "@/server/response";
import { getID } from "@/server/validation";

function ListForm(props: { t: Translation; isNew: boolean; canSave: boolean }) {
  const { t, isNew, canSave } = props;
  const submit = { "x-on:submit.prevent": isNew ? "onSubmitNew" : "onSubmitUpdate" };
  return (
    <form method="post" {...submit}>
      <div class="page-content content">
        <section class="card">
          <label data-field="">
            {t.T("globals.fields.name")}
            <input name="name" maxlength="200" autofocus required x-model="form.name" />
          </label>
          <div data-field="">
            <label for="list-type">{t.T("globals.fields.type")}</label>
            <select
              name="type"
              id="list-type"
              aria-describedby="list-type-hint"
              required
              x-model="form.type"
            >
              <option value="private">{t.T("globals.terms.private")}</option>
              <option value="public">{t.T("globals.terms.public")}</option>
            </select>
            <small id="list-type-hint" data-hint="">
              {t.T("lists.typeHelp")}
            </small>
          </div>
          <div data-field="">
            <label for="list-optin">{t.T("lists.optin")}</label>
            <select
              name="optin"
              id="list-optin"
              aria-describedby="list-optin-hint"
              required
              x-model="form.optin"
            >
              <option value="single">{t.T("lists.optins.single")}</option>
              <option value="double">{t.T("lists.optins.double")}</option>
            </select>
            <small id="list-optin-hint" data-hint="">
              {t.T("lists.optinHelp")}
            </small>
          </div>
          <label data-field="">
            {t.T("globals.terms.tags")}
            <ot-taginput x-model="form.tags">
              <input name="tags" placeholder={t.T("globals.terms.tags")} maxlength="50" />
            </ot-taginput>
          </label>
          <label data-field="">
            {t.T("globals.fields.description")}
            <textarea name="description" maxlength="2000" x-model="form.description"></textarea>
          </label>
          <label data-field="">
            <input type="checkbox" role="switch" x-model="isArchived" />{" "}
            {t.T("globals.terms.archived")}
            <small data-hint="">{t.T("lists.archivedHelp")}</small>
          </label>
        </section>
        <footer class="hstack justify-end mt-6">
          <div class="hstack gap-3 justify-end">
            {canSave ? (
              <button
                type="submit"
                data-variant="primary"
                data-testid="btn-save"
                data-spinner="small"
                x-bind:disabled="isLoading('lists.save')"
                x-bind:aria-busy="isLoading('lists.save')"
              >
                {t.T("globals.buttons.save")}
              </button>
            ) : null}
          </div>
        </footer>
      </div>
    </form>
  );
}
function Stat(props: { title: unknown; value: string; href: string }) {
  return (
    <div class="col-3">
      <article class="card float stat-card">
        <h4 class="title">{props.title as never}</h4>
        <div class="stat-value">
          <a x-bind:href={props.href} class="unstyled" x-text={props.value}></a>
        </div>
      </article>
    </div>
  );
}
function Overview({ t, subscribers }: { t: Translation; subscribers: boolean }) {
  const copy = (field: string, label: string) => (
    <button
      type="button"
      class="small"
      data-variant="secondary"
      title={t.T("globals.messages.clickToCopy")}
      aria-label={label}
      x-on:click={`copyToClipboard(form.${field})`}
    >
      <strong>{label}</strong> <span x-text={`form.${field}`}></span>
    </button>
  );
  const link = "'/admin/subscribers/lists/' + form.id";
  return (
    <div class="vstack gap-6">
      <div class="card">
        <div class="row">
          <div class="col-3">
            <div class="hstack gap-2">
              <a x-bind:href="'/admin/lists?type=' + form.type">
                <span class="badge enum" x-bind:class="'type-' + form.type">
                  <svg class="icon">
                    <use x-bind:href="typeIcon(form.type)"></use>
                  </svg>{" "}
                  <span x-text="typeLabel(form.type)"></span>
                </span>
              </a>
              <a x-bind:href="'/admin/lists?optin=' + form.optin">
                <span class="badge enum">
                  <svg class="icon">
                    <use x-bind:href="optinIcon(form.optin)"></use>
                  </svg>{" "}
                  <span x-text="optinLabel(form.optin)"></span>
                </span>
              </a>
              <template x-if="isArchived">
                <span class="badge enum status-archived">{t.T("globals.terms.archived")}</span>
              </template>
            </div>
            <div class="text-small text-light mt-2" x-text="niceDate(form.created_at)"></div>
          </div>
          <div class="col-9">
            <p class="text-small text-light mb-2">
              <span x-text="form.description"></span>{" "}
              <template x-for="tag in form.tags" x-bind:key="tag">
                <span>
                  <a
                    x-bind:href="'/admin/lists?tag=' + encodeURIComponent(tag)"
                    class="tag"
                    x-bind:title="filterTitle(tag)"
                    x-text="'#' + tag"
                  ></a>{" "}
                </span>
              </template>
            </p>
            <div class="hstack gap-2 justify-end">
              <a
                x-bind:href="analyticsLink(form)"
                class="button small"
                data-variant="secondary"
                data-testid="btn-analytics"
              >
                <Icon name="bar-chart-2" /> {t.T("globals.terms.analytics")}
              </a>
              {copy("id", t.T("globals.fields.id"))}
              {copy("uuid", t.T("globals.fields.uuid"))}
            </div>
          </div>
        </div>
      </div>
      <section class="row">
        <Stat
          title={
            <>
              <Icon name="at-sign" /> {t.T("globals.terms.subscribers")}
            </>
          }
          value="formatNumber(form.subscriber_count)"
          href={subscribers ? link : "''"}
        />
        {["confirmed", "unconfirmed", "unsubscribed"].map((status) => (
          <Stat
            title={t.T(`globals.terms.${status}`)}
            value={`formatNumber(form.subscriber_statuses ? form.subscriber_statuses.${status} : 0)`}
            href={subscribers ? `${link} + '?subscription_status=${status}'` : "''"}
          />
        ))}
      </section>
    </div>
  );
}

export const newListView: AdminView = ({ context, can }) => {
  const t = context.app.i18n;
  const title = t.T("lists.newList");
  return {
    title: `${title} / ${t.T("globals.terms.lists")}`,
    pageId: "lists.all",
    script: "lists",
    translationKeys: listKeys,
    config: { is_new: true },
    body: (
      <>
        <Breadcrumbs parent={t.T("globals.terms.lists")} href="/admin/lists" current={title} />
        <section class="lists" x-data="listsView">
          <header class="page-header">
            <div class="hstack gap-3">
              <div class="avatar avatar-title">
                <h1 class="page-title avatar-label">{title}</h1>
              </div>
            </div>
          </header>
          <ListForm t={t} isNew canSave={can("lists:manage_all")} />
        </section>
      </>
    ),
  };
};

export function listView(tab: "list" | "edit"): AdminView {
  return ({ context, can, listScope }) => {
    const t = context.app.i18n;
    const id = BigInt(getID(context));
    const allowed = (permission: "list:get" | "list:manage") => {
      const scope = listScope(permission);
      return scope.all || scope.ids.includes(id);
    };
    if (!allowed("list:get"))
      throw new HttpError(403, t.Ts("globals.messages.permissionDenied", "name", "lists"));
    const base = `/admin/lists/${id}`;
    const selected = (name: string) => (tab === name ? { "aria-selected": "true" } : {});
    return {
      title: t.T("globals.terms.lists"),
      pageId: "lists.all",
      script: "lists",
      translationKeys: listKeys,
      config: { list_id: String(id) },
      body: (
        <section class="lists" x-data="listsView">
          <Breadcrumbs
            parent={t.T("globals.terms.lists")}
            href="/admin/lists"
            current={<span x-text="form.name"></span>}
          />
          <Alert name="error" />
          <div x-show="ready" style="display: none">
            <header class="page-header">
              <div class="hstack gap-3">
                <div class="avatar avatar-title" x-bind:class="{ disabled: isArchived }">
                  <AvatarLink
                    kind="list"
                    name="form.name"
                    href="'/admin/lists/' + form.id"
                    title="viewTitle(form.name)"
                  />
                  <h1 class="page-title avatar-label" x-text="form.name"></h1>
                </div>
              </div>
            </header>
            <div role="tablist" data-variant="primary">
              <a role="tab" href={base} {...selected("list")}>
                <Icon name="list" /> {t.T("globals.buttons.view")}
              </a>
              <a role="tab" href={`${base}/edit`} {...selected("edit")}>
                <Icon name="edit-2" /> {t.T("globals.buttons.edit")}
              </a>
            </div>
            {tab === "edit" ? (
              <ListForm t={t} isNew={false} canSave={allowed("list:manage")} />
            ) : (
              <Overview t={t} subscribers={can("subscribers:get", "subscribers:get_all")} />
            )}
          </div>
        </section>
      ),
    };
  };
}
