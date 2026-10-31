// Adapted from listmonk static/admin/views/import.html and cmd/import.go (ViewImport) at 6fcd95f.
// Upstream renders the form or the status from the importer's state; here import.js reads the
// status from the API and shows one of them, so a log line only reaches the page through x-text.
// The file input is a plain one: this Oat build has no <ot-upload> element.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import { Alert, Breadcrumbs, ListSelector } from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";

const importKeys = [
  "import.importStarted",
  "import.pollStopped",
  "import.recordsCount",
  "import.subscribeWarning",
];
const csvExample = `email,name,attributes
user1@mail.com,"User One","{""age"": 42, ""planet"": ""Mars""}"
user2@mail.com,"User Two","{""age"": 24, ""job"": ""Time Traveller""}"`;

function Parameters({ t }: { t: Translation }) {
  const radio = (name: string, value: string, model: string, label: string) => (
    <label>
      <input
        type="radio"
        name={name}
        value={value}
        x-model={model}
        data-testid={`check-${value}`}
      />{" "}
      {label}
    </label>
  );
  return (
    <fieldset class="card">
      <legend>{t.T("import.title")}</legend>
      <div class="row fields">
        <div class="col-4">
          <fieldset class="vstack gap-6">
            <legend>{t.T("globals.fields.mode")}</legend>
            <div class="hstack">
              {radio("mode", "subscribe", "form.mode", t.T("globals.buttons.subscribe"))}
              {radio("mode", "blocklist", "form.mode", t.T("globals.terms.blocklist"))}
            </div>
            <label data-field="">
              <input
                type="checkbox"
                role="switch"
                x-model="form.overwriteUserInfo"
                data-testid="overwrite-user-info"
              />{" "}
              {t.T("import.overwriteUserInfo")}
              <small data-hint="">{t.T("import.overwriteUserInfoHelp")}</small>
            </label>
          </fieldset>
        </div>
        <div class="col-4">
          <fieldset class="vstack gap-6">
            <legend>{t.T("globals.fields.status")}</legend>
            <template x-if="form.mode === 'subscribe'">
              <div class="hstack">
                {radio(
                  "subStatus",
                  "unconfirmed",
                  "form.subStatus",
                  t.T("globals.terms.unconfirmed"),
                )}
                {radio("subStatus", "confirmed", "form.subStatus", t.T("globals.terms.confirmed"))}
              </div>
            </template>
            <template x-if="form.mode === 'blocklist'">
              {radio(
                "subStatus",
                "unsubscribed",
                "form.subStatus",
                t.T("globals.terms.unsubscribed"),
              )}
            </template>
            <template x-if="form.mode === 'subscribe'">
              <label data-field="">
                <input
                  type="checkbox"
                  role="switch"
                  x-model="form.overwriteSubStatus"
                  data-testid="overwrite-sub-status"
                />{" "}
                {t.T("import.overwriteSubStatus")}
                <small data-hint="">{t.T("import.overwriteSubStatusHelp")}</small>
              </label>
            </template>
          </fieldset>
        </div>
        <div class="col-4">
          <fieldset class="vstack gap-6">
            <legend>{t.T("import.csvDelim")}</legend>
            <label data-field="" class="delimiter">
              <input name="delim" x-model="form.delim" placeholder="," maxlength="1" required />
              <small data-hint="">{t.T("import.csvDelimHelp")}</small>
            </label>
          </fieldset>
        </div>
      </div>
    </fieldset>
  );
}
function UploadForm({ t }: { t: Translation }) {
  return (
    <form x-show="isIdle" style="display: none" {...{ "x-on:submit.prevent": "onUpload" }}>
      <Parameters t={t} />
      <template x-if="form.mode === 'subscribe'">
        <fieldset class="card">
          <legend>{t.T("globals.terms.lists")}</legend>
          <ListSelector
            model="form.lists"
            id="import-lists"
            placeholder={t.T("import.listSubHelp")}
            t={t}
          />
        </fieldset>
      </template>
      <fieldset class="card">
        <legend>{t.T("globals.buttons.upload")}</legend>
        <label data-field="">
          {t.T("import.csvFile")}
          <input
            type="file"
            name="file"
            accept=".csv"
            x-ref="file"
            x-on:change="form.file = $event.target.files[0] || null"
          />
          <small data-hint="">{t.T("import.csvFileHelp")}</small>
        </label>
      </fieldset>
      <footer class="hstack justify-end mt-6">
        <button
          type="submit"
          data-variant="primary"
          data-testid="btn-upload"
          x-bind:disabled="!canUpload || isProcessing"
          x-bind:aria-busy="isProcessing"
        >
          <Icon name="upload" /> {t.T("globals.buttons.upload")}
        </button>
      </footer>
    </form>
  );
}
function Status({ t }: { t: Translation }) {
  return (
    <section class="status" x-show="ready && !isIdle" style="display: none">
      <article class="card float">
        <h5
          class="title capitalize"
          x-bind:class="{ 'text-danger': status.status === 'failed' || status.status === 'stopped' }"
          x-text="status.status"
        ></h5>
        <div class="row">
          <header class="col-8">
            <small class="text-light hstack">
              <span
                class="badge"
                x-bind:data-variant="statusVariant"
                x-text="progress + '%'"
              ></span>
              <span x-show="isRunning" aria-busy="true" data-spinner="small"></span>
            </small>
          </header>
          <div class="col-4 hstack justify-end items-center">
            <button
              type="button"
              data-variant="danger"
              data-testid="btn-stop"
              x-show="!isDone"
              x-on:click="stopImport"
              x-bind:disabled="isProcessing || status.status === 'stopping'"
              x-bind:aria-busy="isProcessing"
            >
              {t.T("import.stopImport")}
            </button>
            <button
              type="button"
              data-variant="primary"
              data-testid="btn-done"
              x-show="isDone"
              x-on:click="stopImport"
              x-bind:disabled="isProcessing"
              x-bind:aria-busy="isProcessing"
            >
              {t.T("globals.messages.done")}
            </button>
          </div>
        </div>
        <footer>
          <progress value="0" x-bind:value="progress" max="100"></progress>
          <small class="text-light" x-text="recordsLabel"></small>
          <p
            class="text-danger mt-2"
            data-testid="stopped-hint"
            x-show="wasStopped"
            style="display: none"
          >
            {t.T("import.stoppedHint")}
          </p>
        </footer>
      </article>

      <article class="card float import-logs log-view mt-6">
        <h5 class="title">{t.T("globals.terms.logs")}</h5>
        <div class="lines" x-ref="logLines" data-testid="import-logs">
          <template x-for="(l, i) in logLines" x-bind:key="i">
            <span class="line">
              <span class="timestamp" x-text="l.timestamp"></span>{" "}
              <span class="log-message" x-text="l.message"></span>
            </span>
          </template>
        </div>
      </article>
    </section>
  );
}

export const importView: AdminView = ({ context, can }) => {
  const t = context.app.i18n;
  return {
    title: t.T("import.title"),
    pageId: "subscribers.import",
    script: "import",
    translationKeys: importKeys,
    body: (
      <>
        <Breadcrumbs
          parent={t.T("globals.terms.subscribers")}
          href={can("subscribers:get", "subscribers:get_all") ? "/admin/subscribers" : null}
          current={t.T("import.title")}
        />
        <section class="import" x-data="importView">
          <header class="page-header">
            <h1 class="page-title">{t.T("import.title")}</h1>
          </header>
          <div class="page-content">
            <Alert name="error" />
            <UploadForm t={t} />
            <Status t={t} />
            <div class="import-help mt-6" x-show="isIdle" style="display: none">
              <h6>{t.T("globals.terms.instructions")}</h6>
              <p class="text-light">{t.T("import.instructionsHelp")}</p>
              <blockquote class="csv-example">
                <code class="csv-headers">
                  <span>email,</span> <span>name,</span> <span>attributes</span>
                </code>
              </blockquote>
              <h6>{t.T("import.csvExample")}</h6>
              <pre class="csv-example">{csvExample}</pre>
            </div>
          </div>
        </section>
      </>
    ),
  };
};
