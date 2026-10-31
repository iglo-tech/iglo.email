// Adapted from listmonk static/admin/views/maintenance.html and cmd/maintenance.go (ViewMaintenance)
// at 6fcd95f. Upstream's Database section is Postgres VACUUM, which nothing here runs, so it is left
// out; `maintenance.db` stays in the settings a full save returns (07-api-and-ui.md).
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import { Breadcrumbs } from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";

const maintenanceKeys = [
  "globals.messages.deletedCount",
  "globals.messages.done",
  "globals.terms.subscribers",
  "globals.terms.subscriptions",
];

function Delete({ action, disabled, t }: { action: string; disabled: string; t: Translation }) {
  return (
    <button
      type="button"
      data-variant="danger"
      x-bind:disabled={disabled}
      x-bind:aria-busy="isLoading('maintenance')"
      data-spinner="small"
      x-on:click={action}
    >
      <Icon name="trash-2" /> {t.T("globals.buttons.delete")}
    </button>
  );
}
function DateField({ model, label }: { model: string; label: string }) {
  return (
    <div class="col-4">
      <label data-field="">
        {label}
        <input type="date" x-model={model} required />
      </label>
    </div>
  );
}

export const maintenanceView: AdminView = ({ context }) => {
  const t = context.app.i18n;
  const data = (model: string, options: [string, string][], hints: string[] = []) => (
    <div class="col-4">
      <label data-field="">
        Data
        <select aria-label="Data" x-model={model}>
          {options.map(([value, label]) => (
            <option value={value}>{label}</option>
          ))}
        </select>
        {hints.map((hint) => (
          <small data-hint="">{hint}</small>
        ))}
      </label>
    </div>
  );
  const title = t.T("globals.terms.maintenance");
  return {
    title,
    pageId: "settings.maintenance",
    script: "maintenance",
    translationKeys: maintenanceKeys,
    body: (
      <>
        <Breadcrumbs
          parent={t.T("globals.terms.settings")}
          href="/admin/settings"
          current={title}
        />
        <section class="maintenance" x-data="maintenanceView">
          <header class="page-header">
            <h1 class="page-title">{title}</h1>
            <p class="text-light">{t.T("maintenance.help")}</p>
          </header>
          <div class="page-content vstack gap-6">
            <fieldset class="card">
              <legend>{t.T("globals.terms.subscribers")}</legend>
              <div class="row">
                {data(
                  "subscriberType",
                  [
                    ["orphan", t.T("dashboard.orphanSubs")],
                    ["blocklisted", t.T("globals.terms.blocklisted")],
                  ],
                  [t.T("maintenance.orphanHelp"), t.T("maintenance.webhookBudget")],
                )}
                <div class="col-8 col-end hstack justify-end">
                  <Delete action="deleteSubscribers" disabled="isLoading('maintenance')" t={t} />
                </div>
              </div>
            </fieldset>

            <fieldset class="card">
              <legend>{t.Tc("globals.terms.subscriptions", 2)}</legend>
              <div class="row">
                {data("subscriptionType", [
                  ["optin", t.T("maintenance.maintenance.unconfirmedOptins")],
                ])}
                <DateField model="subscriptionDate" label={t.T("globals.fields.olderThan")} />
                <div class="col-4 col-end hstack justify-end">
                  <Delete
                    action="deleteSubscriptions"
                    disabled="isLoading('maintenance') || !subscriptionDate"
                    t={t}
                  />
                </div>
              </div>
            </fieldset>

            <fieldset class="card">
              <legend>{t.T("globals.terms.analytics")}</legend>
              <div class="row">
                {data("analyticsType", [
                  ["all", t.T("globals.terms.all")],
                  ["views", t.T("dashboard.campaignViews")],
                  ["clicks", t.T("dashboard.linkClicks")],
                ])}
                <DateField model="analyticsDate" label={t.T("globals.fields.olderThan")} />
                <div class="col-4 col-end hstack justify-end">
                  <Delete
                    action="deleteAnalytics"
                    disabled="isLoading('maintenance') || !analyticsDate"
                    t={t}
                  />
                </div>
              </div>

              <hr />
              <h5 class="text-5">{t.T("globals.buttons.export")}</h5>
              <div class="row">
                {data("exportType", [
                  ["views", t.T("dashboard.campaignViews")],
                  ["clicks", t.T("dashboard.linkClicks")],
                ])}
                <DateField model="exportDate" label={t.T("globals.fields.fromDate")} />
                <div class="col-4 col-end hstack justify-end">
                  <a
                    class="button"
                    data-variant="primary"
                    x-bind:href="exportURL"
                    x-bind:aria-disabled="!exportDate"
                  >
                    <Icon name="download-cloud" /> {t.T("globals.buttons.export")}
                  </a>
                </div>
              </div>
            </fieldset>
          </div>
        </section>
      </>
    ),
  };
};
