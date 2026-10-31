// Native screens with no upstream source (docs/design/05-sequences.md#admin-ui). Rows and the
// timeline come from /api/enrollments, so a sequence name, an event's data or a reason reaches the
// page only through x-text, JSON included. The URL's filters go back through the JSX escaper.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import { Alert, Breadcrumbs, EmptyRow } from "@/admin/views/parts";
import { sequenceStatusKeys } from "@/admin/views/sequences";
import type { Translation } from "@/i18n/i18n";
import { getID } from "@/server/validation";

const keys = [
  ...sequenceStatusKeys,
  "globals.messages.confirm",
  "sequences.decision.failed",
  "sequences.decision.passed",
  "sequences.decision.queued",
  "sequences.decision.sending",
  "sequences.decision.sent",
  "sequences.decision.skipped",
  "sequences.decision.unknown",
  "sequences.entry.ended",
  "sequences.entry.endedReason",
  "sequences.entry.enrolled",
  "sequences.entry.step",
  "sequences.entry.stepReason",
  "sequences.entry.trigger",
  "sequences.entry.waiting",
  "sequences.kind.marketing",
  "sequences.kind.transactional",
  "sequences.subscriberNotFound",
];
const exitReasons = [
  "condition",
  "unsubscribed",
  "blocklisted",
  "manual",
  "sequence_archived",
  "subscriber_deleted",
];
const statuses = ["active", "completed", "exited", "canceled"];

function TestBadge({ t }: { t: Translation }) {
  return (
    <template x-if="e.test">
      <span class="badge" data-variant="warning" data-testid="test-badge">
        {t.T("sequences.testBadge")}
      </span>
    </template>
  );
}
function StatusBadge() {
  return (
    <span class="badge" x-bind:class="`status-${e.status}`">
      <span class="dot">●</span> <span x-text="statusLabel(e.status)"></span>
    </span>
  );
}
function Filters({ t }: { t: Translation }) {
  return (
    <form
      method="get"
      class="enrollment-filters row"
      data-testid="enrollment-filters"
      {...{ "x-on:submit.prevent": "onFilter" }}
    >
      <div class="col-3">
        <label data-field="">
          {t.T("sequences.sequence")}
          <select x-model="filter.sequence_id" data-testid="filter-sequence">
            <option value=""></option>
            <template x-for="s in sequenceOptions" x-bind:key="s.id">
              <option
                x-bind:value="s.id"
                x-bind:selected="String(s.id) === filter.sequence_id"
                x-text="s.name"
              ></option>
            </template>
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
          {t.T("globals.fields.status")}
          <select x-model="filter.status" data-testid="filter-status">
            <option value=""></option>
            {statuses.map((status) => (
              <option value={status}>{t.T(`sequences.status.${status}`)}</option>
            ))}
          </select>
        </label>
      </div>
      <div class="col-3">
        <label data-field="">
          {t.T("sequences.exitReason")}
          <input
            list="exit-reasons"
            maxlength="256"
            x-model="filter.exit_reason"
            data-testid="filter-exit-reason"
          />
          <datalist id="exit-reasons">
            {exitReasons.map((reason) => (
              <option value={reason}></option>
            ))}
          </datalist>
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
function EnrollDialog({ t }: { t: Translation }) {
  return (
    <dialog x-ref="enrollDialog" data-testid="enroll-dialog">
      <form {...{ "x-on:submit.prevent": "onEnroll" }}>
        <div class="dialog-card content">
          <header class="dialog-head">
            <h4 class="dialog-title">{t.T("sequences.enrollSubscriber")}</h4>
          </header>
          <section class="dialog-body">
            <label data-field="">
              {t.T("sequences.sequence")}
              <select required x-model="enroll.sequence_id" data-testid="enroll-sequence">
                <option value=""></option>
                <template x-for="s in sequenceOptions" x-bind:key="s.id">
                  <option x-bind:value="s.id" x-text="s.name"></option>
                </template>
              </select>
            </label>
            <label data-field="">
              {t.T("sequences.subscriber")}
              <input required x-model="enroll.subscriber" data-testid="enroll-subscriber" />
              <small data-hint="">{t.T("sequences.subscriberHelp")}</small>
            </label>
            <label data-field="">
              <input type="checkbox" x-model="enroll.force" /> {t.T("sequences.enrollForce")}
            </label>
            <div
              role="alert"
              data-variant="danger"
              data-testid="enroll-error"
              x-show="enrollError"
              x-text="enrollError"
              style="display: none"
            ></div>
          </section>
          <footer class="dialog-foot hstack gap-3 justify-end">
            <button type="button" class="outline" x-on:click="$refs.enrollDialog.close()">
              {t.T("globals.buttons.close")}
            </button>
            <button
              type="submit"
              data-variant="primary"
              data-testid="btn-enroll-submit"
              x-bind:disabled="isLoading('enrollments')"
            >
              {t.T("sequences.enroll")}
            </button>
          </footer>
        </div>
      </form>
    </dialog>
  );
}

export const enrollmentsView: AdminView = ({ context, can }) => {
  const t = context.app.i18n;
  const canManage = can("sequences:manage");
  const title = t.T("sequences.enrollments");
  return {
    title,
    pageId: "sequences.enrollments",
    script: "enrollments",
    translationKeys: keys,
    body: (
      <section class="sequences enrollments" x-data="enrollmentsView">
        <header class="hstack justify-between page-header">
          <div class="hstack page-heading">
            <h1 class="page-title">
              {title} <span x-text="`(${page.total ?? '-'})`"></span>
            </h1>
          </div>
          <div class="hstack justify-end buttons">
            {canManage ? (
              <button
                type="button"
                data-variant="primary"
                data-testid="btn-enroll"
                x-on:click="onOpenEnroll"
              >
                <Icon name="plus" /> {t.T("sequences.enroll")}
              </button>
            ) : null}
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
                  <th>{t.T("sequences.enrollment")}</th>
                  <th>{t.T("sequences.sequence")}</th>
                  <th>{t.T("sequences.subscriber")}</th>
                  <th>{t.T("globals.fields.status")}</th>
                  <th>{t.T("sequences.exitReason")}</th>
                  <th>{t.T("globals.fields.createdAt")}</th>
                  {canManage ? <th></th> : null}
                </tr>
              </thead>
              <tbody>
                <template x-for="e in enrollments" x-bind:key="e.id">
                  <tr data-testid="enrollment-row" x-bind:data-id="e.id">
                    <td>
                      <a
                        x-bind:href="`/admin/sequences/enrollments/${e.id}`"
                        x-text="`#${e.id}`"
                      ></a>{" "}
                      <TestBadge t={t} />
                    </td>
                    <td x-text="e.sequence_name"></td>
                    <td x-text="e.subscriber_email ?? `#${e.subscriber_id}`"></td>
                    <td>
                      <StatusBadge />
                    </td>
                    <td x-text="e.exit_reason ?? ''"></td>
                    <td x-text="niceDate(e.created_at, true)"></td>
                    {canManage ? (
                      <td class="actions align-right">
                        <template x-if="e.status === 'active'">
                          <button
                            type="button"
                            class="ghost small"
                            data-variant="danger"
                            data-testid="btn-cancel"
                            x-bind:disabled="isLoading('enrollments')"
                            {...{ "x-on:click.prevent": "onCancel(e.id)" }}
                          >
                            {t.T("sequences.cancelEnrollment")}
                          </button>
                        </template>
                      </td>
                    ) : null}
                  </tr>
                </template>
                <EmptyRow
                  when="!loading && !error && !enrollments.length"
                  colspan={canManage ? 7 : 6}
                  t={t}
                />
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
        {canManage ? <EnrollDialog t={t} /> : null}
      </section>
    ),
  };
};

export const enrollmentView: AdminView = ({ context, can }) => {
  const t = context.app.i18n;
  const id = String(getID(context));
  const parent = t.T("sequences.enrollments");
  const canSubscriber = can("subscribers:get", "subscribers:get_all");
  return {
    title: `${t.T("sequences.enrollment")} ${id}`,
    pageId: "sequences.enrollments",
    script: "enrollments",
    translationKeys: keys,
    config: { enrollment_id: id },
    body: (
      <section class="sequences enrollments" x-data="enrollmentView">
        <Breadcrumbs
          parent={parent}
          href="/admin/sequences/enrollments"
          current={<span x-text="`#${e.id ?? ''}`"></span>}
        />
        <Alert name="error" />
        <div x-show="ready" style="display: none">
          <header class="row page-header">
            <div class="col-8">
              <h1 class="page-title">
                <span x-text="e.sequence_name" data-testid="timeline-sequence"></span>{" "}
                <StatusBadge /> <TestBadge t={t} />
              </h1>
              <div class="text-light">
                {canSubscriber ? (
                  <a
                    x-bind:href="`/admin/subscribers/${e.subscriber_id}`"
                    x-text="e.subscriber_email ?? `#${e.subscriber_id}`"
                  ></a>
                ) : (
                  <span x-text="e.subscriber_email ?? `#${e.subscriber_id}`"></span>
                )}
              </div>
            </div>
            <div class="col-4 hstack justify-end buttons">
              {can("sequences:manage") ? (
                <template x-if="e.status === 'active'">
                  <button
                    type="button"
                    class="outline external"
                    data-variant="danger"
                    data-testid="btn-cancel"
                    x-bind:disabled="isLoading('enrollments')"
                    {...{ "x-on:click.prevent": "onCancel(e.id)" }}
                  >
                    {t.T("sequences.cancelEnrollment")}
                  </button>
                </template>
              ) : null}
            </div>
          </header>
          <div class="card page-content">
            <h3>{t.T("sequences.timeline")}</h3>
            <ol class="timeline" data-testid="timeline">
              <template x-for="(entry, i) in entries" x-bind:key="i">
                <li data-testid="timeline-entry" x-bind:data-type="entry.type">
                  <strong x-text="entryLabel(entry)"></strong>{" "}
                  <span class="text-light text-8" x-text="niceDate(entry.at, true)"></span>
                  <template x-if="entry.type === 'trigger'">
                    <pre data-testid="timeline-data" x-text="json(entry.data)"></pre>
                  </template>
                </li>
              </template>
            </ol>
          </div>
        </div>
      </section>
    ),
  };
};
