// Adapted from listmonk static/admin/views/analytics.html, static/admin/partials/
// analytics-date-range.html and cmd/campaign_analytics.go (viewAnalytics) at 6fcd95f. Upstream reads
// everything before it sends the page. Here the shell arrives at once and analytics.js reads the
// M3.3 routes, so a queued read does not hold the page, a 429, 422 or 500 shows in its own chart,
// and stored names reach the page only through x-text.
import { Icon } from "@/admin/layout/icon";
import type { AdminRequest, AdminView } from "@/admin/page";
import { Breadcrumbs, EmptyState } from "@/admin/views/parts";
import { parseBound } from "@/analytics/dates";
import { HttpError } from "@/server/response";

export type Resource = "campaigns" | "lists";

function Range({ request, from, to }: { request: AdminRequest; from: string; to: string }) {
  const t = request.context.app.i18n;
  const preset = (amount: number, unit: "hour" | "day" | "month") => (
    <button
      type="button"
      role="menuitem"
      class="ghost"
      x-on:click={`onDateRange(${amount}, '${unit}')`}
      x-bind:disabled="submitting"
    >
      {amount} {t.Tc(`globals.terms.${unit}`, amount)}
    </button>
  );
  return (
    <>
      <label>{t.T("globals.terms.range")}</label>
      <ot-dropdown>
        <button type="button" class="outline" popovertarget="analytics-dates">
          <span x-text="rangeLabel"></span> <Icon name="chevron-down" />
        </button>
        <div popover="" id="analytics-dates" class="analytics-dates" x-ref="dates">
          {preset(24, "hour")}
          {preset(7, "day")}
          {preset(30, "day")}
          {preset(6, "month")}
          {preset(12, "month")}
          <hr />
          <div class="custom-dates">
            <label data-field="">
              {t.T("globals.fields.fromDate")}
              <input type="datetime-local" name="from" x-model="from" value={from} required />
            </label>
            <label data-field="">
              {t.T("globals.fields.toDate")}
              <input
                type="datetime-local"
                name="to"
                x-model="to"
                value={to}
                x-bind:min="from"
                required
              />
            </label>
            <button type="submit" data-variant="secondary" x-bind:disabled="submitting">
              {t.T("globals.buttons.apply")}
            </button>
          </div>
        </div>
      </ot-dropdown>
    </>
  );
}

function ChartCard(props: {
  name: string;
  title: string;
  resource: Resource;
  empty: string;
  extra?: string;
}) {
  const { name: key, title, resource, extra } = props;
  const section = `sections['${key}']`;
  return (
    <article class="card float" data-testid={`chart-${key}`}>
      <h4 class="title">
        {title}{" "}
        <span
          class="text-lighter"
          x-show={`${section}.total > 0`}
          x-text={`count('${key}')`}
        ></span>
      </h4>
      <div
        role="alert"
        data-variant="danger"
        x-show={`${section}.error`}
        x-text={`${section}.error`}
        style="display: none"
      ></div>
      <div aria-busy="true" data-spinner="small" x-show={`${section}.loading`}></div>
      <div
        x-show={`${section}.ready && !${section}.total && !${section}.extra`}
        style="display: none"
      >
        <EmptyState text={props.empty} />
      </div>
      <div x-show={`${section}.total || ${section}.extra`} style="display: none">
        <div class="row">
          <div class="col-9">
            <div class="chart-box">
              <canvas
                id={`chart-${key}`}
                {...(extra ? { "data-extra-label": extra } : {})}
              ></canvas>
            </div>
          </div>
          <div class="col-3 donut-container">
            <canvas id={`chart-${key}-donut`}></canvas>
          </div>
        </div>
        <div class="hstack text-8 mt-2">
          <template x-for="(c, n) in items" x-bind:key="c.id">
            <span>
              <span aria-hidden="true" x-bind:style="'color: ' + color(n)">
                ●
              </span>{" "}
              <a x-bind:href={`'/admin/${resource}/' + c.id`} class="unstyled" x-text="c.label"></a>
              : <span data-testid="legend-count" x-text={`legendCount('${key}', c)`}></span>
              {extra ? (
                <span class="text-lighter">
                  {" "}
                  ({extra}: <span x-text={`extraCount('${key}', c)`}></span>)
                </span>
              ) : null}
            </span>
          </template>
        </div>
      </div>
    </article>
  );
}

/** viewAnalytics, without the reads. Bad IDs are a 400, as upstream. */
export const analyticsView =
  (resource: Resource): AdminView =>
  (request) => {
    const { context, site, can } = request;
    const t = context.app.i18n;
    const params = context.url.searchParams;
    const ids = params.getAll("id");
    for (const id of ids)
      if (!/^[1-9]\d{0,18}$/.test(id))
        throw new HttpError(400, t.Ts("globals.messages.errorInvalidIDs", "error", id));
    // Resolve the date range, defaulting to the last 7 days. The API reads times as UTC.
    const input = (value: string | null) =>
      value ? parseBound(value, "down")?.slice(0, 16) : undefined;
    const now = context.app.clock.now();
    // The form holds minutes, so "now" rounds up: it must not leave out the current minute.
    const to =
      input(params.get("to")) ?? new Date(now.getTime() + 60_000).toISOString().slice(0, 16);
    const from =
      input(params.get("from")) ??
      new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 16);
    const interval = params.get("interval") || "day";
    const unique = site.individualTracking && params.get("unique") === "true";
    const charts =
      resource === "campaigns" ||
      (can("campaigns:get", "campaigns:get_all") && can("campaigns:get_analytics"));
    const label = t.T(`globals.terms.${resource}`);
    const title = t.T("globals.terms.analytics");
    const views = t.T("globals.terms.views");
    const clicks = t.T("globals.terms.clicks");
    const uniqueLabel = t.T("globals.terms.unique");
    const shared = { resource, empty: t.T("globals.messages.emptyState") };
    return {
      title,
      pageId: `${resource}.analytics`,
      script: "analytics",
      config: { analytics: { resource, ids, from, to, interval, unique, charts } },
      body: (
        <>
          <Breadcrumbs
            parent={label}
            href={
              resource === "lists" || can("campaigns:get", "campaigns:get_all")
                ? `/admin/${resource}`
                : null
            }
            current={title}
          />
          <section class="analytics" x-data="analyticsView">
            <header class="page-header">
              <h1 class="page-title">{title}</h1>
            </header>
            <div class="vstack gap-6">
              <form
                method="get"
                action={`/admin/${resource}/analytics`}
                x-on:submit="submitting = true"
              >
                <div class="card float">
                  <h4 class="title">{title}</h4>
                  <div
                    role="alert"
                    data-variant="danger"
                    data-testid="error"
                    x-show="error"
                    x-text="error"
                    style="display: none"
                  ></div>
                  <div class="row">
                    <div class="col-5">
                      <label data-field="">
                        {label}
                        <ot-taginput x-model="chosen">
                          <input
                            list="analytics-items"
                            placeholder={label}
                            data-testid="items"
                            x-on:input="onQuery($el)"
                            x-on:pointerdown="onQuery($el)"
                            x-on:focus="onQuery($el)"
                          />
                          <datalist id="analytics-items"></datalist>
                        </ot-taginput>
                      </label>
                      <template x-for="c in chosen" x-bind:key="c.id">
                        <input type="hidden" name="id" x-bind:value="c.id" />
                      </template>
                    </div>
                    <div class="col-4">
                      <data data-field="">
                        <Range request={request} from={from} to={to} />
                        {site.disableTracking ? (
                          <span data-hint="">
                            <Icon name="alert-triangle" /> {t.T("analytics.trackingDisabled")}
                          </span>
                        ) : null}
                        {charts && site.individualTracking ? (
                          <label>
                            <input type="checkbox" name="unique" value="true" checked={unique} />{" "}
                            {t.T("analytics.showUnique")}
                          </label>
                        ) : null}
                      </data>
                    </div>
                    <div class="col-2">
                      <data data-field="">
                        <label for="analytics-interval">{t.T("globals.fields.interval")}</label>
                        <select id="analytics-interval" name="interval">
                          {["day", "hour", "week", "month"].map((value) => (
                            <option value={value} selected={interval === value}>
                              {t.Tc(`globals.terms.${value}`, 1)}
                            </option>
                          ))}
                        </select>
                      </data>
                    </div>
                    <div class="col-1">
                      <data data-field="">
                        <label aria-hidden="true">&nbsp;</label>
                        <button
                          type="submit"
                          aria-label={t.T("globals.buttons.search")}
                          x-bind:disabled="chosen.length === 0 || submitting"
                          x-bind:aria-busy="submitting"
                          data-spinner="small"
                        >
                          {t.T("globals.buttons.view")}
                        </button>
                      </data>
                    </div>
                  </div>
                </div>
              </form>

              {ids.length ? (
                <div class="vstack gap-6" x-show="items.length" style="display: none">
                  {resource === "lists" ? (
                    <ChartCard
                      name="subscriptions"
                      title={t.Tc("globals.terms.subscriptions", 2)}
                      {...shared}
                      extra={t.T("globals.terms.unsubscribed")}
                    />
                  ) : null}
                  {charts ? (
                    <>
                      <ChartCard name="views" title={views} {...shared} />
                      {unique ? (
                        <ChartCard
                          name="unique_views"
                          title={`${views} (${uniqueLabel})`}
                          {...shared}
                        />
                      ) : null}
                      <ChartCard name="clicks" title={clicks} {...shared} />
                      {unique ? (
                        <ChartCard
                          name="unique_clicks"
                          title={`${clicks} (${uniqueLabel})`}
                          {...shared}
                        />
                      ) : null}
                      <ChartCard name="bounces" title={t.T("globals.terms.bounces")} {...shared} />
                      <article class="card float" data-testid="chart-links">
                        <h4 class="title">{t.T("globals.terms.links")}</h4>
                        <div
                          role="alert"
                          data-variant="danger"
                          x-show="links.error"
                          x-text="links.error"
                          style="display: none"
                        ></div>
                        <div aria-busy="true" data-spinner="small" x-show="links.loading"></div>
                        <div x-show="links.ready && !links.count" style="display: none">
                          <EmptyState text={t.T("globals.messages.emptyState")} />
                        </div>
                        <div class="chart-box" x-show="links.count" style="display: none">
                          <canvas id="chart-links"></canvas>
                        </div>
                      </article>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
        </>
      ),
    };
  };
