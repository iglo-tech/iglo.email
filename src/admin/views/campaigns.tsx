// Adapted from listmonk static/admin/views/campaigns.html, partials/campaigns-table.html and
// cmd/campaigns.go (ViewCampaigns) at 6fcd95f. Upstream renders the rows into the page; here
// campaigns.js reads them from /api/campaigns, which owns list scope, and polls running stats.
import { Icon } from "@/admin/layout/icon";
import type { AdminRequest, AdminView } from "@/admin/page";
import {
  Alert,
  AvatarLink,
  EmptyRow,
  FilterBadge,
  filterURL,
  HiddenFields,
  PreviewDialog,
  SortLink,
  StatusBadge,
} from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";

const statuses = ["draft", "scheduled", "running", "paused", "finished", "cancelled"];
/** Keys campaigns.js and campaign.js read. */
export const campaignKeys = [
  "campaigns.confirmSchedule",
  "editor.anchorName",
  "editor.showRemoteImagesConfirm",
  "editor.blockquote",
  "editor.confirmSwitchFormat",
  "editor.contentType.html",
  "editor.contentType.markdown",
  "editor.contentType.plain",
  "editor.contentType.richtext",
  "editor.contentType.visual",
  "editor.findCount",
  "editor.heading",
  "editor.removed",
  "editor.paragraph",
  "editor.words",
  "globals.buttons.filter",
  "globals.buttons.view",
  "globals.fields.createdAt",
  "globals.fields.duration",
  "globals.fields.endedAt",
  "globals.fields.name",
  "globals.fields.startedAt",
  "globals.messages.confirm",
  "globals.messages.confirmDelete",
  "globals.messages.confirmDeleteNamed",
  "globals.messages.copied",
  "globals.messages.copyOf",
  "globals.messages.created",
  "globals.messages.deleted",
  "globals.messages.deletedCount",
  "globals.messages.done",
  "globals.messages.numSelected",
  "globals.messages.selectAll",
  "globals.messages.statusChanged",
  "globals.messages.updated",
  "globals.terms.campaign",
  "globals.terms.code",
  "globals.terms.none",
  "globals.terms.scheduled",
  "campaigns.testSent",
  "subscribers.invalidJSON",
  ...statuses.map((status) => `globals.terms.${status}`),
];
/** What the status and row controls need beyond the permissions the page checked. */
export function campaignConfig({ can, listScope }: AdminRequest) {
  const manage = listScope("list:manage");
  return {
    can_send: can("campaigns:send"),
    manage_campaigns: can("campaigns:manage_all") || manage.all ? "all" : manage.ids.join(","),
  };
}

const dateFields = [
  ["created_at", "globals.fields.createdAt"],
  ["started_at", "globals.fields.startedAt"],
  ["updated_at", "globals.fields.endedAt"],
  ["send_at", "globals.terms.scheduled"],
] as const;

function StatusControls({ t }: { t: Translation }) {
  const item = (when: string, label: string, status: string, icon: string, danger = false) => (
    <template x-if={`canChange(c) && ${when}`}>
      <button
        type="button"
        role="menuitem"
        class="ghost"
        {...(danger ? { "data-variant": "danger" } : {})}
        x-bind:disabled="changing"
        {...{ "x-on:click.prevent": `onChangeStatus(c, '${status}')` }}
      >
        <Icon name={icon} /> {label}
      </button>
    </template>
  );
  return (
    <>
      {item("c.status === 'draft' && !c.send_at", t.T("campaigns.start"), "running", "send")}
      {item("c.status === 'draft' && c.send_at", t.T("campaigns.schedule"), "scheduled", "clock")}
      {item("c.status === 'running'", t.T("globals.buttons.pause"), "paused", "pause")}
      {item("c.status === 'paused'", t.T("globals.buttons.send"), "running", "send")}
      {item(
        "c.status === 'running' || c.status === 'paused'",
        t.T("globals.buttons.cancel"),
        "cancelled",
        "x-circle",
        true,
      )}
    </>
  );
}
function Menu(props: {
  t: Translation;
  canSend: boolean;
  canManage: boolean;
  canAnalytics: boolean;
}) {
  const { t, canSend, canManage, canAnalytics } = props;
  return (
    <ot-dropdown>
      <button
        popovertarget=""
        x-bind:popovertarget="'camp-actions-' + c.id"
        type="button"
        class="ghost more icon"
        aria-label={t.T("globals.buttons.more")}
      >
        <Icon name="more-vertical" />
      </button>
      <menu popover="" x-bind:id="'camp-actions-' + c.id">
        <button
          type="button"
          role="menuitem"
          class="ghost"
          {...{ "x-on:click.prevent": "onPreview(c.id, c.name)" }}
        >
          <Icon name="eye" /> {t.T("globals.buttons.preview")}
        </button>
        {canSend ? <StatusControls t={t} /> : null}
        <hr />
        <a x-bind:href="'/admin/campaigns/' + c.id" role="menuitem" class="button ghost">
          <Icon name="edit-2" /> {t.T("globals.buttons.edit")}
        </a>
        {canManage ? (
          <button
            type="button"
            role="menuitem"
            class="ghost"
            {...{ "x-on:click.prevent": "onClone(c.id, c.name)" }}
          >
            <Icon name="copy" /> {t.T("globals.buttons.clone")}
          </button>
        ) : null}
        {canAnalytics ? (
          <a x-bind:href="analyticsLink(c)" role="menuitem" class="button ghost">
            <Icon name="bar-chart-2" /> {t.T("globals.terms.analytics")}
          </a>
        ) : null}
        {canManage ? (
          <>
            <hr />
            <button
              type="button"
              role="menuitem"
              class="ghost"
              data-variant="danger"
              x-bind:disabled="isLoading('campaigns')"
              {...{ "x-on:click.prevent": "onDelete(c.id, c.name)" }}
            >
              <Icon name="trash-2" /> {t.T("globals.buttons.delete")}
            </button>
          </>
        ) : null}
      </menu>
    </ot-dropdown>
  );
}
function NameCell({ t }: { t: Translation }) {
  return (
    <td class="name">
      <div class="avatar" x-bind:class="{ disabled: c.status === 'cancelled' }">
        <AvatarLink
          kind="campaign"
          name="c.name"
          href="'/admin/campaigns/' + c.id"
          title="viewTitle(c.name)"
        />
        <div class="avatar-label vstack gap-1">
          <div>
            <a x-bind:href="'/admin/campaigns/' + c.id" class="unstyled" x-text="c.name"></a>{" "}
            <template x-if="c.type === 'optin'">
              <a
                x-bind:href="filterLink('type', 'optin')"
                title={`${t.T("globals.buttons.filter")} ${t.T("lists.optin")}`}
              >
                <span class="badge small outline">
                  <Icon name="user-check" /> {t.T("lists.optin")}
                </span>
              </a>
            </template>
            <div class="subject text-8 text-light">
              <a x-bind:href="'/admin/campaigns/' + c.id" class="unstyled" x-text="c.subject"></a>
            </div>
          </div>
          <template x-if="c.tags.length">
            <div class="hstack gap-2 text-8">
              <template x-for="tag in c.tags" x-bind:key="tag">
                <a
                  x-bind:href="filterLink('tag', tag)"
                  x-bind:title="filterTitle(tag)"
                  class="tag"
                  x-text="'#' + tag"
                ></a>
              </template>
            </div>
          </template>
          <template x-if="c.lists.length">
            <div class="hstack lists">
              <template x-for="l in c.lists.slice(0, 3)" x-bind:key="l.id">
                <div class="avatar xsmall">
                  <AvatarLink
                    kind="list"
                    name="l.name"
                    href="'/admin/lists/' + l.id"
                    title="viewTitle(l.name)"
                  />
                  <a
                    class="unstyled text-light avatar-label"
                    x-bind:href="'/admin/subscribers/lists/' + l.id"
                    x-bind:title="filterTitle(l.name)"
                    x-text="l.name"
                  ></a>
                </div>
              </template>
              <template x-if="c.lists.length > 3">
                <ot-dropdown>
                  <button
                    type="button"
                    class="ghost small text-8"
                    popovertarget=""
                    x-bind:popovertarget="'camp-lists-' + c.id"
                    aria-label={t.T("globals.terms.lists")}
                    x-text={`'+' + (c.lists.length - 3) + ' ${t.T("globals.terms.lists").toLowerCase()}'`}
                  ></button>
                  <menu popover="" x-bind:id="'camp-lists-' + c.id">
                    <template x-for="l in c.lists.slice(3)" x-bind:key="l.id">
                      <a
                        role="menuitem"
                        class="button ghost"
                        x-bind:href="'/admin/subscribers/lists/' + l.id"
                        x-bind:title="filterTitle(l.name)"
                      >
                        <span class="avatar-label text-light" x-text="l.name"></span>
                      </a>
                    </template>
                  </menu>
                </ot-dropdown>
              </template>
            </div>
          </template>
        </div>
      </div>
    </td>
  );
}
function StatsCells({ t }: { t: Translation }) {
  const lower = (key: string) => t.T(key).toLowerCase();
  return (
    <>
      <td class="stats" data-label={t.T("globals.terms.stats")}>
        <div class="vstack gap-1">
          <div>
            <div x-show="c.sent !== 0 || c.status === 'running'">
              <span data-stat="sent" x-text="formatNumber(c.sent)"></span>
              <span x-show="c.status !== 'finished' && c.to_send">
                {" / "}
                <span data-stat="to_send" x-text="formatNumber(c.to_send)"></span>
              </span>
            </div>
            <span class="text-8 text-light">
              <span data-stat="percent" x-text="'' + percent(c) + '%'"></span>{" "}
              {lower("globals.terms.sent")}
              <span x-text="runTime(c) ? (' · ' + runTime(c)) : ''"></span>
            </span>
          </div>
          <div>
            <a class="unstyled" x-bind:href="'/admin/subscribers/bounces?campaign_id=' + c.id">
              <span x-text="formatNumber(c.bounces)"></span>{" "}
              <span class="text-8 text-light">{lower("globals.terms.bounces")}</span>
            </a>
          </div>
          <template x-if="c.status === 'running'">
            <div class="hstack gap-1 text-8 campaign-progress">
              <progress
                data-stat="progress"
                x-bind:value="c.sent"
                x-bind:max="c.to_send > 1 ? c.to_send : 1"
                aria-label={t.T("globals.terms.progress")}
              ></progress>
              <span>
                <span data-stat="rate" x-text="c.rate || 0"></span>{" "}
                <span class="text-light">/ {t.T("globals.terms.minuteShort")}</span>
              </span>
            </div>
          </template>
        </div>
      </td>
      <td class="stats analytics" data-label={t.T("globals.terms.analytics")}>
        <div class="vstack gap-1">
          <div>
            <span x-text="formatNumber(c.views)"></span>{" "}
            <span class="text-8 text-light">{lower("globals.terms.views")}</span>
          </div>
          <div>
            <span x-text="formatNumber(c.clicks)"></span>{" "}
            <span class="text-8 text-light">{lower("globals.terms.clicks")}</span>
          </div>
        </div>
      </td>
    </>
  );
}
function Row(props: {
  t: Translation;
  dateLabel: string;
  canSend: boolean;
  canManage: boolean;
  canAnalytics: boolean;
}) {
  const { t, dateLabel } = props;
  return (
    <tr x-bind:data-campaign-id="c.id" x-bind:class="'status-' + c.status">
      <td>
        <input name="id" type="checkbox" x-bind:value="c.id" />
      </td>
      <NameCell t={t} />
      <td class="type">
        <div class="vstack gap-1">
          <a
            x-bind:href="filterLink('status', c.status)"
            x-bind:title="filterTitle(statusLabel(c.status))"
          >
            <span class="badge enum" x-bind:class="'status-' + c.status">
              <span class="dot">●</span> <span x-text="statusLabel(c.status)"></span>
            </span>
            <template x-if="c.status === 'running'">
              <span class="spinner" data-spinner="small" aria-busy="true"></span>
            </template>
          </a>
          <template x-if="c.status === 'scheduled' && c.send_at">
            <span class="text-8 text-light" x-bind:title="exactDate(c.send_at)">
              <Icon name="clock" /> <span x-text="compactDate(c.send_at, true, true)"></span>
            </span>
          </template>
        </div>
      </td>
      <StatsCells t={t} />
      <td class="timestamp" data-label={dateLabel}>
        <template x-if="timestamp(c).text === null">
          <span x-text="'—'"></span>
        </template>
        <template x-if="timestamp(c).text !== null">
          <span
            tabindex="0"
            x-bind:title="timestamp(c).title"
            x-on:click="$el.focus()"
            data-tooltip-placement="bottom"
            x-text="timestamp(c).text"
          ></span>
        </template>
      </td>
      <td class="actions align-right">
        <Menu
          t={t}
          canSend={props.canSend}
          canManage={props.canManage}
          canAnalytics={props.canAnalytics}
        />
      </td>
    </tr>
  );
}
function Filters({ t, params, base }: { t: Translation; params: URLSearchParams; base: string }) {
  const status = params.get("status") ?? "";
  const type = params.get("type") ?? "";
  const tag = params.get("tag") ?? "";
  const pageNumber = Number(params.get("page") ?? 1);
  return (
    <>
      {status ? (
        <StatusBadge t={t} status={status} url={filterURL(base, params, "status")} />
      ) : null}
      {type ? (
        <FilterBadge
          t={t}
          class="enum"
          label={
            <>
              <Icon name="user-check" /> {t.T("lists.optin")}
            </>
          }
          url={filterURL(base, params, "type")}
        />
      ) : null}
      {tag ? (
        <FilterBadge t={t} class="tag" label={`#${tag}`} url={filterURL(base, params, "tag")} />
      ) : null}
      {pageNumber > 1 ? (
        <FilterBadge
          t={t}
          label={t.Ts("globals.terms.page", "n", String(pageNumber))}
          url={filterURL(base, params)}
        />
      ) : null}
    </>
  );
}
function TimestampHeading(props: {
  t: Translation;
  base: string;
  params: URLSearchParams;
  field: string;
  label: string;
}) {
  const { t, base, params, field, label } = props;
  const orderBy = params.get("order_by"),
    order = params.get("order");
  const sortURL = (name: string) => {
    const next = new URLSearchParams(params);
    for (const key of ["order_by", "order", "page"]) next.delete(key);
    next.set("order_by", name);
    next.set("order", orderBy === name && order === "asc" ? "desc" : "asc");
    return `${base}?${next}`;
  };
  return (
    <div class="timestamp-sort">
      <SortLink base={base} params={params} field={field || "created_at"} label={label} />
      <ot-dropdown>
        <button
          type="button"
          class="ghost small icon"
          popovertarget="camp-timestamp-sort"
          aria-label={t.T("globals.terms.timestamps")}
          aria-haspopup="menu"
        >
          <Icon name="chevron-down" />
        </button>
        <menu popover="" id="camp-timestamp-sort">
          <a
            role="menuitem"
            class="button ghost"
            href={filterURL(base, params, "order_by", "order")}
          >
            {t.T("globals.terms.all")}
          </a>
          {dateFields.map(([name, key]) => (
            <a
              role="menuitem"
              class="button ghost"
              href={sortURL(name)}
              data-sort-field={name}
              {...(orderBy === name && order ? { "data-sorted": order } : {})}
            >
              {t.T(key)}
            </a>
          ))}
        </menu>
      </ot-dropdown>
    </div>
  );
}

export const campaignsView: AdminView = (request) => {
  const { context, can, site } = request;
  const t = context.app.i18n;
  const base = "/admin/campaigns";
  const params = context.url.searchParams;
  const canManage = can("campaigns:manage", "campaigns:manage_all");
  const canSend = can("campaigns:send");
  const date = dateFields.find(([name]) => name === params.get("order_by"));
  const dateLabel = date ? t.T(date[1]) : t.T("globals.terms.timestamps");
  const remove = {
    "x-on:click.prevent": "onDeleteSelected(numSelected, selectedQueryParams().toString())",
  };
  return {
    title: t.T("globals.terms.campaigns"),
    pageId: "campaigns.all",
    script: "campaigns",
    translationKeys: campaignKeys,
    config: campaignConfig(request),
    body: (
      <section class="campaigns" x-data="campaignsView">
        <header class="row page-header">
          <div class="col-4">
            <h1 class="page-title">
              {t.T("globals.terms.campaigns")} <span x-text="'(' + (page.total != null ? page.total : '-') + ')'"></span>{" "}
              <Filters t={t} params={params} base={base} />
            </h1>
          </div>
          <div class="col-8 hstack justify-end buttons">
            <form method="get" action={base} class="search-form">
              <HiddenFields params={params} exclude={["query", "page"]} />
              <fieldset class="group">
                <input
                  name="query"
                  aria-label="Search"
                  placeholder={t.T("campaigns.queryPlaceholder")}
                  value={params.get("query") ?? ""}
                  autofocus
                />
                <button type="submit" class="outline external" aria-label="Search">
                  <Icon name="search" />
                </button>
              </fieldset>
            </form>
            {canManage ? (
              <a href={`${base}/new`} class="button" data-variant="primary">
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
            {canManage ? (
              <template x-if="numSelected > 0">
                <ot-dropdown class="bulk-actions" data-variant="primary">
                  <button popovertarget="camp-bulk-actions" type="button" class="small">
                    <span x-text="numSelectedLabel"></span> <Icon name="more-vertical" />
                  </button>
                  <menu popover="" id="camp-bulk-actions">
                    <template x-if="page.total > page.per_page">
                      <button
                        type="button"
                        role="menuitem"
                        class="ghost"
                        x-show="!allSelected"
                        {...{ "x-on:click.prevent": "onSelectAllQuery()" }}
                      >
                        <Icon name="check-square" /> <span x-text="selectAllLabel"></span>
                      </button>
                    </template>
                    <button
                      type="button"
                      role="menuitem"
                      class="ghost"
                      data-variant="danger"
                      x-bind:disabled="isLoading('campaigns')"
                      {...remove}
                    >
                      <Icon name="trash-2" /> {t.T("globals.buttons.delete")}{" "}
                      <span x-text="numSelected"></span>
                    </button>
                  </menu>
                </ot-dropdown>
              </template>
            ) : null}
            <table class="has-select">
              <thead>
                <tr>
                  <th width="5%">
                    <input type="checkbox" aria-label={t.T("globals.buttons.toggleSelect")} />
                  </th>
                  <th width="38%" class="cy-name">
                    <SortLink
                      base={base}
                      params={params}
                      field="name"
                      label={t.T("globals.fields.name")}
                    />
                  </th>
                  <th width="12%" class="cy-type">
                    {t.T("globals.fields.status")}
                  </th>
                  <th width="12%">{t.T("globals.terms.stats")}</th>
                  <th width="10%">{t.T("globals.terms.analytics")}</th>
                  <th width="18%" class="cy-timestamp">
                    <TimestampHeading
                      t={t}
                      base={base}
                      params={params}
                      field={date ? date[0] : ""}
                      label={dateLabel}
                    />
                  </th>
                  <th width="5%" class="align-right"></th>
                </tr>
              </thead>
              <tbody>
                <template x-for="c in campaigns" x-bind:key="c.id">
                  <Row
                    t={t}
                    dateLabel={dateLabel}
                    canSend={canSend}
                    canManage={canManage}
                    canAnalytics={can("campaigns:get_analytics")}
                  />
                </template>
                <EmptyRow when="!loading && !error && !campaigns.length" colspan={7} t={t} />
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

        <PreviewDialog t={t} />
      </section>
    ),
  };
};
