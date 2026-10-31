// Adapted from listmonk static/admin/views/bounces.html, partials/bounces-table.html and
// cmd/bounce.go (ViewBounces) at 6fcd95f. Upstream renders the rows into the page; here bounces.js
// reads them from /api/bounces, so a source, address or `meta` only reaches the page as text.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import {
  Alert,
  AvatarLink,
  Breadcrumbs,
  EmptyRow,
  FilterBadge,
  filterURL,
  SortLink,
} from "@/admin/views/parts";
import { bounceTypes } from "@/bounces/store";
import type { Translation } from "@/i18n/i18n";

const bounceKeys = [
  "bounces.complaint",
  "bounces.hard",
  "bounces.soft",
  "globals.buttons.filter",
  "globals.buttons.view",
  "globals.messages.confirmDelete",
  "globals.messages.deleted",
  "globals.messages.deletedCount",
  "globals.messages.done",
  "globals.messages.numSelected",
  "globals.messages.selectAll",
  "globals.terms.all",
  "globals.terms.blocklisted",
  "globals.terms.bounce",
  "globals.terms.disabled",
  "subscribers.confirmBlocklist",
];

function Row({ t, canManage }: { t: Translation; canManage: boolean }) {
  return (
    <tr data-testid="bounce-row" x-bind:data-id="b.id">
      <td>
        <input
          name="id"
          type="checkbox"
          x-bind:value="b.id"
          x-bind:data-subscriber-id="b.subscriber_id"
        />
      </td>
      <td>
        <template x-if="b.subscriber_id">
          <div class="avatar" x-bind:class="{ disabled: b.subscriber_status === 'blocklisted' }">
            <AvatarLink
              kind="subscriber"
              name="b.email || ''"
              href="`/admin/subscribers/${b.subscriber_id}`"
              title="viewTitle(b.email || '')"
            />
            <div class="avatar-label">
              <a
                x-bind:href="`/admin/subscribers/${b.subscriber_id}`"
                class="unstyled"
                x-bind:class="{ blocklisted: b.subscriber_status === 'blocklisted' }"
                x-text="b.email"
              ></a>{" "}
              <template x-if="b.subscriber_status !== 'enabled'">
                <span class="badge" x-bind:class="`status-${b.subscriber_status}`">
                  <span class="dot">●</span> <span x-text="statusLabel(b.subscriber_status)"></span>
                </span>
              </template>
            </div>
          </div>
        </template>
        <template x-if="!b.subscriber_id">
          <span x-text="b.email || '-'"></span>
        </template>
      </td>
      <td data-label={t.T("globals.terms.campaign")}>
        <template x-if="b.campaign">
          <div class="avatar">
            <AvatarLink
              kind="campaign"
              name="b.campaign.name"
              href="`/admin/campaigns/${b.campaign.id}`"
              title="viewTitle(b.campaign.name)"
            />
            <a
              x-bind:href="filterLink('campaign_id', b.campaign.id)"
              class="avatar-label unstyled"
              x-bind:title="filterTitle(b.campaign.name)"
              x-text="b.campaign.name"
            ></a>
          </div>
        </template>
        <template x-if="!b.campaign">
          <span>-</span>
        </template>
      </td>
      <td data-label={t.T("globals.fields.source")}>
        <a
          x-bind:href="filterLink('source', b.source)"
          class="unstyled text-light"
          x-bind:title="filterTitle(b.source)"
          x-text="b.source"
        ></a>
      </td>
      <td data-label={t.T("globals.fields.type")}>
        <a
          x-bind:href="filterLink('type', b.type)"
          class="unstyled"
          x-bind:title="filterTitle(typeLabel(b.type))"
        >
          <span
            class="badge enum"
            x-bind:class="`bounce-${b.type}`"
            x-text="typeLabel(b.type)"
          ></span>
        </a>
      </td>
      <td
        class="date-stack"
        data-label={t.T("globals.fields.createdAt")}
        x-text="niceDate(b.created_at)"
      ></td>
      <td class="actions align-right">
        <ot-dropdown>
          <button
            popovertarget=""
            x-bind:popovertarget="`bounce-actions-${b.id}`"
            type="button"
            class="ghost more icon"
            aria-label={t.T("globals.buttons.more")}
          >
            <Icon name="more-vertical" />
          </button>
          <menu popover="" x-bind:id="`bounce-actions-${b.id}`">
            <button
              type="button"
              role="menuitem"
              class="ghost"
              data-testid="btn-meta"
              {...{ "x-on:click.prevent": "onView(b.email || '', b.meta)" }}
            >
              <Icon name="file-text" /> {t.T("globals.buttons.view")}
            </button>
            {canManage ? (
              <button
                type="button"
                role="menuitem"
                class="ghost"
                data-variant="danger"
                data-testid="btn-delete"
                x-bind:disabled="isLoading('bounces')"
                {...{ "x-on:click.prevent": "onDeleteBounce(b.id, b.email || '')" }}
              >
                <Icon name="trash-2" /> {t.T("globals.buttons.delete")}
              </button>
            ) : null}
          </menu>
        </ot-dropdown>
      </td>
    </tr>
  );
}
function BulkActions({ t, canManage }: { t: Translation; canManage: boolean }) {
  const blocklist = {
    "x-on:click.prevent":
      "onBlocklistSelected(allSelected, total, selectedQueryParams().toString())",
  };
  const remove = {
    "x-on:click.prevent": "onDeleteSelected(numSelected, selectedQueryParams().toString())",
  };
  return (
    <template x-if="numSelected > 0">
      <ot-dropdown class="bulk-actions" data-variant="primary">
        <button
          popovertarget="bounce-bulk-actions"
          type="button"
          class="small"
          data-testid="btn-bulk-actions"
        >
          <span x-text="numSelectedLabel"></span> <Icon name="more-vertical" />
        </button>
        <menu popover="" id="bounce-bulk-actions">
          <template x-if="page.total > page.per_page">
            <button
              type="button"
              role="menuitem"
              class="ghost"
              data-testid="select-all-bounces"
              x-show="!allSelected"
              {...{ "x-on:click.prevent": "onSelectAllQuery()" }}
            >
              <Icon name="list" /> <span x-text="selectAllLabel"></span>
            </button>
          </template>
          {canManage ? (
            <>
              <button
                type="button"
                role="menuitem"
                class="ghost"
                data-testid="btn-manage-blocklist"
                {...blocklist}
              >
                <Icon name="user-x" /> {t.T("globals.terms.blocklist")}
              </button>
              <hr />
              <button
                type="button"
                role="menuitem"
                class="ghost"
                data-variant="danger"
                data-testid="btn-delete-bounces"
                x-bind:disabled="isLoading('bounces')"
                {...remove}
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

export const bouncesView: AdminView = ({ context, can }) => {
  const t = context.app.i18n;
  const base = "/admin/subscribers/bounces";
  const params = context.url.searchParams;
  const source = params.get("source") ?? "";
  const type = params.get("type") ?? "";
  const campaign = params.get("campaign_id") ?? "";
  const pageNumber = Number(params.get("page") ?? 1);
  const canManage = can("bounces:manage");
  const sort = (field: string, label: string) => (
    <SortLink base={base} params={params} field={field} label={label} />
  );
  return {
    title: t.T("globals.terms.bounces"),
    pageId: "subscribers.bounces",
    script: "bounces",
    translationKeys: bounceKeys,
    body: (
      <>
        <Breadcrumbs
          parent={t.T("globals.terms.subscribers")}
          href={can("subscribers:get", "subscribers:get_all") ? "/admin/subscribers" : null}
          current={t.T("globals.terms.bounces")}
        />
        <section class="bounces" x-data="bouncesView">
          <header class="page-header">
            <div class="hstack">
              <h1 class="page-title">
                {t.T("globals.terms.bounces")} <span x-text="`(${page.total ?? '-'})`"></span>
              </h1>
              <div class="hstack gap-1">
                {source ? (
                  <FilterBadge t={t} label={source} url={filterURL(base, params, "source")} />
                ) : null}
                {type ? (
                  <FilterBadge
                    t={t}
                    class="enum"
                    label={
                      (bounceTypes as readonly string[]).includes(type)
                        ? t.T(`bounces.${type}`)
                        : type
                    }
                    url={filterURL(base, params, "type")}
                  />
                ) : null}
                {campaign ? (
                  <FilterBadge
                    t={t}
                    label={`#${campaign}`}
                    url={filterURL(base, params, "campaign_id")}
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
            </div>
          </header>

          <Alert name="error" />
          <div class="card page-content has-table">
            <div
              class="table-wrapper"
              x-data="table({ query: '', filters: selection })"
              x-effect="total = page.total ?? 0"
              x-bind:aria-busy="loading || isLoading('bounces')"
              x-on:change="onChange($event)"
            >
              <BulkActions t={t} canManage={canManage} />
              <table class="has-select">
                <thead>
                  <tr>
                    <th width="5%">
                      <input type="checkbox" aria-label={t.T("globals.buttons.toggleSelect")} />
                    </th>
                    <th>{sort("email", t.T("globals.fields.email"))}</th>
                    <th>{t.T("globals.terms.campaign")}</th>
                    <th>{sort("source", t.T("globals.fields.source"))}</th>
                    <th>{sort("type", t.T("globals.fields.type"))}</th>
                    <th>{sort("created_at", t.T("globals.fields.createdAt"))}</th>
                    <th class="align-right"></th>
                  </tr>
                </thead>
                <tbody>
                  <template x-for="b in bounces" x-bind:key="b.id">
                    <Row t={t} canManage={canManage} />
                  </template>
                  <EmptyRow when="!loading && !error && !bounces.length" colspan={7} t={t} />
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

          <dialog x-ref="metaDialog">
            <div class="dialog-card content">
              <header class="dialog-head">
                <h4 class="dialog-title" x-text="metaTitle"></h4>
              </header>
              <section class="dialog-body">
                <pre x-text="JSON.stringify(meta, null, 2)"></pre>
              </section>
              <footer class="dialog-foot hstack justify-end">
                <button type="button" class="outline" x-on:click="$refs.metaDialog.close()">
                  {t.T("globals.buttons.close")}
                </button>
              </footer>
            </div>
          </dialog>
        </section>
      </>
    ),
  };
};
