// Adapted from listmonk static/admin/views/dashboard.html and cmd/dashboard.go at 6fcd95f.
// Upstream renders the database reads into the page. Here they run in the analytics reader, which
// can queue and refuse, so the page arrives at once and dashboard.js fills it from
// /api/dashboard/*: each section waits and fails alone, and its text goes in through x-text.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import { systemStats, type SystemStats } from "@/admin/system";
import type { Translation } from "@/i18n/i18n";

const statuses = ["draft", "scheduled", "running", "paused", "finished", "cancelled"];
const dayFormat = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

function Alert({ name }: { name: string }) {
  return (
    <div
      role="alert"
      data-variant="danger"
      data-testid={name}
      x-show={name}
      x-text={name}
      style="display: none"
    ></div>
  );
}
function StatMeta(props: { href: string; value: string; label: string }) {
  return (
    <div class="hstack gap-1">
      <dt>
        <a href={props.href} class="unstyled">
          <strong x-text={props.value}></strong>
        </a>
      </dt>
      <dd class="text-light">{props.label}</dd>
    </div>
  );
}
function Stat(props: {
  icon: string;
  label: string;
  name: string;
  href?: string;
  value: string;
  children?: unknown;
}) {
  const value = <span data-testid={`stat-${props.name}`} x-text={props.value}></span>;
  return (
    <div class="col-3">
      <article class="card stat-card">
        <small class="text-light">
          <Icon name={props.icon} /> {props.label}
        </small>
        <div class="stat-value">
          {props.href ? (
            <a href={props.href} class="unstyled">
              {value}
            </a>
          ) : (
            value
          )}
        </div>
        {props.children ? (
          <dl class="stat-meta hstack justify-between">{props.children as never}</dl>
        ) : null}
      </article>
    </div>
  );
}
function Chart(props: { id: string; title: string; empty: string }) {
  return (
    <div class="col-6">
      <article class="card float">
        <h5 class="title">
          <a href="/admin/campaigns/analytics" class="unstyled">
            {props.title}
          </a>
        </h5>
        <div class="chart-box">
          <canvas id={props.id}></canvas>
          <template>
            <EmptyState text={props.empty} />
          </template>
        </div>
      </article>
    </div>
  );
}
function EmptyState({ text }: { text: string }) {
  return (
    <div class="empty-state">
      <Icon name="sun" />
      <p>{text}</p>
    </div>
  );
}
function Meter({ value }: { value: number }) {
  return (
    <dd>
      <meter
        min="0"
        max="100"
        value={value}
        optimum="30"
        low="70"
        high="90"
        title={`${value}%`}
      ></meter>
    </dd>
  );
}
function System({ stats, t }: { stats: SystemStats; t: Translation }) {
  const number = new Intl.NumberFormat("en-US");
  return (
    <article class="card float" data-testid="system">
      <h5 class="title">
        <Icon name="activity" /> {t.T("globals.terms.system")}
      </h5>
      <dl class="vstack gap-4">
        <div class="hstack justify-between">
          <dt>Uptime</dt>
          <dd class="text-light">{stats.uptime}</dd>
        </div>
        <div class="hstack justify-between">
          <dt>App memory</dt>
          <dd class="text-light">{number.format(stats.appMemoryMb)} MB</dd>
        </div>
        {stats.memory ? (
          <div class="vstack gap-1">
            <dt class="hstack justify-between">
              System memory
              <span class="text-light">
                {number.format(stats.memory.usedMb)} / {number.format(stats.memory.totalMb)} MB
              </span>
            </dt>
            <Meter value={stats.memory.percent} />
          </div>
        ) : null}
        {stats.load ? (
          <div class="vstack gap-1">
            <dt class="hstack justify-between">
              CPU load
              <span class="text-light">
                {stats.load.one} / {stats.load.five} / {stats.load.fifteen}
              </span>
            </dt>
            <Meter value={stats.load.percent} />
          </div>
        ) : null}
        <div class="hstack justify-between">
          <dt>CPU cores</dt>
          <dd class="text-light">{stats.cores}</dd>
        </div>
      </dl>
    </article>
  );
}

export const dashboardView: AdminView = ({ context, site, can }) => {
  const t = context.app.i18n;
  const term = (name: string) => t.T(`globals.terms.${name}`);
  const campaignsTitle = t.Ts("globals.terms.recent", "name", term("campaigns").toLowerCase());
  return {
    title: term("dashboard"),
    pageId: "dashboard",
    script: "dashboard",
    translationKeys: [
      "globals.buttons.view",
      "globals.buttons.filter",
      ...statuses.map((status) => `globals.terms.${status}`),
    ],
    body: (
      <section class="dashboard" x-data="dashboardView">
        <header class="page-header">
          <h3 class="page-title">{dayFormat.format(context.app.clock.now())}</h3>
        </header>
        <div class="vstack gap-6">
          <Alert name="countsError" />
          <section class="row" x-bind:aria-busy="counts === null && !countsError">
            <Stat
              icon="list"
              label={term("lists")}
              name="lists"
              href="/admin/lists"
              value="count('lists.total')"
            >
              <StatMeta
                href="/admin/lists?type=public"
                value="count('lists.public')"
                label={term("public")}
              />
              <StatMeta
                href="/admin/lists?type=private"
                value="count('lists.private')"
                label={term("private")}
              />
            </Stat>
            <Stat
              icon="at-sign"
              label={term("subscribers")}
              name="subscribers"
              href="/admin/subscribers"
              value="count('subscribers.total')"
            >
              <StatMeta
                href="/admin/subscribers?subscription_status=none"
                value="count('subscribers.orphans')"
                label={t.T("dashboard.orphanSubs")}
              />
              <StatMeta
                href="/admin/subscribers?status=blocklisted"
                value="count('subscribers.blocklisted')"
                label={term("blocklisted")}
              />
            </Stat>
            <Stat
              icon="send"
              label={term("campaigns")}
              name="campaigns"
              href="/admin/campaigns"
              value="count('campaigns.total')"
            >
              <StatMeta
                href="/admin/campaigns?status=scheduled"
                value="count('campaigns.by_status.scheduled')"
                label={term("scheduled")}
              />
              <StatMeta
                href="/admin/campaigns?status=finished"
                value="count('campaigns.by_status.finished')"
                label={term("finished")}
              />
            </Stat>
            <Stat
              icon="mail"
              label={t.T("dashboard.messagesSent")}
              name="messages"
              value="count('messages')"
            />
          </section>
          <Alert name="chartsError" />
          <section class="row" x-bind:aria-busy="chartsLoading">
            <Chart
              id="chart-views"
              title={t.T("dashboard.campaignViews")}
              empty={t.T("globals.messages.emptyState")}
            />
            <Chart
              id="chart-clicks"
              title={t.T("dashboard.linkClicks")}
              empty={t.T("globals.messages.emptyState")}
            />
          </section>
          <section class="row">
            <div class="col-8">
              <article class="card float">
                <h5 class="title">{campaignsTitle}</h5>
                <Alert name="campaignsError" />
                <div class="table-wrapper" x-bind:aria-busy="campaigns === null && !campaignsError">
                  <table>
                    <tbody>
                      <template x-for="c in campaigns ?? []" x-bind:key="c.id">
                        <tr data-testid="campaign-row">
                          <td width="55%">
                            <div
                              class="avatar"
                              x-bind:class="{ disabled: c.status === 'cancelled' }"
                            >
                              <a
                                class="unstyled avatar-icon avatar-campaign"
                                x-bind:href="`/admin/campaigns/${c.id}`"
                                x-bind:title="viewTitle(c)"
                                x-bind:aria-label="viewTitle(c)"
                              >
                                <span
                                  class="avatar-initials"
                                  aria-hidden="true"
                                  x-text="initials(c.name)"
                                ></span>
                              </a>
                              <div class="avatar-label">
                                <a
                                  class="unstyled"
                                  x-bind:href="`/admin/campaigns/${c.id}`"
                                  x-text="c.name"
                                ></a>
                              </div>
                            </div>
                          </td>
                          <td width="20%">
                            <a
                              x-bind:href="`/admin/campaigns?status=${c.status}`"
                              x-bind:title="filterTitle(c)"
                            >
                              <span class="badge enum" x-bind:class="`status-${c.status}`">
                                <span class="dot">●</span> <span x-text="statusLabel(c)"></span>
                              </span>
                            </a>
                          </td>
                          <td width="20%" class="text-light" x-text="campaignDate(c)"></td>
                          <td class="actions align-right">
                            {can("campaigns:get_analytics") ? (
                              <a x-bind:href="analyticsLink(c)" title={term("analytics")}>
                                <Icon name="bar-chart-2" />
                              </a>
                            ) : null}
                          </td>
                        </tr>
                      </template>
                      <tr x-show="campaigns?.length === 0" style="display: none">
                        <td colspan="4">
                          <EmptyState text={t.T("globals.messages.emptyState")} />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </article>
            </div>
            <div class="col-4">
              <System stats={systemStats()} t={t} />
            </div>
          </section>
          {site.cacheSlowQueries ? (
            <div role="alert">*{t.T("globals.messages.slowQueriesCached")}</div>
          ) : null}
        </div>
      </section>
    ),
  };
};
