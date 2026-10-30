// Adapted from listmonk static/admin/views/templates.html and cmd/templates.go (ViewTemplates) at
// 6fcd95f. Upstream renders the rows into the page; here templates.js reads them from
// /api/templates. Visual templates are deferred (D54), so that type has no filter or badge.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import {
  Alert,
  AvatarLink,
  Breadcrumbs,
  EmptyRow,
  FilterBadge,
  filterURL,
  HiddenFields,
  PreviewDialog,
  SortLink,
} from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";

/** Keys templates.js reads, on the index and the template page. */
export const templateKeys = [
  "globals.buttons.filter",
  "globals.buttons.view",
  "globals.fields.name",
  "globals.messages.confirm",
  "globals.messages.copied",
  "globals.messages.copyOf",
  "globals.messages.created",
  "globals.messages.deleted",
  "globals.messages.updated",
  "globals.terms.campaign",
  "globals.terms.tx",
];

function Menu({ t, canManage }: { t: Translation; canManage: boolean }) {
  return (
    <ot-dropdown>
      <button
        popovertarget=""
        x-bind:popovertarget="`tpl-actions-${t.id}`"
        type="button"
        class="ghost more icon"
        aria-label={t.T("globals.buttons.more")}
      >
        <Icon name="more-vertical" />
      </button>
      <menu popover="" x-bind:id="`tpl-actions-${t.id}`">
        <button
          type="button"
          role="menuitem"
          class="ghost"
          data-testid="btn-preview"
          {...{ "x-on:click.prevent": "onPreview(t.id, t.name)" }}
        >
          <Icon name="eye" /> {t.T("globals.buttons.preview")}
        </button>
        <hr />
        <a
          x-bind:href="`/admin/templates/${t.id}`"
          role="menuitem"
          class="button ghost"
          data-testid="btn-edit"
        >
          <Icon name="edit-2" /> {t.T("globals.buttons.edit")}
        </a>
        {canManage ? (
          <>
            <button
              type="button"
              role="menuitem"
              class="ghost"
              data-testid="btn-clone"
              {...{ "x-on:click.prevent": "onClone(t.id, t.name)" }}
            >
              <Icon name="copy" /> {t.T("globals.buttons.clone")}
            </button>
            <template x-if="!t.is_default && t.type === 'campaign'">
              <button
                type="button"
                role="menuitem"
                class="ghost"
                data-testid="btn-set-default"
                x-bind:disabled="isLoading('templates')"
                {...{ "x-on:click.prevent": "onSetDefault(t.id, t.name)" }}
              >
                <Icon name="check-circle" /> {t.T("globals.buttons.setDefault")}
              </button>
            </template>
            <template x-if="!t.is_default">
              <hr />
            </template>
            <template x-if="!t.is_default">
              <button
                type="button"
                role="menuitem"
                class="ghost"
                data-variant="danger"
                data-testid="btn-delete"
                x-bind:disabled="isLoading('templates')"
                {...{ "x-on:click.prevent": "onDelete(t.id, t.name)" }}
              >
                <Icon name="trash-2" /> {t.T("globals.buttons.delete")}
              </button>
            </template>
          </>
        ) : null}
      </menu>
    </ot-dropdown>
  );
}
function Row({ t, canManage }: { t: Translation; canManage: boolean }) {
  return (
    <tr data-testid="template-row" x-bind:data-id="t.id">
      <td>
        <div class="avatar">
          <AvatarLink
            kind="campaign-template"
            name="t.name"
            href="`/admin/templates/${t.id}`"
            title="viewTitle(t.name)"
          />
          <div class="avatar-label">
            <a
              x-bind:href="`/admin/templates/${t.id}`"
              class="unstyled"
              x-bind:class="{ default: t.is_default }"
              data-testid="btn-edit"
              x-text="t.name"
            ></a>{" "}
            <template x-if="t.is_default">
              <span class="badge">{t.T("globals.terms.default")}</span>
            </template>
            <template x-if="t.type === 'tx'">
              <p class="text-light" x-text="t.subject"></p>
            </template>
          </div>
        </div>
      </td>
      <td>
        <div class="hstack">
          <a x-bind:href="typeLink(t.type)" x-bind:title="filterTitle(typeLabel(t.type))">
            <span class="badge enum">
              <svg class="icon">
                <use x-bind:href="typeIcon(t.type)"></use>
              </svg>{" "}
              <span x-text="typeLabel(t.type)"></span>
            </span>
          </a>
          <template x-if="t.type === 'campaign'">
            <a x-bind:href="typeLink(t.type)" title={`${t.T("globals.buttons.filter")} HTML`}>
              <span class="badge enum">
                <Icon name="code" /> HTML
              </span>
            </a>
          </template>
        </div>
      </td>
      <td
        class="date-stack"
        data-label={t.T("globals.fields.createdAt")}
        x-text="niceDate(t.created_at)"
      ></td>
      <td class="actions align-right">
        <Menu t={t} canManage={canManage} />
      </td>
    </tr>
  );
}

export const templatesView: AdminView = ({ context, can }) => {
  const t = context.app.i18n;
  const base = "/admin/templates";
  const params = context.url.searchParams;
  const type = params.get("type") ?? "";
  const canManage = can("templates:manage");
  const title = t.T("globals.terms.templates");
  const sort = (field: string, label: string) => (
    <SortLink base={base} params={params} field={field} label={label} />
  );
  const badge = type === "tx" ? t.Tc("globals.terms.tx", 1) : t.Tc("globals.terms.campaign", 1);
  return {
    title,
    pageId: "campaigns.templates",
    script: "templates",
    translationKeys: templateKeys,
    body: (
      <>
        <Breadcrumbs
          parent={t.T("globals.terms.campaigns")}
          href={can("campaigns:get", "campaigns:get_all") ? "/admin/campaigns" : null}
          current={title}
        />
        <section class="templates" x-data="templatesView">
          <header class="row page-header">
            <div class="col-4">
              <h1 class="page-title">
                {title} <span x-text="`(${templates.length})`"></span>
                {type ? (
                  <FilterBadge
                    t={t}
                    class="enum"
                    label={type === "tx" || type === "campaign" ? badge : type}
                    url={filterURL(base, params, "type")}
                  />
                ) : null}
              </h1>
            </div>
            <div class="col-8 hstack justify-end buttons">
              <form method="get" action={base} class="search-form">
                <HiddenFields params={params} exclude={["query"]} />
                <fieldset class="group">
                  <input
                    name="query"
                    aria-label="Search"
                    data-testid="query"
                    placeholder="Search"
                    value={params.get("query") ?? ""}
                    autofocus
                  />
                  <button
                    type="submit"
                    class="outline external"
                    data-testid="btn-query"
                    aria-label="Search"
                  >
                    <Icon name="search" />
                  </button>
                </fieldset>
              </form>
              {canManage ? (
                <a href={`${base}/new`} class="button" data-variant="primary" data-testid="btn-new">
                  <Icon name="plus" /> {t.T("globals.buttons.new")}
                </a>
              ) : null}
            </div>
          </header>

          <Alert name="error" />
          <div class="card page-content has-table">
            <div class="table-wrapper" x-bind:aria-busy="loading">
              <table>
                <thead>
                  <tr>
                    <th>{sort("name", t.T("globals.fields.name"))}</th>
                    <th>{sort("type", t.T("globals.fields.type"))}</th>
                    <th>{sort("created_at", t.T("globals.fields.createdAt"))}</th>
                    <th class="actions align-right"></th>
                  </tr>
                </thead>
                <tbody>
                  <template x-for="t in templates" x-bind:key="t.id">
                    <Row t={t} canManage={canManage} />
                  </template>
                  <EmptyRow when="!loading && !error && !templates.length" colspan={4} t={t} />
                </tbody>
              </table>
            </div>
          </div>

          <PreviewDialog t={t} />
        </section>
      </>
    ),
  };
};
