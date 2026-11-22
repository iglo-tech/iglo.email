// The send log (B127): every journaled transactional and sequence send, read from /api/sends by
// assets/admin/js/views/sends.js. Campaign mail is not journaled (04-sending.md#campaigns), so it is
// not listed here. A subject, address or sequence name reaches the page only through x-text.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import { Alert, EmptyRow } from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";

export const sendStatuses = ["queued", "sending", "sent", "failed", "skipped", "unknown"];
export const sendSources = ["tx", "sequence"];
export const sendKinds = ["transactional", "marketing"];
/** The labels of a send's status, as the send log and a subscriber's sends tab show them. */
export const sendStatusKeys = sendStatuses.map((status) => `sends.status.${status}`);
export const sendSourceKeys = ["sends.sourceTx", "sends.sourceSequence"];
/** Why a send or a step was skipped (B116, D131). A reason without a label shows as its code. */
export const skipReasonKeys = [
  "skipReasons.aggregate_limit",
  "skipReasons.frequency_cap",
  "skipReasons.late",
  "skipReasons.membership_changed",
  "skipReasons.render_failed",
  "skipReasons.subscriber_blocklisted",
  "skipReasons.subscriber_unavailable",
  "skipReasons.suppressed",
  "skipReasons.template_unavailable",
  "skipReasons.unsubscribed",
];
/** Why a send has no subject (B127 r1), in the words the send log and a subscriber's tab show. */
export const subjectKeys = [
  "sends.subjectExpired",
  "sends.subjectNotSent",
  "sends.subjectSkipped",
  "sends.subjectWiped",
];
/** Every key the browser reads for a send's labels, on the send log and on a subscriber's tab. */
export const sendKeys = [
  ...sendStatusKeys,
  ...sendSourceKeys,
  ...skipReasonKeys,
  ...subjectKeys,
  "sends.sequenceStep",
];

const options = (values: Array<string>, label: (value: string) => string) =>
  values.map((value) => <option value={value}>{label(value)}</option>);

function Filters({ t }: { t: Translation }) {
  return (
    <form
      method="get"
      class="send-filters row"
      data-testid="send-filters"
      {...{ "x-on:submit.prevent": "onFilter" }}
    >
      <div class="col-2">
        <label data-field="">
          {t.T("globals.fields.status")}
          <select x-model="filter.status" data-testid="filter-status">
            <option value=""></option>
            {options(sendStatuses, (status) => t.T(`sends.status.${status}`))}
          </select>
        </label>
      </div>
      <div class="col-2">
        <label data-field="">
          {t.T("sends.source")}
          <select x-model="filter.source" data-testid="filter-source">
            <option value=""></option>
            {options(sendSources, (source) =>
              t.T(source === "tx" ? "sends.sourceTx" : "sends.sourceSequence"),
            )}
          </select>
        </label>
      </div>
      <div class="col-2">
        <label data-field="">
          {t.T("globals.fields.type")}
          <select x-model="filter.kind" data-testid="filter-kind">
            <option value=""></option>
            {options(sendKinds, (kind) => t.T(`sequences.kind.${kind}`))}
          </select>
        </label>
      </div>
      <div class="col-3">
        <label data-field="">
          {t.T("sequences.subscriber")}
          <input
            x-model="filter.subscriber"
            data-testid="filter-subscriber"
            placeholder={t.T("sequences.subscriberHelp")}
          />
        </label>
      </div>
      <div class="col-2">
        <label data-field="">
          {t.T("globals.terms.list")}
          <select x-model="filter.list_id" data-testid="filter-list">
            <option value=""></option>
            <template x-for="l in lists" x-bind:key="l.id">
              <option x-bind:value="'' + l.id" x-text="l.name"></option>
            </template>
          </select>
        </label>
      </div>
      <div class="col-1 hstack align-end">
        <button type="submit" class="outline" data-testid="btn-filter">
          <Icon name="search" />
        </button>
      </div>
    </form>
  );
}

export const sendsView: AdminView = ({ context }) => {
  const t = context.app.i18n;
  const title = t.T("sends.title");
  return {
    title,
    pageId: "sends.all",
    script: "sends",
    translationKeys: sendKeys,
    body: (
      <section class="sends" x-data="sendsView">
        <header class="hstack justify-between page-header">
          <div class="hstack page-heading">
            <h1 class="page-title">
              {title} <span x-text="'(' + (page.total != null ? page.total : '-') + ')'"></span>
            </h1>
          </div>
        </header>
        <Alert name="error" />
        <div class="card">
          <Filters t={t} />
        </div>
        <div class="card page-content has-table">
          <div class="table-wrapper" x-bind:aria-busy="loading">
            <table>
              <thead>
                <tr>
                  <th>{t.T("globals.fields.id")}</th>
                  <th>{t.T("sends.subject")}</th>
                  <th>{t.T("subscribers.sendTo")}</th>
                  <th>{t.T("sends.source")}</th>
                  <th>{t.T("sequences.sequence")}</th>
                  <th>{t.T("globals.fields.status")}</th>
                  <th>{t.T("subscribers.sentAt")}</th>
                </tr>
              </thead>
              <tbody>
                <template x-for="s in sends" x-bind:key="s.id">
                  <tr data-testid="send-row" x-bind:data-id="s.id">
                    <td x-text="s.id"></td>
                    <td data-label={t.T("sends.subject")}>
                      <span x-text="subjectText(s)"></span>
                    </td>
                    <td data-label={t.T("subscribers.sendTo")}>
                      <template x-if="s.subscriber_id">
                        <a
                          class="unstyled"
                          x-bind:href="'/admin/subscribers/' + s.subscriber_id"
                          x-text="s.to_email || ('#' + s.subscriber_id)"
                        ></a>
                      </template>
                      <template x-if="!s.subscriber_id">
                        <span x-text="s.to_email || '-'"></span>
                      </template>
                    </td>
                    <td data-label={t.T("sends.source")}>
                      <span class="text-light" x-text="sourceText(s.source)"></span>
                    </td>
                    <td data-label={t.T("sequences.sequence")}>
                      <span x-text="sequenceText(s)"></span>
                    </td>
                    <td data-label={t.T("globals.fields.status")}>
                      <span
                        class="badge enum"
                        data-testid="send-status"
                        x-bind:data-variant="statusVariant(s.status)"
                        x-text="statusText(s.status)"
                      ></span>{" "}
                      <span class="text-light" x-text="skipText(s.skip_reason)"></span>
                    </td>
                    <td
                      data-label={t.T("subscribers.sentAt")}
                      x-text="niceDate(s.sent_at || s.created_at, true)"
                    ></td>
                  </tr>
                </template>
                <EmptyRow when="!loading && !error && !sends.length" colspan={7} t={t} />
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
      </section>
    ),
  };
};
