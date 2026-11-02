// Native screen with no upstream source (docs/design/05-sequences.md#admin-ui). Rows come from
// /api/sequences and their counts from /api/sequences/counts, read apart in the analytics reader,
// so a slow or refused count never holds the list. Stored text reaches the page by x-text.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import { Alert, AvatarLink, EmptyRow, FilterBadge, filterURL } from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";

/** Status words sequences.js and enrollments.js read. */
export const sequenceStatusKeys = [
  "sequences.status.active",
  "sequences.status.archived",
  "sequences.status.canceled",
  "sequences.status.completed",
  "sequences.status.draft",
  "sequences.status.exited",
  "sequences.status.paused",
];

function Row({ t }: { t: Translation }) {
  const count = (status: string) => (
    <div>
      <span class="text-light">{t.T(`sequences.status.${status}`)}</span>{" "}
      <span x-text={`enrollmentCount(s.id, '${status}')`}></span>
    </div>
  );
  return (
    <tr data-testid="sequence-row" x-bind:data-id="s.id">
      <td>
        <div class="avatar" x-bind:class="{ disabled: s.status === 'archived' }">
          <AvatarLink
            kind="list"
            name="s.name"
            href="'/admin/sequences/' + s.id"
            title="viewTitle(s.name)"
          />
          <div class="avatar-label">
            <a x-bind:href="'/admin/sequences/' + s.id" class="unstyled" x-text="s.name"></a>
            <div class="text-light text-8" x-text="s.trigger.event"></div>
          </div>
        </div>
      </td>
      <td data-label={t.T("globals.fields.status")}>
        <span class="badge" x-bind:class="'status-' + s.status">
          <span class="dot">●</span> <span x-text="statusLabel(s.status)"></span>
        </span>
      </td>
      <td data-label={t.T("sequences.enrollments")} data-testid="enrollment-counts">
        {count("active")}
        {count("completed")}
        {count("exited")}
      </td>
      <td data-label={t.T("sequences.steps")} data-testid="step-counts">
        <table class="step-counts">
          <thead>
            <tr>
              <th></th>
              <th>{t.T("sequences.sent")}</th>
              <th>{t.T("sequences.skipped")}</th>
              <th>{t.T("sequences.opened")}</th>
              <th>{t.T("sequences.clicked")}</th>
            </tr>
          </thead>
          <tbody>
            <template x-for="step in stepCounts(s.id)" x-bind:key="step.step_id">
              <tr>
                <td x-text="step.position + 1"></td>
                <td x-text="formatNumber(step.sent)"></td>
                <td x-text="formatNumber(step.skipped)"></td>
                <td x-text="formatNumber(step.opened)"></td>
                <td x-text="formatNumber(step.clicked)"></td>
              </tr>
            </template>
          </tbody>
        </table>
      </td>
      <td data-label={t.T("globals.fields.updatedAt")} x-text="niceDate(s.updated_at)"></td>
    </tr>
  );
}

export const sequencesView: AdminView = ({ context, can }) => {
  const t = context.app.i18n;
  const params = context.url.searchParams;
  const base = "/admin/sequences";
  const status = params.get("status") ?? "";
  const title = t.T("globals.terms.sequences");
  return {
    title,
    pageId: "sequences.all",
    script: "sequences",
    translationKeys: ["globals.buttons.view", ...sequenceStatusKeys],
    body: (
      <section class="sequences" x-data="sequencesView">
        <header class="hstack justify-between page-header">
          <div class="hstack page-heading">
            <h1 class="page-title">
              {title} <span x-text="'(' + (page.total != null ? page.total : '-') + ')'"></span>
            </h1>
            {/^[a-z]+$/.test(status) ? (
              <FilterBadge
                t={t}
                class={`status-${status}`}
                label={t.T(`sequences.status.${status}`)}
                url={filterURL(base, params, "status")}
              />
            ) : null}
          </div>
          <div class="hstack justify-end buttons">
            {can("sequences:manage") ? (
              <a
                href="/admin/sequences/new"
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
          <div class="table-wrapper" x-bind:aria-busy="loading">
            <table>
              <thead>
                <tr>
                  <th width="28%">{t.T("globals.fields.name")}</th>
                  <th width="10%">{t.T("globals.fields.status")}</th>
                  <th width="17%">{t.T("sequences.enrollments")}</th>
                  <th width="30%">{t.T("sequences.steps")}</th>
                  <th width="15%">{t.T("globals.fields.updatedAt")}</th>
                </tr>
              </thead>
              <tbody>
                <template x-for="s in sequences" x-bind:key="s.id">
                  <Row t={t} />
                </template>
                <EmptyRow when="!loading && !error && !sequences.length" colspan={5} t={t} />
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
            <div
              role="alert"
              data-variant="warning"
              data-testid="counts-error"
              x-show="countsError"
              x-text="countsError"
              style="display: none"
            ></div>
            <p class="text-light">{t.T("sequences.countsLeaveOutTests")}</p>
          </div>
        </div>
      </section>
    ),
  };
};
