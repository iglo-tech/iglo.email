// Adapted from listmonk static/admin/views/logs.html and cmd/settings.go (ViewLogs) at 6fcd95f.
// Upstream's page arrives with its lines; here logs.js reads them from /api/logs, so a line reaches
// the page only through x-text.
import type { AdminView } from "@/admin/page";
import { Alert, Breadcrumbs, EmptyState } from "@/admin/views/parts";

export const logsView: AdminView = ({ context }) => {
  const t = context.app.i18n;
  return {
    title: t.T("globals.terms.logs"),
    pageId: "settings.logs",
    script: "logs",
    body: (
      <>
        <Breadcrumbs
          parent={t.T("globals.terms.settings")}
          href="/admin/settings"
          current={t.T("globals.terms.logs")}
        />
        <section class="logs relative" x-data="logsView">
          <header class="page-header">
            <h1 class="page-title">{t.T("globals.terms.logs")}</h1>
          </header>
          <div class="card page-content">
            <Alert name="error" />
            <div data-testid="no-logs" x-show="ready && !lines.length" style="display: none">
              <EmptyState text={t.T("globals.messages.emptyState")} />
            </div>
            <div class="log-view" x-show="lines.length" style="display: none">
              <div class="lines" x-ref="lines">
                <template x-for="(l, i) in lines" x-bind:key="i">
                  <span class="line">
                    <span class="timestamp" x-text="l.timestamp"></span>
                    <span
                      class="log-message"
                      x-bind:class="{ error: l.message.includes('error') }"
                      x-text="l.message"
                    ></span>
                  </span>
                </template>
              </div>
            </div>
          </div>
        </section>
      </>
    ),
  };
};
