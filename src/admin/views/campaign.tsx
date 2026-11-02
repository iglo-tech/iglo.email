// Adapted from listmonk static/admin/views/campaign.html, partials/campaign-form.html,
// campaign-content.html, campaign-attribs.html, campaign-attachments.html, campaign-archive.html
// and cmd/campaigns.go (ViewCampaign, ViewNewCampaign) at 6fcd95f. The campaign, lists and templates
// arrive from the API, so a body or name only reaches the page through x-text, x-bind and the
// editors' values. Visual editing is deferred (D54): the format is offered only for a campaign that
// already has it, whose HTML is shown in the code editor.
import { Icon } from "@/admin/layout/icon";
import type { AdminRequest, AdminView } from "@/admin/page";
import { campaignConfig, campaignKeys } from "@/admin/views/campaigns";
import {
  Alert,
  AvatarLink,
  Breadcrumbs,
  EmptyState,
  ListSelector,
  PreviewDialog,
} from "@/admin/views/parts";
import { RichtextEditor } from "@/admin/views/richtext";
import type { Translation } from "@/i18n/i18n";
import { assetVersion } from "@/server/asset-manifest";
import { getID } from "@/server/validation";

interface FormProps {
  t: Translation;
  isNew: boolean;
  canSend: boolean;
  site: AdminRequest["site"];
}
function Formats({ t }: { t: Translation }) {
  return (
    <>
      {["richtext", "html", "markdown", "plain"].map((format) => (
        <option value={format}>{t.T(`editor.contentType.${format}`)}</option>
      ))}
      <template x-if="form.content_type === 'visual'">
        <option value="visual">{t.T("editor.contentType.visual")}</option>
      </template>
    </>
  );
}
function Schedule({ t, isNew, canSend }: Omit<FormProps, "site">) {
  return (
    <fieldset class="card">
      <legend>{t.T("campaigns.schedule")}</legend>
      <div class="row">
        <div class="col-6">
          <label data-field="">
            <input
              type="checkbox"
              role="switch"
              x-model="form.sendLater"
              x-on:change="onToggleSendLater"
              x-bind:disabled="!canEdit"
            />{" "}
            {t.T("campaigns.sendLater")}
          </label>
          <template x-if="form.sendLater">
            <label data-field="">
              {t.T("globals.fields.dateAndTime")}
              <input
                type="datetime-local"
                name="send_at"
                x-model="form.sendAtLocal"
                x-bind:disabled="!canEdit"
              />
            </label>
          </template>
        </div>
        {!isNew && canSend ? (
          <div class="col-6 col-end hstack justify-end">
            <button
              type="button"
              data-variant="primary"
              x-cloak=""
              x-show="canSchedule"
              x-bind:disabled="changing"
              x-on:click="onStart"
            >
              <Icon name="clock" /> {t.T("campaigns.schedule")}
            </button>
            <button
              type="button"
              class="outline"
              data-variant="danger"
              x-cloak=""
              x-show="canUnSchedule"
              x-bind:disabled="changing"
              x-on:click="onUnschedule"
            >
              <Icon name="clock" /> {t.T("globals.buttons.unschedule")}
            </button>
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}
function CampaignForm({ t, isNew, canSend, site }: FormProps) {
  return (
    <div class="page-content content">
      <form {...{ "x-on:submit.prevent": isNew ? "onCreate" : "onSave" }}>
        <section>
          <fieldset class="card">
            <legend>{t.Tc("globals.terms.campaign", 1)}</legend>
            <label data-field="">
              {t.T("globals.fields.name")}
              <input
                name="name"
                maxlength="200"
                x-model="form.name"
                x-bind:disabled="!canEdit"
                autofocus
                required
              />
            </label>
            <label data-field="">
              {t.T("globals.fields.subject")}
              <input
                name="subject"
                maxlength="5000"
                x-model="form.subject"
                x-bind:disabled="!canEdit"
                required
              />
            </label>
            <label data-field="">
              {t.T("globals.terms.tags")}
              <ot-taginput x-model="form.tags" x-bind:disabled="!canEdit">
                <input placeholder={t.T("globals.terms.tags")} maxlength="200" />
              </ot-taginput>
            </label>
          </fieldset>

          <fieldset class="card">
            <legend>{t.T("globals.terms.lists")}</legend>
            <ListSelector
              model="form.lists"
              id="campaign-lists"
              placeholder={t.T("campaigns.sendToLists")}
              disabled="!canEdit"
              t={t}
            />
          </fieldset>

          <fieldset class="card">
            <legend>{t.Tc("globals.terms.messenger", 1)}</legend>
            <div data-field="">
              <label for="campaign-from-email">{t.T("globals.fields.fromAddress")}</label>
              <input
                id="campaign-from-email"
                name="from_email"
                list="campaign-from-emails"
                maxlength="2000"
                x-model="form.from_email"
                x-bind:disabled="!canEdit"
                placeholder={t.T("campaigns.fromAddressPlaceholder")}
                required
              />
              <datalist id="campaign-from-emails">
                {site.fromEmails.map((address) => (
                  <option value={address}></option>
                ))}
              </datalist>
            </div>
            <label data-field="" for="messenger">
              {t.Tc("globals.terms.messenger", 1)}
              <select
                id="messenger"
                name="messenger"
                x-model="form.messenger"
                x-bind:disabled="!canEdit"
                required
              >
                {site.messengers.map((name) => (
                  <option value={name}>{name}</option>
                ))}
              </select>
            </label>
            <label data-field="" for="content_type">
              {t.T("globals.fields.format")}
              <select
                id="content_type"
                name="content_type"
                x-model="form.content_type"
                {...(isNew ? { "x-bind:disabled": "!canEdit" } : { disabled: true })}
              >
                <Formats t={t} />
              </select>
            </label>
          </fieldset>

          <Schedule t={t} isNew={isNew} canSend={canSend} />

          <fieldset class="card">
            <legend>{t.T("globals.fields.customHeaders")}</legend>
            <label data-field="">
              <input
                type="checkbox"
                role="switch"
                x-model="isHeadersVisible"
                x-bind:disabled="!canEdit"
              />{" "}
              {t.T("globals.fields.customHeaders")}
            </label>
            <template x-if="isHeadersVisible">
              <label data-field="">
                <textarea
                  name="headers"
                  x-model="form.headersStr"
                  x-bind:disabled="!canEdit"
                  placeholder='[{"X-Custom": "value"}]'
                ></textarea>
                <small data-hint="">{t.T("campaigns.customHeadersHelp")}</small>
              </label>
            </template>
          </fieldset>
        </section>
        {isNew ? (
          <footer class="hstack justify-end mt-6">
            <button
              type="submit"
              data-variant="primary"
              x-bind:disabled="isLoading('campaigns')"
              data-spinner="small"
              x-bind:aria-busy="isLoading('campaigns')"
            >
              {t.T("globals.buttons.continue")}
            </button>
          </footer>
        ) : null}
      </form>

      {isNew ? null : (
        <footer class="hstack justify-between mt-6">
          <div class="hstack gap-1">
            {["id", "uuid"].map((field) => (
              <button
                type="button"
                class="small"
                data-variant="secondary"
                title={t.T("globals.messages.clickToCopy")}
                aria-label={t.T(`globals.fields.${field}`)}
                x-on:click={`copyToClipboard(form.${field})`}
              >
                <strong>{t.T(`globals.fields.${field}`)}</strong>{" "}
                <span x-text={`form.${field}`}></span>
              </button>
            ))}
          </div>
          {canSend ? (
            <div class="hstack justify-end gap-1">
              <template x-if="canStart">
                <button
                  type="button"
                  data-variant="primary"
                  x-bind:disabled="changing"
                  x-on:click="onStart"
                >
                  <Icon name="send" /> {t.T("campaigns.start")}
                </button>
              </template>
            </div>
          ) : null}
        </footer>
      )}
    </div>
  );
}
function CampaignContent({ t }: { t: Translation }) {
  const code = (language: string, when: string) => (
    <template x-if={`ready && contentReady && ${when}`} data-editor="">
      <code-editor
        lang={language}
        x-init="setValue($el, form.body)"
        x-on:input="form.body = $event.target.value"
      ></code-editor>
    </template>
  );
  const editor = {
    "x-on:editor-ready": "editorReady = true",
    "x-on:campaign-save.window": "onSave",
    "x-on:campaign-preview.window": "onPreviewContent",
    "x-on:richtext-media": "onEditorMedia($event)",
    "x-on:richtext-removed": "editorRemoved = $event.detail.removed",
    "x-on:richtext-held": "editorHeld = true",
  };
  return (
    <div class="page-content content editor">
      <div
        role="alert"
        data-variant="warning"
        data-testid="editor-removed"
        style="display: none"
        x-show="canEdit && form.content_type === 'richtext' && editorRemoved.length > 0"
        x-text="editorNotice"
      ></div>
      <div
        role="status"
        data-variant="warning"
        class="hstack justify-between"
        data-testid="editor-held"
        style="display: none"
        x-show="form.content_type === 'richtext' && editorHeld"
      >
        <span>{t.T("editor.remoteImages")}</span>
        <button type="button" class="outline small" x-on:click="onShowRemoteImages">
          {t.T("editor.showRemoteImages")}
        </button>
      </div>
      <fieldset class="card editor-box">
        <div class="editor-body" x-bind:class="{ 'is-loading': showEditorSpinner }" {...editor}>
          <template x-if="ready && contentReady && form.content_type === 'richtext'" data-editor="">
            <RichtextEditor t={t} init="setValue($el, form.body)" />
          </template>
          {code("html", "['html', 'visual'].includes(form.content_type)")}
          {code("markdown", "form.content_type === 'markdown'")}
          <template x-if="ready && contentReady && form.content_type === 'plain'">
            <textarea
              class="plain-editor m-0"
              name="content"
              x-model="form.body"
              x-bind:disabled="!canEdit"
            ></textarea>
          </template>
        </div>
      </fieldset>
      <template x-if="canEdit && form.content_type !== 'plain'">
        <fieldset class="card">
          <legend>{t.T("campaigns.addAltText")}</legend>
          <input
            type="checkbox"
            role="switch"
            x-bind:checked="form.altbody !== null"
            x-on:change="$event.target.checked ? onAddAltBody() : onRemoveAltBody()"
            x-bind:disabled="!canEdit"
          />
          <template x-if="form.altbody !== null">
            <div data-field="">
              <textarea
                rows="10"
                aria-label={t.T("campaigns.addAltText")}
                x-model="form.altbody"
                x-bind:disabled="!canEdit"
              ></textarea>
            </div>
          </template>
        </fieldset>
      </template>
    </div>
  );
}
function CampaignAttribs({ t }: { t: Translation }) {
  return (
    <div class="page-content content">
      <fieldset class="card">
        <legend id="campaign-attribs-label">{t.T("globals.terms.attribs")}</legend>
        <div data-field="">
          <textarea
            x-model="form.attribsStr"
            x-bind:disabled="!canEdit"
            rows="15"
            aria-labelledby="campaign-attribs-label"
          ></textarea>
          <small data-hint="">{t.T("campaigns.attribsHelp")}</small>
        </div>
      </fieldset>
    </div>
  );
}
function Attachment({ t }: { t: Translation }) {
  return (
    <figure class="card">
      <a
        class="thumb"
        x-bind:href="m.url"
        target="_blank"
        rel="noopener noreferrer"
        x-bind:title="m.filename"
      >
        <template x-if="rasterThumb(m)">
          <img x-bind:src="m.thumb_url" x-bind:alt="m.filename" />
        </template>
        <template x-if="!rasterThumb(m)">
          <span class="ext" x-text="fileExt(m.filename)"></span>
        </template>
      </a>
      <figcaption>
        <span class="filename" x-bind:title="m.filename" x-text="m.filename"></span>
        <span class="text-light text-8" x-text="niceDate(m.created_at)"></span>
      </figcaption>
      <ot-dropdown class="actions">
        <button
          type="button"
          class="ghost more icon"
          aria-label={t.T("globals.buttons.more")}
          popovertarget=""
          x-bind:popovertarget="'attach-' + idx"
        >
          <Icon name="more-vertical" />
        </button>
        <menu popover="" x-bind:id="'attach-' + idx">
          <button
            type="button"
            role="menuitem"
            class="ghost"
            data-variant="danger"
            x-bind:disabled="!canEdit"
            {...{ "x-on:click.prevent": "onDeleteAttachment(m)" }}
          >
            <Icon name="trash-2" /> {t.T("globals.buttons.delete")}
          </button>
        </menu>
      </ot-dropdown>
    </figure>
  );
}
function CampaignAttachments({ t }: { t: Translation }) {
  return (
    <div class="card page-content attachments">
      <ul class="unstyled gallery">
        <template x-for="(m, idx) in form.media" x-bind:key="m.id || m.filename">
          <li>
            <Attachment t={t} />
          </li>
        </template>
      </ul>
      <template x-if="form.media.length === 0">
        <EmptyState text={t.T("globals.messages.emptyState")} />
      </template>
      <footer class="hstack justify-center">
        <button
          type="button"
          data-variant="primary"
          x-on:click="onOpenMedia('attach')"
          x-bind:disabled="!canEdit"
        >
          <Icon name="plus" /> {t.T("campaigns.addAttachments")}
        </button>
      </footer>
    </div>
  );
}
function CampaignArchive({ t, canManage }: { t: Translation; canManage: boolean }) {
  return (
    <div class="page-content content">
      <div class="row">
        <div class="col-6">
          <label data-field="">
            <input
              type="checkbox"
              role="switch"
              x-model="form.archive"
              x-on:change="onToggleArchive"
              x-bind:disabled="!canArchive"
            />{" "}
            {t.T("campaigns.archiveEnable")}
            <small data-hint="">{t.T("campaigns.archiveHelp")}</small>
          </label>
        </div>
        {canManage ? (
          <template x-if="!canEdit && canArchive">
            <div class="col-6 col-end align-right">
              <button
                type="button"
                data-variant="primary"
                x-on:click="onSaveArchive"
                x-bind:disabled="isLoading('campaigns')"
              >
                {t.T("globals.buttons.saveChanges")}
              </button>
            </div>
          </template>
        ) : null}
      </div>
      <template x-if="form.archive">
        <div>
          <fieldset class="card" x-bind:disabled="!canArchive">
            <legend>{t.T("globals.terms.archive")}</legend>
            <fieldset class="group">
              <legend class="mb-0">{t.Tc("globals.terms.template", 1)}</legend>
              <select
                {...{ "x-model.number": "form.archive_template_id" }}
                name="archive_template"
                x-bind:disabled="form.content_type === 'visual'"
                required
              >
                <template x-for="t in templatesFor('campaign')" x-bind:key="t.id">
                  <option
                    x-bind:value="t.id"
                    x-bind:selected="t.id === form.archive_template_id"
                    x-text="t.name"
                  ></option>
                </template>
              </select>
              <button type="button" data-variant="primary" x-on:click="onPreviewArchive">
                {t.T("globals.buttons.preview")}
              </button>
            </fieldset>
            <label data-field="">
              {t.T("globals.fields.slug")}
              <input name="archive_slug" maxlength="200" x-model="form.archive_slug" />
              <small data-hint="">{t.T("campaigns.archiveSlugHelp")}</small>
            </label>
            <a class="text-8" x-bind:href="archiveURL" target="_blank" rel="noopener noreferrer">
              <Icon name="link-2" /> <span x-text="archiveURL"></span>
            </a>
          </fieldset>
          <fieldset class="card" x-bind:disabled="!canArchive" data-field="">
            <legend>{t.T("campaigns.archiveMeta")}</legend>
            <textarea name="archive_meta" x-model="form.archiveMetaStr" rows="15"></textarea>
            <small data-hint="">{t.T("campaigns.archiveMetaHelp")}</small>
            <template x-if="form.archiveMetaStr === '' || form.archiveMetaStr === '{}'">
              <div class="mt-4">
                <button type="button" class="outline small" x-on:click="onFillArchiveMeta">
                  {t.T("globals.buttons.setDefault")}
                </button>
              </div>
            </template>
          </fieldset>
        </div>
      </template>
    </div>
  );
}
function ContentSettings({ t }: { t: Translation }) {
  return (
    <ot-dropdown class="content-settings" x-cloak="" x-show="activeTab === 'content'">
      <button
        type="button"
        class="outline small external"
        popovertarget="content-settings"
        x-bind:title="contentSettingsLabel"
      >
        <Icon name="settings" />{" "}
        <span class="content-settings-label" x-text="contentSettingsLabel"></span>
      </button>
      <div popover="" id="content-settings" class="content-settings-menu">
        <div data-field="">
          <label>{t.T("globals.fields.format")}</label>
          <select
            x-bind:value="form.content_type"
            x-on:change="onContentTypeChange($event)"
            x-bind:disabled="!canEdit"
            name="content_type"
          >
            <Formats t={t} />
          </select>
        </div>
        <template x-if="form.content_type !== 'visual'">
          <div data-field="">
            <label>{t.Tc("globals.terms.template", 1)}</label>
            <select
              {...{ "x-model.number": "form.template_id" }}
              x-bind:disabled="!canEdit"
              name="template"
            >
              <template x-for="t in templatesFor('campaign')" x-bind:key="t.id">
                <option
                  x-bind:value="t.id"
                  x-bind:selected="t.id === form.template_id"
                  x-text="t.name"
                ></option>
              </template>
            </select>
          </div>
        </template>
        <a
          class="text-light text-7"
          href="https://listmonk.app/docs/templating/#template-expressions"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Icon name="code" /> {t.T("campaigns.templatingRef")}
        </a>
      </div>
    </ot-dropdown>
  );
}
function Tabs(props: FormProps & { canManage: boolean }) {
  const { t, canManage } = props;
  const tab = (id: string, icon: string, label: string, mark: unknown = null) => (
    <button type="button" role="tab" id={id}>
      <Icon name={icon} /> {label} {mark as never}
    </button>
  );
  const done = (when: string) => (
    <span x-cloak="" x-show={when}>
      <Icon name="check-circle" />
    </span>
  );
  return (
    <ot-tabs data-anchor="tab">
      <div role="tablist" data-variant="primary">
        {tab("campaign", "send", t.Tc("globals.terms.campaign", 1))}
        {tab("content", "align-left", t.T("globals.fields.content"))}
        {tab(
          "attribs",
          "code",
          t.T("globals.terms.attribs"),
          done("form.attribsStr.trim() !== '' && form.attribsStr.trim() !== '{}'"),
        )}
        {tab(
          "attachments",
          "paperclip",
          t.T("globals.terms.attachments"),
          <span
            x-cloak=""
            x-show="form.media.length"
            x-text="'(' + form.media.length + ')'"
          ></span>,
        )}
        {tab("archive", "archive", t.T("globals.terms.archive"), done("form.archive"))}
      </div>
      <ContentSettings t={t} />
      <div role="tabpanel">
        <CampaignForm {...props} />
      </div>
      <div role="tabpanel">
        <CampaignContent t={t} />
      </div>
      <div role="tabpanel">
        <CampaignAttribs t={t} />
      </div>
      <div role="tabpanel">
        <CampaignAttachments t={t} />
      </div>
      <div role="tabpanel">
        <CampaignArchive t={t} canManage={canManage} />
      </div>
    </ot-tabs>
  );
}
function NewTabs({ t }: { t: Translation }) {
  const off = (icon: string, label: string) => (
    <a role="tab" aria-disabled="true">
      <Icon name={icon} /> {label}
    </a>
  );
  return (
    <div role="tablist" data-variant="primary">
      <a role="tab" aria-selected="true">
        <Icon name="mail" /> {t.Tc("globals.terms.campaign", 1)}
      </a>
      {off("file-text", t.T("globals.fields.content"))}
      {off("code", t.T("globals.terms.attribs"))}
      {off("paperclip", t.T("globals.terms.attachments"))}
      {off("archive", t.T("globals.terms.archive"))}
    </div>
  );
}
function TestSend({ t }: { t: Translation }) {
  return (
    <ot-dropdown>
      <button
        type="button"
        class="outline external campaign-test-btn dot-indicator"
        x-bind:class="{ 'is-active': form.testEmails.length > 0 }"
        popovertarget="campaign-test"
      >
        <Icon name="mail" /> {t.T("campaigns.sendTest")}
      </button>
      <div popover="" id="campaign-test" class="campaign-test">
        <label data-field="">
          <ot-taginput x-model="form.testEmails">
            <input
              type="email"
              placeholder={t.T("globals.fields.emails")}
              x-on:blur="$el.value !== '' && $el.closest('ot-taginput').add($el.value)"
              autofocus
            />
          </ot-taginput>
          <small data-hint="">{t.T("campaigns.sendTestHelp")}</small>
        </label>
        <div class="hstack justify-end buttons">
          <button
            type="button"
            data-variant="primary"
            x-on:click="onTest"
            x-bind:disabled="isLoading('campaigns.test')"
            x-bind:aria-busy="isLoading('campaigns.test')"
            data-spinner="small"
          >
            <Icon name="mail" /> {t.T("globals.buttons.send")}
          </button>
        </div>
      </div>
    </ot-dropdown>
  );
}
/** partials/media-picker.html: the media fragment posts the picked file to this page. */
function MediaPicker({ t }: { t: Translation }) {
  return (
    <dialog class="media-picker-modal" x-ref="mediaDialog" x-on:close="onMediaClose">
      <div class="dialog-card">
        <header class="dialog-head hstack justify-between">
          <h4 class="dialog-title">{t.T("globals.terms.media")}</h4>
        </header>
        <section class="dialog-body">
          <iframe x-ref="mediaFrame" title={t.T("globals.terms.media")}></iframe>
        </section>
        <footer class="dialog-foot align-right">
          <button type="button" class="outline" autofocus x-on:click="$refs.mediaDialog.close()">
            {t.T("globals.buttons.close")}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
function Header(props: { t: Translation; isNew: boolean; canManage: boolean }) {
  const { t, isNew, canManage } = props;
  const save = (
    <button
      type="button"
      data-variant="primary"
      x-show="canEdit"
      x-on:click="onSave"
      x-bind:disabled="isLoading('campaigns')"
      data-spinner="small"
      x-bind:aria-busy="isLoading('campaigns')"
    >
      <Icon name="save" /> {t.T("globals.buttons.saveChanges")}
    </button>
  );
  return (
    <header class="row page-header">
      <div class={isNew ? "col-12" : "col-6"}>
        <div class="hstack">
          <div class="avatar avatar-title" x-bind:class="{ disabled: form.status === 'cancelled' }">
            {isNew ? (
              <h1 class="page-title avatar-label">{t.T("campaigns.newCampaign")}</h1>
            ) : (
              <>
                <AvatarLink
                  kind="campaign"
                  name="saved.name"
                  href="'/admin/campaigns/' + form.id"
                  title="viewTitle(saved.name)"
                />
                <h1 class="page-title avatar-label" x-text="saved.name"></h1>
              </>
            )}
          </div>
          {isNew ? null : (
            <>
              <span class="badge enum" x-bind:class="'status-' + form.status" x-show="ready">
                <span class="dot">●</span> <span x-text="statusLabel(form.status)"></span>
              </span>
              <template x-if="form.type === 'optin'">
                <span class="badge enum optin">{t.T("lists.optin")}</span>
              </template>
            </>
          )}
        </div>
      </div>
      {isNew ? null : (
        <div class="col-6 hstack justify-end buttons" x-show="ready" style="display: none">
          {canManage ? <TestSend t={t} /> : null}
          <button
            type="button"
            class="outline external"
            x-on:click="onPreviewContent"
            aria-keyshortcuts="F9"
          >
            <Icon name="eye" /> {t.T("globals.buttons.preview")}
          </button>
          {canManage ? save : null}
        </div>
      )}
    </header>
  );
}

function view(isNew: boolean): AdminView {
  return (request) => {
    const { context, can, site } = request;
    const t = context.app.i18n;
    const id = isNew ? "" : String(getID(context));
    const tab = isNew ? undefined : context.params.tab;
    if (tab === "content" || tab === "attribs" || tab === "archive")
      return new Response(null, {
        status: 302,
        headers: { Location: `/admin/campaigns/${id}#tab=${tab}`, "Cache-Control": "no-store" },
      });
    const canManage = can("campaigns:manage", "campaigns:manage_all");
    const canSend = can("campaigns:send");
    const keys = {
      "x-on:keydown.ctrl.s.window.prevent": "onSaveShortcut",
      "x-on:keydown.meta.s.window.prevent": "onSaveShortcut",
    };
    const asset = (name: string) => `/admin/static/${name}?v=${assetVersion}`;
    const props = { t, isNew, canSend, site };
    // Only this screen mounts authored HTML, and only the button above asks for this (D71).
    const remoteImages = context.url.searchParams.get("remote_images") === "1";
    return {
      title: `${isNew ? `${t.T("campaigns.newCampaign")} / ` : ""}${t.T("globals.terms.campaigns")}`,
      pageId: isNew ? "campaigns.new" : "campaigns.all",
      script: "campaign",
      translationKeys: campaignKeys,
      remoteImages,
      config: {
        ...campaignConfig(request),
        remote_images: remoteImages,
        from_emails: site.fromEmails,
        can_manage: canManage,
        can_templates: can("templates:get"),
        can_media: can("media:get"),
        ...(isNew ? { is_new: true } : { campaign_id: id }),
      },
      body: (
        <>
          <section class="campaign" x-data="campaignView" {...keys}>
            <Breadcrumbs
              parent={t.T("globals.terms.campaigns")}
              href={can("campaigns:get", "campaigns:get_all") ? "/admin/campaigns" : null}
              current={isNew ? t.T("campaigns.newCampaign") : <span x-text="saved.name"></span>}
            />
            <Header t={t} isNew={isNew} canManage={canManage} />
            <Alert name="error" />
            <div x-show="ready" style="display: none">
              {isNew ? (
                <>
                  <NewTabs t={t} />
                  <CampaignForm {...props} />
                </>
              ) : (
                <Tabs {...props} canManage={canManage} />
              )}
            </div>
            <PreviewDialog t={t} />
            {isNew ? null : <MediaPicker t={t} />}
          </section>
          {isNew ? null : (
            <>
              <link href={asset("richtext.css")} rel="stylesheet" type="text/css" />
              <script type="module" src={asset("js/code-editor.js")} defer></script>
              <script type="module" src={asset("js/richtext-editor.js")} defer></script>
            </>
          )}
        </>
      ),
    };
  };
}
export const newCampaignView = view(true);
export const campaignView = view(false);
