// Adapted from listmonk static/admin/views/lists.html and cmd/lists.go (ViewLists) at 6fcd95f.
// Upstream renders the rows into the page; here lists.js reads the page of rows from /api/lists,
// which owns list scope. At a million memberships that read holds the server for the counts it
// joins (about 1.3 s with app.cache_slow_queries off). The shell has already arrived by then, and
// this is the only screen that asks for counts of many lists.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import {
  Alert,
  AvatarLink,
  EmptyRow,
  FilterBadge,
  filterURL,
  HiddenFields,
  SortLink,
} from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";

/** Keys lists.js reads, on the index and the list page. */
export const listKeys = [
  "globals.buttons.view",
  "globals.buttons.filter",
  "globals.messages.copied",
  "globals.messages.confirmDelete",
  "globals.messages.created",
  "globals.messages.deleted",
  "globals.messages.deletedCount",
  "globals.messages.numSelected",
  "globals.messages.selectAll",
  "globals.messages.updated",
  "globals.terms.list",
  "globals.terms.subscribers",
  "globals.fields.status",
  "globals.terms.private",
  "globals.terms.public",
  "globals.terms.confirmed",
  "globals.terms.unconfirmed",
  "globals.terms.unsubscribed",
  "lists.confirmDelete",
  "lists.confirmSub",
  "lists.optinTo",
  "lists.optins.double",
  "lists.optins.single",
];

function Menu(props: { t: Translation; campaigns: boolean; canImport: boolean }) {
  const { t, campaigns, canImport } = props;
  return (
    <ot-dropdown>
      <button
        popovertarget=""
        x-bind:popovertarget="'list-actions-' + l.id"
        type="button"
        class="ghost more icon"
        aria-label={t.T("globals.buttons.more")}
      >
        <Icon name="more-vertical" />
      </button>
      <menu popover="" x-bind:id="'list-actions-' + l.id">
        <a
          x-bind:href="'/admin/lists/' + l.id"
          role="menuitem"
          class="button ghost"
          data-testid="btn-view"
        >
          <Icon name="eye" /> {t.T("globals.buttons.view")}
        </a>
        <a
          x-bind:href="analyticsLink(l)"
          role="menuitem"
          class="button ghost"
          data-testid="btn-analytics"
        >
          <Icon name="bar-chart-2" /> {t.T("globals.terms.analytics")}
        </a>
        {campaigns || canImport ? <hr /> : null}
        <template x-if="canManage(l.id)">
          <a
            x-bind:href="'/admin/lists/' + l.id + '/edit'"
            role="menuitem"
            class="button ghost"
            data-testid="btn-edit"
          >
            <Icon name="edit-2" /> {t.T("globals.buttons.edit")}
          </a>
        </template>
        {canImport ? (
          <a
            x-bind:href="'/admin/subscribers/import?list_id=' + l.id"
            role="menuitem"
            class="button ghost"
            data-testid="btn-import"
          >
            <Icon name="upload" /> {t.T("globals.terms.import")}
          </a>
        ) : null}
        <template x-if="canManage(l.id)">
          <button
            type="button"
            role="menuitem"
            class="ghost"
            data-variant="danger"
            data-testid="btn-delete"
            x-bind:disabled="isLoading('lists')"
            {...{ "x-on:click.prevent": "onDeleteList(l.id, l.name)" }}
          >
            <Icon name="trash-2" /> {t.T("globals.buttons.delete")}
          </button>
        </template>
        {campaigns ? (
          <>
            <hr />
            <a
              x-bind:href="'/admin/campaigns/new?list_id=' + l.id"
              role="menuitem"
              class="button ghost"
              data-testid="btn-campaign"
            >
              <Icon name="send" /> {t.T("campaigns.newCampaign")}
            </a>
            <template x-if="l.optin === 'double'">
              <button
                type="button"
                role="menuitem"
                class="ghost send-optin"
                data-testid="btn-send-optin-campaign"
                x-bind:disabled="isLoading('lists')"
                {...{ "x-on:click.prevent": "onCreateOptinCampaign(l.id, l.name)" }}
              >
                <Icon name="send" /> {t.T("lists.sendOptinCampaign")}
              </button>
            </template>
          </>
        ) : null}
      </menu>
    </ot-dropdown>
  );
}
function Counts({ t, subscribers }: { t: Translation; subscribers: boolean }) {
  const total = t.T("globals.terms.subscribers");
  return (
    <td class="subscribers" data-label={total}>
      {subscribers ? (
        <a
          class="subscriber-total"
          x-bind:href="'/admin/subscribers/lists/' + l.id"
          title={`${t.T("globals.buttons.view")} ${total}`}
          x-text="formatNumber(l.subscriber_count)"
        ></a>
      ) : (
        <span class="subscriber-total" x-text="formatNumber(l.subscriber_count)"></span>
      )}
      <div class="subscriber-breakdown">
        <div class="subscriber-meters" role="group" x-bind:aria-label="metersLabel(l)">
          <template x-for="m in stats(l)" x-bind:key="m.status">
            <meter
              x-bind:class="'status-' + m.status"
              min="0"
              x-bind:max="m.total"
              x-bind:value="m.count"
              x-bind:style="'width: ' + m.percent + '%'"
              x-bind:aria-label="m.label"
              x-bind:aria-valuetext="m.title"
              x-bind:title="m.title"
              x-text="m.title"
            ></meter>
          </template>
        </div>
        <div class="subscriber-legend text-8">
          <template x-for="m in stats(l)" x-bind:key="m.status">
            <a
              class="unstyled text-grey"
              x-bind:href="'/admin/subscribers/lists/' + l.id + '?subscription_status=' + m.status"
              x-bind:title="m.title"
              x-bind:aria-label="m.title"
            >
              <span class="status-icon" x-bind:class="'status-' + m.status" aria-hidden="true">
                <template x-if="m.status === 'unconfirmed'">
                  <span>?</span>
                </template>
                <template x-if="m.status !== 'unconfirmed'">
                  <svg class="icon">
                    <use x-bind:href="statusIcon(m.status)"></use>
                  </svg>
                </template>
              </span>{" "}
              <span x-text="'' + round(m.percent) + '%'"></span>
            </a>
          </template>
        </div>
      </div>
    </td>
  );
}
function Row(props: {
  t: Translation;
  subscribers: boolean;
  campaigns: boolean;
  canImport: boolean;
}) {
  const { t, subscribers, campaigns, canImport } = props;
  return (
    <tr class="list-main-row" data-testid="list-row" x-bind:data-id="l.id">
      <td>
        <input name="id" type="checkbox" x-bind:value="l.id" />
      </td>
      <td class="list-name">
        <div class="avatar" x-bind:class="{ disabled: l.status === 'archived' }">
          <AvatarLink
            kind="list"
            name="l.name"
            href="'/admin/lists/' + l.id"
            title="viewTitle(l.name)"
          />
          <div class="avatar-label">
            <a x-bind:href="'/admin/lists/' + l.id" class="unstyled" x-text="l.name"></a>
            <template x-if="l.description">
              <div
                class="description text-light text-8"
                x-bind:title="l.description"
                x-text="l.description"
              ></div>
            </template>
            <div class="hstack gap-2 text-8">
              <template x-for="tag in l.tags" x-bind:key="tag">
                <a
                  x-bind:href="tagLink(tag)"
                  x-bind:title="filterTitle(tag)"
                  x-text="'#' + tag"
                ></a>
              </template>
            </div>
          </div>
        </div>
      </td>
      <td>
        <div class="hstack">
          <a
            x-bind:href="'/admin/lists?type=' + l.type"
            x-bind:title="filterTitle(typeLabel(l.type))"
          >
            <span class="badge enum" x-bind:class="'type-' + l.type">
              <svg class="icon">
                <use x-bind:href="typeIcon(l.type)"></use>
              </svg>{" "}
              <span x-text="typeLabel(l.type)"></span>
            </span>
          </a>
          <a
            x-bind:href="'/admin/lists?optin=' + l.optin"
            x-bind:title="filterTitle(optinLabel(l.optin))"
          >
            <span class="badge enum">
              <svg class="icon">
                <use x-bind:href="optinIcon(l.optin)"></use>
              </svg>{" "}
              <span x-text="optinLabel(l.optin)"></span>
            </span>
          </a>
        </div>
      </td>
      <Counts t={t} subscribers={subscribers} />
      <td
        class="date-stack"
        data-label={t.T("globals.fields.createdAt")}
        x-text="niceDate(l.created_at)"
      ></td>
      <td class="actions align-right">
        <Menu t={t} campaigns={campaigns} canImport={canImport} />
      </td>
    </tr>
  );
}

export const listsView: AdminView = ({ context, site, can, listScope }) => {
  const t = context.app.i18n;
  const base = "/admin/lists";
  const params = context.url.searchParams;
  const status = params.get("status") ?? "";
  const type = params.get("type") ?? "";
  const optin = params.get("optin") ?? "";
  const tag = params.get("tag") ?? "";
  const pageNumber = Number(params.get("page") ?? 1);
  const term = (name: string) => t.T(`globals.terms.${name}`);
  const sort = (field: string, label: string) => (
    <SortLink base={base} params={params} field={field} label={label} />
  );
  const manage = listScope("list:manage");
  const remove = {
    "x-on:click.prevent": "onDeleteSelected(numSelected, selectedQueryParams().toString())",
  };
  return {
    title: term("lists"),
    pageId: status === "archived" ? "lists.archived" : "lists.all",
    script: "lists",
    translationKeys: listKeys,
    config: { manage_lists: manage.all ? "all" : manage.ids.join(",") },
    body: (
      <section class="lists" x-data="listsView">
        <header class="hstack justify-between page-header">
          <div class="hstack page-heading">
            <h1 class="page-title">
              {term("lists")} <span x-text="'(' + (page.total != null ? page.total : '-') + ')'"></span>
            </h1>
            {status === "archived" ? (
              <FilterBadge t={t} label={term("archived")} url={filterURL(base, params, "status")} />
            ) : null}
            {type ? (
              <FilterBadge
                t={t}
                class="enum"
                label={
                  <>
                    <Icon name={type === "public" ? "eye" : "eye-off"} /> {term(type)}
                  </>
                }
                url={filterURL(base, params, "type")}
              />
            ) : null}
            {optin ? (
              <FilterBadge
                t={t}
                class="enum"
                label={
                  <>
                    <Icon name={optin === "double" ? "user-check" : "user-x"} />{" "}
                    {t.T(`lists.optins.${optin}`)}
                  </>
                }
                url={filterURL(base, params, "optin")}
              />
            ) : null}
            {tag ? (
              <FilterBadge
                t={t}
                class="tag"
                label={`#${tag}`}
                url={filterURL(base, params, "tag")}
              />
            ) : null}
            {pageNumber > 1 ? (
              <FilterBadge
                t={t}
                label={t.Ts("globals.terms.page", "n", String(pageNumber))}
                url={filterURL(base, params)}
              />
            ) : null}
          </div>
          <div class="hstack justify-end buttons">
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
            {can("lists:manage_all") ? (
              <a
                href="/admin/lists/new"
                class="button"
                data-variant="primary"
                data-testid="btn-new"
              >
                <Icon name="plus" /> {t.T("globals.buttons.new")}
              </a>
            ) : null}
          </div>
        </header>

        <Alert name="error" />
        <div class="card page-content has-table">
          <div
            class="table-wrapper"
            x-data="table({ query: urlParams.get('query') || '', filters: urlFilters() })"
            x-effect="total = page.total || 0"
            x-bind:aria-busy="loading"
            x-on:change="onChange($event)"
          >
            <template x-if="numSelected > 0">
              <ot-dropdown class="bulk-actions" data-variant="primary">
                <button
                  popovertarget="bulk-actions"
                  type="button"
                  class="small"
                  data-testid="btn-bulk-actions"
                >
                  <span x-text="numSelectedLabel"></span> <Icon name="more-vertical" />
                </button>
                <menu popover="" id="bulk-actions">
                  <template x-if="page.total > page.per_page">
                    <button
                      type="button"
                      role="menuitem"
                      class="ghost"
                      data-testid="select-all-lists"
                      x-show="!allSelected"
                      {...{ "x-on:click.prevent": "onSelectAllQuery()" }}
                    >
                      <Icon name="list" /> <span x-text="selectAllLabel"></span>
                    </button>
                  </template>
                  <button
                    type="button"
                    role="menuitem"
                    class="ghost"
                    data-variant="danger"
                    data-testid="btn-delete-lists"
                    x-bind:disabled="isLoading('lists')"
                    {...remove}
                  >
                    <Icon name="trash-2" /> {t.T("globals.buttons.delete")}{" "}
                    <span x-text="numSelected"></span>
                  </button>
                </menu>
              </ot-dropdown>
            </template>
            <table class="has-select">
              <thead>
                <tr>
                  <th width="5%">
                    <input type="checkbox" aria-label={t.T("globals.buttons.toggleSelect")} />
                  </th>
                  <th width="27%">{sort("name", t.T("globals.fields.name"))}</th>
                  <th width="22%">{sort("type", t.T("globals.fields.type"))}</th>
                  <th width="20%" class="subscribers">
                    {sort("subscriber_count", term("subscribers"))}
                  </th>
                  <th width="12%">{sort("created_at", t.T("globals.fields.createdAt"))}</th>
                  <th width="5%" class="align-right"></th>
                </tr>
              </thead>
              <tbody>
                <template x-for="l in lists" x-bind:key="l.id">
                  <Row
                    t={t}
                    subscribers={can("subscribers:get", "subscribers:get_all")}
                    campaigns={can("campaigns:manage", "campaigns:manage_all")}
                    canImport={can("subscribers:import")}
                  />
                </template>
                <EmptyRow when="!loading && !error && !lists.length" colspan={6} t={t} />
              </tbody>
            </table>
            <nav class="pagination" aria-label="Pagination" x-show="pages.length > 1">
              <template x-for="p in pages" x-bind:key="p.key">
                <a
                  x-bind:href="p.href"
                  x-bind:class="{ 'pg-selected': p.current }"
                  x-bind:aria-current="p.current ? 'page' : null"
                  x-text="p.label"
                ></a>
              </template>
            </nav>
            {site.cacheSlowQueries ? (
              <p class="text-light">*{t.T("globals.messages.slowQueriesCached")}</p>
            ) : null}
          </div>
        </div>
      </section>
    ),
  };
};
