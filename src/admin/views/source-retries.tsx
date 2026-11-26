// Native (15-external-sources section 4, B155f, D181): the source stream's retry queue, read-only.
// source-retries.js reads the rows from /api/settings/source/retries, so a record ID or error text
// only reaches the page through x-text.
import type { AdminView } from "@/admin/page";
import { Alert, Breadcrumbs, EmptyRow } from "@/admin/views/parts";

const keys = [
  "sources.retries.kind.event",
  "sources.retries.kind.user",
  "sources.retries.status.queued",
  "sources.retries.status.waiting",
  "sources.retries.status.terminal",
];

export const sourceRetriesView: AdminView = ({ context }) => {
  const t = context.app.i18n;
  return {
    title: t.T("sources.retries.title"),
    pageId: "settings.source-retries",
    script: "source-retries",
    translationKeys: keys,
    body: (
      <>
        <Breadcrumbs
          parent={t.T("globals.terms.settings")}
          href="/admin/settings"
          current={t.T("sources.retries.title")}
        />
        <section class="source-retries relative" x-data="sourceRetriesView">
          <header class="page-header">
            <h1 class="page-title">{t.T("sources.retries.title")}</h1>
          </header>
          <p class="text-light" data-testid="retries-help">
            {t.T("sources.retries.help")}
          </p>
          <Alert name="error" />
          <p
            role="status"
            data-testid="retries-no-source"
            x-show="ready && !stream"
            style="display: none"
          >
            {t.T("sources.retries.noSource")}
          </p>
          <p class="text-light" data-testid="retries-more" x-show="more" style="display: none">
            {t.T("sources.retries.more")}
          </p>
          <div class="card page-content has-table">
            <div class="table-wrapper">
              <table data-testid="retries-table">
                <thead>
                  <tr>
                    <th>{t.T("sources.retries.record")}</th>
                    <th>{t.T("sources.retries.status")}</th>
                    <th>{t.T("sources.retries.attempts")}</th>
                    <th>{t.T("sources.retries.firstFailed")}</th>
                    <th>{t.T("sources.retries.next")}</th>
                    <th>{t.T("sources.retries.error")}</th>
                  </tr>
                </thead>
                <tbody>
                  <template x-for="r in rows" x-bind:key="r.id">
                    <tr data-testid="retry-row" x-bind:data-id="r.id" x-bind:data-status="r.status">
                      <td data-label={t.T("sources.retries.record")}>
                        <code x-text="r.record_id"></code>
                        <br />
                        <small class="text-light" x-text="kindLabel(r.kind)"></small>
                      </td>
                      <td data-label={t.T("sources.retries.status")}>
                        <span
                          class="badge enum"
                          data-testid="retry-status"
                          x-bind:class="'retry-' + r.status"
                          x-text="statusLabel(r.status)"
                        ></span>
                      </td>
                      <td data-label={t.T("sources.retries.attempts")} x-text="r.attempts"></td>
                      <td
                        class="date-stack"
                        data-label={t.T("sources.retries.firstFailed")}
                        x-text="niceDate(r.first_failed_at, true)"
                      ></td>
                      <td
                        class="date-stack"
                        data-label={t.T("sources.retries.next")}
                        x-text="r.next_attempt_at ? niceDate(r.next_attempt_at, true) : '-'"
                      ></td>
                      <td data-label={t.T("sources.retries.error")}>
                        <small data-testid="retry-error" x-text="r.last_error"></small>
                      </td>
                    </tr>
                  </template>
                  <EmptyRow when="ready && stream && !rows.length" colspan={6} t={t} />
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </>
    ),
  };
};
