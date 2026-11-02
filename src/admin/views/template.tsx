// Adapted from listmonk static/admin/views/template.html at 6fcd95f. The template arrives from
// /api/templates/:id. Visual templates are deferred (D54), so the type offers the other two.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import { templateKeys } from "@/admin/views/templates";
import { Alert, AvatarLink, Breadcrumbs, PreviewDialog } from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";
import { assetVersion } from "@/server/asset-manifest";
import { getID } from "@/server/validation";

function Form({ t, isNew, canManage }: { t: Translation; isNew: boolean; canManage: boolean }) {
  return (
    <form {...{ "x-on:submit.prevent": "onSubmit" }}>
      <div class="page-content content">
        <fieldset class="card">
          <legend>{t.Tc("globals.terms.template", 1)}</legend>
          <div class="row">
            <div class="col-9">
              <label data-field="">
                {t.T("globals.fields.name")}
                <input
                  name="name"
                  maxlength="200"
                  autofocus
                  required
                  x-model="form.name"
                  placeholder={t.T("globals.fields.name")}
                />
              </label>
            </div>
            <div class="col-3">
              <label data-field="">
                {t.T("globals.fields.type")}
                <select name="type" x-model="form.type" {...(isNew ? {} : { disabled: true })}>
                  <option value="campaign">{t.Tc("templates.typeCampaignHTML", 1)}</option>
                  <option value="tx">{t.Tc("templates.typeTransactional", 1)}</option>
                </select>
              </label>
            </div>
          </div>
          <template x-if="form.type === 'tx'">
            <label data-field="">
              {t.T("globals.fields.subject")}
              <input
                name="subject"
                maxlength="200"
                x-model="form.subject"
                placeholder={t.T("globals.fields.subject")}
              />
            </label>
          </template>
        </fieldset>

        <fieldset class="card">
          <legend>{t.T("globals.fields.content")}</legend>
          <div class="editor-body">
            <template x-if="ready">
              <code-editor
                lang="html"
                x-init="setValue($el, form.body)"
                x-on:input="form.body = $event.target.value"
              ></code-editor>
            </template>
          </div>
          <p class="text-light mt-2">
            <template x-if="form.type === 'campaign'">
              <span>{t.Ts("templates.placeholderHelp", "placeholder", "{{ content | raw }}")}</span>
            </template>{" "}
            <a
              href="https://listmonk.app/docs/templating"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="link-2" /> {t.T("globals.buttons.learnMore")}
            </a>
          </p>
        </fieldset>
        <footer class="hstack justify-between mt-6">
          <div class="hstack gap-1">
            {isNew ? null : (
              <button
                type="button"
                class="small"
                data-variant="secondary"
                title={t.T("globals.messages.clickToCopy")}
                aria-label={t.T("globals.fields.id")}
                x-on:click="copyToClipboard(form.id)"
              >
                <strong>{t.T("globals.fields.id")}</strong> <span x-text="form.id"></span>
              </button>
            )}
          </div>
          <div class="hstack gap-3 justify-end">
            {canManage ? (
              <button
                type="submit"
                data-variant="primary"
                data-testid="btn-save"
                x-bind:disabled="isLoading('templates')"
                x-bind:aria-busy="isLoading('templates')"
              >
                <Icon name="save" /> {t.T("globals.buttons.save")}
              </button>
            ) : null}
          </div>
        </footer>
      </div>
    </form>
  );
}

function templateView(isNew: boolean): AdminView {
  return ({ context, can }) => {
    const t = context.app.i18n;
    const list = t.T("globals.terms.templates");
    const heading = t.T("templates.newTemplate");
    const keys = {
      "x-on:keydown.ctrl.s.window.prevent": "onSaveShortcut",
      "x-on:keydown.meta.s.window.prevent": "onSaveShortcut",
      "x-on:keydown.window.prevent.f9": "onPreviewBody",
    };
    return {
      title: `${isNew ? `${heading} / ` : ""}${list}`,
      pageId: "campaigns.templates",
      script: "templates",
      translationKeys: templateKeys,
      config: isNew ? { is_new: true } : { template_id: String(getID(context)) },
      body: (
        <>
          <section class="templates" x-data="templateForm" {...keys}>
            <Breadcrumbs
              root={{
                label: t.T("globals.terms.campaigns"),
                href: can("campaigns:get", "campaigns:get_all") ? "/admin/campaigns" : null,
              }}
              parent={list}
              href="/admin/templates"
              current={isNew ? heading : <span x-text="form.name"></span>}
            />
            <header class="row page-header">
              <div class="col-6">
                <div class="hstack gap-1">
                  <div class="avatar avatar-title">
                    {isNew ? (
                      <h1 class="page-title avatar-label">{heading}</h1>
                    ) : (
                      <>
                        <AvatarLink
                          kind="campaign-template"
                          name="saved.name"
                          href="'/admin/templates/' + form.id"
                          title="viewTitle(saved.name)"
                        />
                        <h1 class="page-title avatar-label" x-text="saved.name"></h1>
                      </>
                    )}
                  </div>
                  <template x-if="saved.is_default">
                    <span class="badge enum">{t.T("globals.terms.default")}</span>
                  </template>
                </div>
              </div>
              <div class="col-6 hstack justify-end buttons" x-show="ready" style="display: none">
                <button
                  type="button"
                  class="outline external"
                  data-testid="btn-preview"
                  x-on:click="onPreviewBody"
                  aria-keyshortcuts="F9"
                >
                  <Icon name="eye" /> {t.T("globals.buttons.preview")}
                </button>
              </div>
            </header>
            <Alert name="error" />
            <div x-show="ready" style="display: none">
              <Form t={t} isNew={isNew} canManage={can("templates:manage")} />
            </div>
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
export const newTemplateView = templateView(true);
export const editTemplateView = templateView(false);
