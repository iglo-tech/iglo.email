// Native screen with no upstream source (docs/design/05-sequences.md#admin-ui). The definition
// arrives from /api/sequences/:id and goes back through the same API, which owns validation; a
// save keeps the step fields this form does not show. Condition examples come from 05.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import { Alert, AvatarLink, Breadcrumbs, PreviewDialog } from "@/admin/views/parts";
import { sequenceStatusKeys } from "@/admin/views/sequences";
import type { Translation } from "@/i18n/i18n";
import { assetVersion } from "@/server/asset-manifest";
import { getID } from "@/server/validation";

const examples: [string, unknown][] = [
  ["No download since the trigger", { not: { event: "download_finished", since: "trigger" } }],
  ["Has a recent event", { event: "download_finished", since: "P30D", count: { gte: 1 } }],
  ["Attribute compare", { attr: "plan", op: "eq", value: "subscription" }],
  ["List membership", { list: 3, status: ["confirmed", "unconfirmed"] }],
  [
    "All of",
    {
      all: [
        { attr: "plan", op: "eq", value: "subscription" },
        { not: { event: "connected", since: "trigger" } },
      ],
    },
  ],
];
const sqlExample: [string, unknown] = [
  "Raw SQL",
  { sql: "json_extract(subscribers.attribs, '$.credits_left') < 100" },
];
const keys = [
  ...sequenceStatusKeys,
  "globals.messages.created",
  "globals.messages.deleted",
  "globals.messages.updated",
  "sequences.archiveConfirm",
  "sequences.condition",
  "sequences.editLive",
  "sequences.editLiveConfirm",
  "sequences.invalidJSON",
  "sequences.step",
  "sequences.subscriberNotFound",
  "sequences.triggerWhere",
];

function StepCard({
  t,
  canSql,
  canManage,
}: {
  t: Translation;
  canSql: boolean;
  canManage: boolean;
}) {
  const action = (handler: string, icon: string, label: string, disabled: string, test: string) => (
    <button
      type="button"
      class="ghost small"
      aria-label={label}
      title={label}
      data-testid={test}
      x-bind:disabled={disabled}
      {...{ "x-on:click.prevent": handler }}
    >
      <Icon name={icon} />
    </button>
  );
  return (
    <fieldset class="card step-card" data-testid="step-card">
      <legend x-text="stepTitle(i)"></legend>
      {canManage ? (
        <div class="hstack gap-1 justify-end">
          {action("onMove(i, -1)", "arrow-up", t.T("sequences.moveUp"), "i === 0", "btn-step-up")}
          {action(
            "onMove(i, 1)",
            "arrow-down",
            t.T("sequences.moveDown"),
            "i === steps.length - 1",
            "btn-step-down",
          )}
          {action(
            "onRemoveStep(i)",
            "trash-2",
            t.T("sequences.removeStep"),
            "false",
            "btn-step-remove",
          )}
        </div>
      ) : null}
      <div class="row">
        <div class="col-3">
          <label data-field="">
            {t.T("sequences.wait")}
            <input name="wait" required x-model="s.wait" data-testid="step-wait" />
            <small data-hint="">{t.T("sequences.waitHelp")}</small>
          </label>
        </div>
        <div class="col-3">
          <label data-field="">
            {t.T("globals.fields.type")}
            <select name="kind" x-model="s.kind" data-testid="step-kind">
              <option value="transactional">{t.T("sequences.kind.transactional")}</option>
              <option value="marketing">{t.T("sequences.kind.marketing")}</option>
            </select>
          </label>
        </div>
        <div class="col-6">
          <template x-if="templatesReadable">
            <label data-field="">
              {t.Tc("globals.terms.template", 1)}
              <select
                name="template"
                data-testid="step-template"
                x-on:change="s.template_id = Number($event.target.value) || null"
              >
                <option value="" x-bind:selected="!s.template_id">
                  {t.T("sequences.noTemplate")}
                </option>
                <template x-for="tpl in templateOptions(s)" x-bind:key="tpl.id">
                  <option
                    x-bind:value="tpl.id"
                    x-bind:selected="tpl.id === s.template_id"
                    x-text="tpl.name"
                  ></option>
                </template>
              </select>
            </label>
          </template>
          <template x-if="!templatesReadable">
            <label data-field="">
              {t.Tc("globals.terms.template", 1)}
              <input type="number" min="1" {...{ "x-model.number": "s.template_id" }} />
            </label>
          </template>
          <template x-if="templatesReadable && s.template_id">
            <button
              type="button"
              class="ghost small"
              data-testid="btn-step-preview"
              x-on:click="onPreviewTemplate(s)"
            >
              <Icon name="eye" /> {t.T("sequences.previewTemplate")}
            </button>
          </template>
        </div>
      </div>
      <div data-field="">
        <label>{t.T("sequences.condition")}</label>
        <code-editor
          lang="json"
          x-init="$el.value = s.condition"
          x-on:input="s.condition = $event.target.value"
          {...(canManage ? {} : { disabled: true })}
        ></code-editor>
        <small data-hint="">
          {t.T("sequences.conditionHelp")} {canSql ? null : t.T("sequences.conditionSql")}
        </small>
      </div>
      <div class="row">
        <div class="col-6">
          <label data-field="">
            {t.T("sequences.onFalse")}
            <select name="on_false" x-model="s.on_false" data-testid="step-on-false">
              <option value="exit">{t.T("sequences.onFalseExit")}</option>
              <option value="skip">{t.T("sequences.onFalseSkip")}</option>
            </select>
          </label>
        </div>
        {canManage ? (
          <div class="col-6">
            <label data-field="">
              {t.T("sequences.exampleInsert")}
              <select x-on:change="onExample(s, $event)" data-testid="step-example">
                <option value="">{t.T("sequences.exampleInsert")}</option>
                {[...examples, ...(canSql ? [sqlExample] : [])].map(([name, value]) => (
                  <option value={JSON.stringify(value, null, 2)}>{name}</option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}

function TestDialog({ t }: { t: Translation }) {
  return (
    <dialog x-ref="testDialog" data-testid="test-dialog">
      <form {...{ "x-on:submit.prevent": "onStartTest" }}>
        <div class="dialog-card content">
          <header class="dialog-head">
            <h4 class="dialog-title">{t.T("sequences.testMode")}</h4>
          </header>
          <section class="dialog-body">
            <div role="alert" data-variant="warning" data-testid="test-warning">
              {t.T("sequences.testReal")}
            </div>
            <p>{t.T("sequences.testConsent")}</p>
            <p>{t.T("sequences.testLeavesAlone")}</p>
            <label data-field="">
              {t.T("sequences.subscriber")}
              <input required x-model="testSubscriber" data-testid="test-subscriber" />
              <small data-hint="">{t.T("sequences.subscriberHelp")}</small>
            </label>
            <div
              role="alert"
              data-variant="danger"
              data-testid="test-error"
              x-show="testError"
              x-text="testError"
              style="display: none"
            ></div>
          </section>
          <footer class="dialog-foot hstack gap-3 justify-end">
            <button type="button" class="outline" x-on:click="$refs.testDialog.close()">
              {t.T("globals.buttons.close")}
            </button>
            <button
              type="submit"
              data-variant="primary"
              data-testid="btn-test-start"
              x-bind:disabled="isLoading('sequences.test')"
            >
              {t.T("sequences.testStart")}
            </button>
          </footer>
        </div>
      </form>
    </dialog>
  );
}

function sequenceView(isNew: boolean): AdminView {
  return ({ context, can }) => {
    const t = context.app.i18n;
    const canManage = can("sequences:manage");
    const canSql = can("subscribers:sql_query");
    const heading = t.T("sequences.newSequence");
    const status = (handler: string, test: string, label: string, when: string) => (
      <template x-if={when}>
        <button
          type="button"
          class="outline external"
          data-testid={test}
          x-bind:disabled="isLoading('sequences')"
          {...{ "x-on:click.prevent": handler }}
        >
          {label}
        </button>
      </template>
    );
    return {
      title: isNew ? heading : t.T("globals.terms.sequences"),
      pageId: "sequences.all",
      script: "sequences",
      translationKeys: keys,
      config: isNew ? { is_new: true } : { sequence_id: String(getID(context)) },
      body: (
        <>
          <section class="sequences" x-data="sequenceForm">
            <Breadcrumbs
              parent={t.T("globals.terms.sequences")}
              href="/admin/sequences"
              current={isNew ? heading : <span x-text="saved.name"></span>}
            />
            <header class="row page-header">
              <div class="col-6">
                <div class="avatar avatar-title">
                  {isNew ? (
                    <h1 class="page-title avatar-label">{heading}</h1>
                  ) : (
                    <>
                      <AvatarLink
                        kind="list"
                        name="saved.name"
                        href="`/admin/sequences/${saved.id}`"
                        title="saved.name"
                      />
                      <h1 class="page-title avatar-label">
                        <span x-text="saved.name" data-testid="sequence-name"></span>{" "}
                        <span
                          class="badge"
                          data-testid="sequence-status"
                          x-bind:class="`status-${saved.status}`"
                        >
                          <span class="dot">●</span>{" "}
                          <span x-text="statusLabel(saved.status)"></span>
                        </span>
                      </h1>
                    </>
                  )}
                </div>
              </div>
              {!isNew && canManage ? (
                <div class="col-6 hstack justify-end buttons" x-show="ready" style="display: none">
                  {status(
                    "onStatus('active')",
                    "btn-activate",
                    t.T("sequences.activate"),
                    "saved.status === 'draft'",
                  )}
                  {status(
                    "onStatus('active')",
                    "btn-resume",
                    t.T("sequences.resume"),
                    "saved.status === 'paused'",
                  )}
                  {status(
                    "onStatus('paused')",
                    "btn-pause",
                    t.T("sequences.pause"),
                    "saved.status === 'active'",
                  )}
                  {status(
                    "onStatus('archived')",
                    "btn-archive",
                    t.T("sequences.archive"),
                    "saved.status !== 'archived'",
                  )}
                  <template x-if="saved.status === 'active'">
                    <button
                      type="button"
                      data-variant="primary"
                      data-testid="btn-test-mode"
                      x-on:click="onOpenTest"
                    >
                      <Icon name="send" /> {t.T("sequences.testMode")}
                    </button>
                  </template>
                </div>
              ) : null}
            </header>
            <Alert name="error" />
            <div
              role="alert"
              data-variant="warning"
              data-testid="live-warning"
              x-show="ready && saved.active_enrollments > 0"
              x-text="liveWarning"
              style="display: none"
            ></div>
            <div x-show="ready" style="display: none">
              <form novalidate {...{ "x-on:submit.prevent": "onSubmit" }}>
                <div class="page-content content">
                  <fieldset class="card">
                    <legend>{t.T("sequences.trigger")}</legend>
                    <label data-field="">
                      {t.T("globals.fields.name")}
                      <input
                        name="name"
                        maxlength="200"
                        required
                        autofocus
                        x-model="form.name"
                        data-testid="sequence-name-input"
                      />
                    </label>
                    <div class="row">
                      <div class="col-6">
                        <label data-field="">
                          {t.T("sequences.triggerEvent")}
                          <input
                            name="event"
                            required
                            x-model="form.event"
                            data-testid="trigger-event"
                          />
                        </label>
                      </div>
                      <div class="col-6">
                        <label data-field="">
                          {t.T("sequences.reentry")}
                          <select name="reentry" x-model="form.reentry" data-testid="reentry">
                            <option value="never">{t.T("sequences.reentry.never")}</option>
                            <option value="after_exit">
                              {t.T("sequences.reentry.after_exit")}
                            </option>
                            <option value="always">{t.T("sequences.reentry.always")}</option>
                          </select>
                        </label>
                      </div>
                    </div>
                    <div data-field="">
                      <label>{t.T("sequences.triggerWhere")}</label>
                      <template x-if="ready">
                        <code-editor
                          lang="json"
                          data-testid="trigger-where"
                          x-init="$el.value = form.where"
                          x-on:input="form.where = $event.target.value"
                          {...(canManage ? {} : { disabled: true })}
                        ></code-editor>
                      </template>
                      <small data-hint="">{t.T("sequences.triggerWhereHelp")}</small>
                    </div>
                    <div class="row">
                      <div class="col-6">
                        <label data-field="">
                          {t.T("sequences.exitEvents")}
                          <textarea
                            name="exit_on"
                            rows="3"
                            class="monospace"
                            x-model="form.exitOn"
                            data-testid="exit-events"
                          ></textarea>
                          <small data-hint="">{t.T("sequences.exitEventsHelp")}</small>
                        </label>
                      </div>
                      <div class="col-6">
                        <label data-field="">
                          {t.T("globals.terms.list")}
                          <select
                            name="list"
                            data-testid="sequence-list"
                            x-on:change="form.list_id = Number($event.target.value) || null"
                          >
                            <option value="" x-bind:selected="!form.list_id">
                              {t.T("sequences.noList")}
                            </option>
                            <template x-for="l in listOptions()" x-bind:key="l.id">
                              <option
                                x-bind:value="l.id"
                                x-bind:selected="l.id === form.list_id"
                                x-text="l.name"
                              ></option>
                            </template>
                          </select>
                          <small data-hint="">{t.T("sequences.listHelp")}</small>
                        </label>
                      </div>
                    </div>
                  </fieldset>
                  <h3>{t.T("sequences.steps")}</h3>
                  <template x-if="ready">
                    <div class="vstack gap-4" data-testid="steps">
                      <template x-for="(s, i) in steps" x-bind:key="`${generation}-${s.uid}`">
                        <StepCard t={t} canSql={canSql} canManage={canManage} />
                      </template>
                    </div>
                  </template>
                  <footer class="hstack justify-between mt-6">
                    <div class="hstack gap-3">
                      {canManage ? (
                        <button
                          type="button"
                          class="outline"
                          data-testid="btn-add-step"
                          x-on:click="onAddStep"
                        >
                          <Icon name="plus" /> {t.T("sequences.addStep")}
                        </button>
                      ) : null}
                      {!isNew && canManage ? (
                        <button
                          type="button"
                          class="outline"
                          data-variant="danger"
                          data-testid="btn-delete"
                          {...{ "x-on:click.prevent": "onDelete" }}
                        >
                          <Icon name="trash-2" /> {t.T("globals.buttons.delete")}
                        </button>
                      ) : null}
                    </div>
                    {canManage ? (
                      <button
                        type="submit"
                        data-variant="primary"
                        data-testid="btn-save"
                        x-bind:disabled="isLoading('sequences')"
                        x-bind:aria-busy="isLoading('sequences')"
                      >
                        <Icon name="save" /> {t.T("globals.buttons.save")}
                      </button>
                    ) : null}
                  </footer>
                </div>
              </form>
            </div>
            {!isNew && canManage ? <TestDialog t={t} /> : null}
            <PreviewDialog t={t} />
          </section>
          <script
            type="module"
            src={`/admin/static/js/code-editor.js?v=${assetVersion}`}
            defer
          ></script>
        </>
      ),
    };
  };
}

export const newSequenceView = sequenceView(true);
export const editSequenceView = sequenceView(false);
