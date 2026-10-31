// Adapted from listmonk static/admin/views/forms.html and cmd/lists.go (ViewForms) at 6fcd95f.
// Upstream's page arrives with its lists; here forms.js reads them from /api/lists, which applies
// the user's list scope as ViewForms does. Trusted URLs are settings, not list data, and go
// through the JSX escaper. No captcha markup: the
// public form serves no challenge (07-api-and-ui.md).
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import { Alert, Breadcrumbs } from "@/admin/views/parts";
import { assetVersion } from "@/server/asset-manifest";

const formKeys = [
  "globals.buttons.subscribe",
  "globals.fields.email",
  "globals.messages.copied",
  "public.subName",
];

export const formsView: AdminView = ({ context, site }) => {
  const t = context.app.i18n;
  const publicPage = `${site.rootUrl}/subscription/form`;
  return {
    title: t.T("globals.terms.forms"),
    pageId: "lists.forms",
    script: "forms",
    translationKeys: formKeys,
    body: (
      <>
        <Breadcrumbs
          parent={t.T("globals.terms.lists")}
          href="/admin/lists"
          current={t.T("globals.terms.forms")}
        />
        <section class="forms" x-data="formsView">
          <header class="row page-header">
            <div class="col-4">
              <h1 class="page-title">{t.T("globals.terms.forms")}</h1>
            </div>
            <div class="col-8 hstack justify-end buttons">
              {site.publicSubscription ? (
                <a
                  href={publicPage}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="button small"
                  data-testid="url"
                  title={publicPage}
                >
                  <Icon name="arrow-up-right" /> {t.T("forms.publicSubPage")}
                </a>
              ) : null}
            </div>
          </header>

          <div class="page-content">
            <Alert name="error" />
            <p
              class="card text-light"
              data-testid="no-lists"
              x-show="ready && !lists.length"
              style="display: none"
            >
              {t.T("forms.noPublicLists")}
            </p>
            <div class="row" x-show="lists.length" style="display: none">
              <div class="col-4">
                <fieldset class="group mt-0">
                  <legend>{t.T("globals.terms.lists")}</legend>
                  <p class="text-light">{t.T("forms.selectHelp")}</p>
                  <ul class="no lists" data-testid="lists">
                    <template x-for="l in lists" x-bind:key="l.uuid">
                      <li>
                        <label>
                          <input type="checkbox" x-bind:value="l.uuid" x-model="checked" />{" "}
                          <span x-text="l.name"></span>
                        </label>
                      </li>
                    </template>
                  </ul>
                </fieldset>

                <fieldset class="group">
                  <legend>{t.T("globals.fields.redirectURL")}</legend>
                  <p class="text-light">{t.T("forms.redirectURLHelp")}</p>
                  {site.trustedUrls.length ? (
                    <ul class="no" data-testid="redirect-urls">
                      <li>
                        <label>
                          <input type="radio" name="redirect-url" value="" x-model="redirectURL" />{" "}
                          {t.T("globals.terms.none")}
                        </label>
                      </li>
                      {site.trustedUrls.map((url) => (
                        <li>
                          <label>
                            <input
                              type="radio"
                              name="redirect-url"
                              value={url}
                              x-model="redirectURL"
                            />{" "}
                            {url}
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </fieldset>
              </div>

              <div class="col-8">
                <article class="card float" data-testid="form" aria-label={t.T("forms.formHTML")}>
                  <h5 class="title">{t.T("forms.formHTML")}</h5>
                  <p class="text-light">{t.T("forms.formHTMLHelp")}</p>
                  <div x-show="checked.length > 0" style="display: none">
                    <div class="align-right mb-2">
                      <button
                        type="button"
                        class="small"
                        data-testid="btn-copy"
                        x-on:click="copyHTML"
                        title={t.T("globals.messages.clickToCopy")}
                      >
                        <Icon name="copy" /> {t.T("globals.buttons.copy")}
                      </button>
                    </div>
                    <code-editor lang="html" disabled x-effect="$el.value = html"></code-editor>
                  </div>
                </article>
              </div>
            </div>
          </div>
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
