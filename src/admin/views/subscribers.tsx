// Adapted from listmonk static/admin/views/subscribers.html and cmd/subscribers.go (ViewSubscribers)
// at 6fcd95f. Upstream renders the rows into the page. Here subscribers.js reads them from
// /api/subscribers, as the dashboard reads its sections: the query reader can queue and refuse, and
// the API already owns this screen's filters, list scope and masking.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import {
  Alert,
  AvatarLink,
  EmptyRow,
  FilterBadge,
  filterURL,
  HiddenFields,
  ManageLists,
  SortLink,
  StatusBadge,
} from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";
import { HttpError } from "@/server/response";
import { getID } from "@/server/validation";

const statuses = ["enabled", "disabled", "blocklisted"];
const subscriptions = ["confirmed", "unconfirmed", "unsubscribed"];

/** Keys subscribers.js reads, on the listing and the subscriber page. */
export const subscriberKeys = [
  ...[...statuses, ...subscriptions].map((status) => `globals.terms.${status}`),
  "globals.buttons.view",
  "globals.buttons.filter",
  "globals.terms.lists",
  "globals.messages.copied",
  "globals.messages.created",
  "globals.messages.deleted",
  "globals.messages.done",
  "globals.messages.numSelected",
  "globals.messages.selectAll",
  "globals.messages.updated",
  "subscribers.confirmBlocklist",
  "subscribers.confirmDelete",
  "subscribers.confirmExport",
  "subscribers.invalidJSON",
  "subscribers.listChangeApplied",
  "subscribers.sentOptinConfirm",
  "subscribers.subscribersDeleted",
];

function RowLists() {
  return (
    <div class="hstack lists">
      <template x-for="l in s.lists.slice(0, 3)" x-bind:key="l.id">
        <div class="avatar xsmall">
          <a
            class="unstyled avatar-icon avatar-list"
            x-bind:href="'/admin/lists/' + l.id"
            x-bind:title="listTitle(l)"
            x-bind:aria-label="listTitle(l)"
          >
            <span
              class="badge enum"
              x-bind:class="'status-' + l.subscription_status"
              aria-hidden="true"
            >
              <template x-if="l.subscription_status === 'unconfirmed'">
                <span>?</span>
              </template>
              <template x-if="l.subscription_status !== 'unconfirmed'">
                <svg class="icon">
                  <use x-bind:href="statusIcon(l.subscription_status)"></use>
                </svg>
              </template>
            </span>
          </a>
          <a
            class="unstyled text-light avatar-label"
            x-bind:href="'/admin/subscribers/lists/' + l.id"
            x-bind:title="filterTitle(l.name)"
            x-text="l.name"
          ></a>
        </div>
      </template>
      <template x-if="s.lists.length > 3">
        <a
          x-bind:href="'/admin/subscribers/' + s.id + '/lists'"
          x-bind:title="listNames(s.lists.slice(3))"
          x-text="moreLists(s)"
        ></a>
      </template>
    </div>
  );
}
function RowMenu({ t, manage, bounces }: { t: Translation; manage: boolean; bounces: boolean }) {
  const remove = { "x-on:click.prevent": "onDeleteSubscriber(s.id, s.email)" };
  return (
    <ot-dropdown>
      <button
        popovertarget=""
        x-bind:popovertarget="'sub-actions-' + s.id"
        type="button"
        class="ghost more icon"
        aria-label={t.T("globals.buttons.more")}
      >
        <Icon name="more-vertical" />
      </button>
      <menu popover="" x-bind:id="'sub-actions-' + s.id">
        {manage ? (
          <a
            x-bind:href="'/admin/subscribers/' + s.id + '/edit'"
            role="menuitem"
            class="button ghost"
            data-testid="btn-edit"
          >
            <Icon name="edit-2" /> {t.T("globals.buttons.edit")}
          </a>
        ) : null}
        <hr />
        <a
          x-bind:href="'/admin/subscribers/' + s.id + '/lists'"
          role="menuitem"
          class="button ghost"
        >
          <Icon name="list" /> {t.Tc("globals.terms.lists", 2)}
        </a>
        <a x-bind:href="'/admin/subscribers/' + s.id" role="menuitem" class="button ghost">
          <Icon name="activity" /> {t.T("globals.terms.activity")}
        </a>
        {bounces ? (
          <a
            x-bind:href="'/admin/subscribers/' + s.id + '/bounces'"
            role="menuitem"
            class="button ghost"
          >
            <Icon name="corner-right-down" /> {t.T("globals.terms.bounces")}
          </a>
        ) : null}
        {manage ? (
          <>
            <a
              x-bind:href="'/api/subscribers/' + s.id + '/export'"
              role="menuitem"
              class="button ghost"
              data-testid="btn-download"
            >
              <Icon name="download-cloud" /> {t.T("globals.buttons.downloadData")}
            </a>
            <hr />
            <button
              type="button"
              role="menuitem"
              class="ghost"
              data-variant="danger"
              data-testid="btn-delete"
              x-bind:disabled="isLoading('subscribers')"
              {...remove}
            >
              <Icon name="trash-2" /> {t.T("globals.buttons.delete")}
            </button>
          </>
        ) : null}
      </menu>
    </ot-dropdown>
  );
}
function Row({ t, manage, bounces }: { t: Translation; manage: boolean; bounces: boolean }) {
  return (
    <tr
      data-testid="sub-row"
      x-bind:data-id="s.id"
      x-bind:class="{ blocklisted: s.status === 'blocklisted' }"
    >
      <td>
        <input name="id" type="checkbox" x-bind:value="s.id" />
      </td>
      <td class="email">
        <div class="avatar" x-bind:class="{ disabled: s.status === 'blocklisted' }">
          <AvatarLink
            kind="subscriber"
            name="s.name || s.email"
            href="'/admin/subscribers/' + s.id"
            title="viewTitle(s.name || s.email)"
          />
          <div class="avatar-label">
            <a class="unstyled" x-bind:href="'/admin/subscribers/' + s.id" x-text="s.email"></a>
            <template x-if="s.status !== 'enabled'">
              <a
                x-bind:href="statusFilter(s)"
                class="status-icon"
                x-bind:class="'status-' + s.status"
                x-bind:title="filterTitle(statusLabel(s.status))"
                x-bind:aria-label="filterTitle(statusLabel(s.status))"
              >
                <svg class="icon">
                  <use x-bind:href="statusIcon(s.status)"></use>
                </svg>
              </a>
            </template>
            <RowLists />
          </div>
        </div>
      </td>
      <td class="name" data-label={t.T("globals.fields.name")}>
        <a class="unstyled" x-bind:href="'/admin/subscribers/' + s.id" x-text="s.name"></a>
      </td>
      <td data-label={t.T("globals.fields.createdAt")} x-text="niceDate(s.created_at)"></td>
      <td data-label={t.T("globals.fields.updatedAt")} x-text="niceDate(s.updated_at)"></td>
      <td class="actions align-right">
        <RowMenu t={t} manage={manage} bounces={bounces} />
      </td>
    </tr>
  );
}
function BulkMenu({ t, manage }: { t: Translation; manage: boolean }) {
  const click = (handler: string) => ({ "x-on:click.prevent": handler });
  return (
    <template x-if="numSelected > 0">
      <ot-dropdown class="bulk-actions" data-variant="primary">
        <button
          popovertarget="sub-bulk-actions"
          type="button"
          class="small"
          data-testid="btn-bulk-actions"
        >
          <span x-text="numSelectedLabel"></span> <Icon name="more-vertical" />
        </button>
        <menu popover="" id="sub-bulk-actions">
          <template x-if="page.total > page.per_page">
            <button
              type="button"
              role="menuitem"
              class="ghost"
              data-testid="select-all-subscribers"
              x-show="!allSelected"
              {...click("onSelectAllQuery()")}
            >
              <Icon name="check-square" /> <span x-text="selectAllLabel"></span>
            </button>
          </template>
          <button
            type="button"
            role="menuitem"
            class="ghost"
            data-testid="btn-export-subscribers"
            {...click("onExport(allSelected, selected, total)")}
          >
            <Icon name="download-cloud" /> {t.T("globals.buttons.export")}
          </button>
          {manage ? (
            <>
              <button
                type="button"
                role="menuitem"
                class="ghost"
                data-testid="btn-manage-lists"
                {...click("onOpenManageLists(allSelected, selected)")}
              >
                <Icon name="list" /> {t.T("subscribers.manageLists")}
              </button>
              <button
                type="button"
                role="menuitem"
                class="ghost"
                data-testid="btn-manage-blocklist"
                {...click("onBlocklistSelected(allSelected, selected, total)")}
              >
                <Icon name="user-x" /> {t.T("globals.terms.blocklist")}
              </button>
              <hr />
              <button
                type="button"
                role="menuitem"
                class="ghost"
                data-variant="danger"
                data-testid="btn-delete-subscribers"
                x-bind:disabled="isLoading('subscribers')"
                {...click("onDeleteSelected(allSelected, selected, total)")}
              >
                <Icon name="trash-2" /> {t.T("globals.buttons.delete")}{" "}
                <span x-text="numSelected"></span>
              </button>
            </>
          ) : null}
        </menu>
      </ot-dropdown>
    </template>
  );
}
function SearchForm(props: { base: string; params: URLSearchParams; t: Translation }) {
  const { base, params, t } = props;
  const onToggle = {
    "x-on:toggle": "onSqlToggle($event)",
  };
  return (
    <form action={base} class="search-form" method="get">
      <HiddenFields params={params} exclude={["search", "query", "page"]} />
      <ot-dropdown>
        <fieldset class="group">
          <input
            name="search"
            aria-label="Search"
            data-testid="search"
            placeholder={t.T("subscribers.queryPlaceholder")}
            value={params.get("search") ?? ""}
            x-bind:disabled="isSqlOpen || advanced"
            autofocus
          />
          <button
            type="button"
            class="outline sql-btn dot-indicator"
            x-bind:class="{ 'is-active': advanced, external: !advanced }"
            popovertarget="sql-editor"
            data-testid="btn-advanced-search"
            x-bind:data-variant="advanced ? 'primary' : null"
            aria-label={t.T("globals.terms.advanced")}
          >
            {"SQL {}"}
          </button>
          <button type="submit" data-testid="btn-search" aria-label={t.T("globals.buttons.search")}>
            <Icon name="search" />
          </button>
        </fieldset>
        <div popover="" id="sql-editor" class="sql-editor" data-testid="query-editor" {...onToggle}>
          <div data-field="">
            <textarea
              x-ref="queryInput"
              name="query"
              data-testid="query"
              rows="6"
              placeholder="subscribers.name LIKE '%user%' or subscribers.status='blocklisted'"
              x-model="query"
              x-bind:disabled="!isSqlOpen && !advanced"
            ></textarea>
            <small data-hint="">{t.T("subscribers.advancedQueryHelp")}.</small>
          </div>
          <div class="hstack justify-end buttons">
            <button
              type="button"
              class="outline"
              data-testid="btn-query-reset"
              x-on:click="query = ''"
              x-bind:disabled="query.trim() === ''"
            >
              {t.T("globals.buttons.reset")}
            </button>
            <button type="submit" data-variant="primary" data-testid="btn-query">
              {t.T("globals.fields.query")}
            </button>
          </div>
        </div>
      </ot-dropdown>
    </form>
  );
}

export const subscribersView: AdminView = ({ context, can, listScope }) => {
  const t = context.app.i18n;
  const term = (name: string) => t.T(`globals.terms.${name}`);
  const params = context.url.searchParams;
  const listID = context.params.id === undefined ? null : BigInt(getID(context));
  if (listID !== null) {
    const scope = listScope("list:get");
    if (!scope.all && !scope.ids.includes(listID))
      throw new HttpError(403, t.Ts("globals.messages.permissionDenied", "name", "lists"));
  }
  const base = listID === null ? "/admin/subscribers" : `/admin/subscribers/lists/${listID}`;
  const subStatus = params.get("subscription_status") ?? "";
  const status = params.get("status") ?? "";
  const pageNumber = Number(params.get("page") ?? 1);
  const manage = can("subscribers:manage");
  const sort = (field: string, label: string) => (
    <SortLink base={base} params={params} field={field} label={label} />
  );
  const heading = t.T("globals.terms.subscribers");
  return {
    title: heading,
    pageId: "subscribers.all",
    script: "subscribers",
    translationKeys: subscriberKeys,
    config: { list_id: listID === null ? null : String(listID) },
    body: (
      <section class="subscribers" x-data="subscribersView">
        <header class="hstack justify-between page-header">
          <div class="hstack page-heading">
            <h1 class="page-title">
              {heading} <span x-text="'(' + (page.total != null ? page.total : '-') + ')'"></span>
            </h1>
            {listID !== null ? (
              <FilterBadge
                t={t}
                url="/admin/subscribers"
                class="badge-avatar"
                label={
                  <a href={`/admin/lists/${listID}`} class="unstyled">
                    <span
                      class="avatar xsmall"
                      x-bind:class="{ disabled: currentList && currentList.archived }"
                    >
                      <span class="avatar-icon avatar-list">
                        <span
                          class="avatar-initials"
                          aria-hidden="true"
                          x-text="initials(currentList && currentList.name != null ? currentList.name : '')"
                        ></span>
                      </span>
                      <span
                        class="avatar-label"
                        x-text="currentList && currentList.name != null ? currentList.name : ''"
                      ></span>
                    </span>
                  </a>
                }
              />
            ) : null}
            {subStatus === "none" ? (
              <FilterBadge
                t={t}
                label={t.T("dashboard.orphanSubs")}
                url={filterURL(base, params, "subscription_status")}
              />
            ) : subStatus ? (
              <StatusBadge
                t={t}
                status={subStatus}
                url={filterURL(base, params, "subscription_status")}
              />
            ) : null}
            {status ? (
              <StatusBadge t={t} status={status} url={filterURL(base, params, "status")} />
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
            <SearchForm base={base} params={params} t={t} />
            {manage ? (
              <a
                href="/admin/subscribers/new"
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
            x-data="table({ query: subscriberFilters.query, filters: urlFilters() })"
            x-effect="total = page.total || 0"
            x-bind:aria-busy="loading"
            x-on:change="onChange($event)"
          >
            <BulkMenu t={t} manage={manage} />
            <table class="has-select">
              <thead>
                <tr>
                  <th width="5%">
                    <input type="checkbox" aria-label={t.T("globals.buttons.toggleSelect")} />
                  </th>
                  <th width="48%">{sort("email", t.T("globals.fields.email"))}</th>
                  <th width="18%">{sort("name", t.T("globals.fields.name"))}</th>
                  <th>{sort("created_at", t.T("globals.fields.createdAt"))}</th>
                  <th>{sort("updated_at", t.T("globals.fields.updatedAt"))}</th>
                  <th class="align-right"></th>
                </tr>
              </thead>
              <tbody>
                <template x-for="s in subscribers" x-bind:key="s.id">
                  <Row t={t} manage={manage} bounces={can("bounces:get")} />
                </template>
                <EmptyRow when="!loading && !error && !subscribers.length" colspan={6} t={t} />
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
          </div>
        </div>

        {manage ? (
          <dialog x-ref="listDialog">
            <form {...{ "x-on:submit.prevent": "onSubmitManageLists" }}>
              <div class="dialog-card content">
                <header class="dialog-head">
                  <h4 class="dialog-title">{t.T("subscribers.manageLists")}</h4>
                </header>
                <section class="dialog-body">
                  <ManageLists model="bulk" id="bulk-lists" t={t} />
                </section>
                <footer class="dialog-foot hstack gap-3 justify-end">
                  <button type="button" class="outline" x-on:click="$refs.listDialog.close()">
                    {t.T("globals.buttons.close")}
                  </button>
                  <button
                    type="submit"
                    data-variant="primary"
                    x-bind:disabled="bulk.lists.length === 0"
                  >
                    {t.T("globals.buttons.save")}
                  </button>
                </footer>
              </div>
            </form>
          </dialog>
        ) : null}
      </section>
    ),
  };
};
