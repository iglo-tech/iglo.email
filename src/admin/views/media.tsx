// Adapted from listmonk static/admin/views/media.html, media-fragment.html,
// partials/media-gallery.html, partials/media-gallery-item.html and cmd/media.go (ViewMedia,
// ViewMediaFragment) at 6fcd95f. Upstream renders the files into the page; here media.js reads
// them from /api/media, so a file name only reaches the page through x-text and x-bind.
import { Icon } from "@/admin/layout/icon";
import type { AdminRequest, AdminView } from "@/admin/page";
import { Alert, Breadcrumbs, EmptyState, HiddenFields } from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";

const mediaKeys = ["globals.messages.copied", "globals.messages.deleted", "globals.messages.done"];

function Item(props: { t: Translation; picker: boolean; canManage: boolean }) {
  const { t, picker, canManage } = props;
  const open = picker
    ? { "x-on:click.prevent": "onPick(m)" }
    : { target: "_blank", rel: "noopener noreferrer" };
  return (
    <figure class="card" data-testid="media-item" x-bind:data-id="m.id">
      <a class="thumb" x-bind:href="m.url" x-bind:title="m.filename" {...open}>
        <template x-if="rasterThumb(m)">
          <img x-bind:src="m.thumb_url" x-bind:alt="m.filename" loading="lazy" decoding="async" />
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
          popovertarget=""
          x-bind:popovertarget="'media-actions-' + m.id"
          type="button"
          class="ghost more icon"
          aria-label={t.T("globals.buttons.more")}
        >
          <Icon name="more-vertical" />
        </button>
        <menu popover="" x-bind:id="'media-actions-' + m.id">
          <button
            type="button"
            role="menuitem"
            class="ghost"
            data-testid="btn-copy-url"
            {...{ "x-on:click.prevent": "onCopy(m)" }}
          >
            <Icon name="copy" /> {t.T("globals.buttons.copy")}
          </button>
          {canManage ? (
            <button
              type="button"
              role="menuitem"
              class="ghost"
              data-variant="danger"
              data-testid="btn-delete"
              x-bind:disabled="isLoading('media')"
              {...{ "x-on:click.prevent": "onDelete(m.id, m.filename)" }}
            >
              <Icon name="trash-2" /> {t.T("globals.buttons.delete")}
            </button>
          ) : null}
        </menu>
      </ot-dropdown>
    </figure>
  );
}
function Upload({ t }: { t: Translation }) {
  return (
    <ot-dropdown>
      <button
        type="button"
        data-variant="primary"
        class="btn-new media-upload-btn"
        popovertarget="media-upload"
        data-testid="btn-upload-menu"
      >
        <Icon name="upload" /> {t.T("globals.buttons.upload")}
      </button>
      <div popover="" id="media-upload" class="media-upload" x-ref="uploadMenu">
        <form {...{ "x-on:submit.prevent": "onUpload" }}>
          <label data-field="">
            <input
              type="file"
              name="file"
              multiple
              x-ref="uploadInput"
              x-on:change="pickFiles($event)"
            />
            <small data-hint="">{t.T("media.uploadHelp")}</small>
          </label>
          <div class="hstack justify-end buttons">
            <button
              type="submit"
              data-variant="primary"
              data-spinner="small"
              data-testid="btn-upload"
              x-bind:disabled="files.length === 0 || isUploading"
              x-bind:aria-busy="isUploading"
            >
              <Icon name="upload" /> {t.T("globals.buttons.upload")}
            </button>
          </div>
        </form>
      </div>
    </ot-dropdown>
  );
}
/** partials/media-gallery.html, for the page and for the picker's iframe. */
function Gallery({ request, picker }: { request: AdminRequest; picker: boolean }) {
  const { context, can } = request;
  const t = context.app.i18n;
  const params = context.url.searchParams;
  const action = `/admin/campaigns/media${picker ? "/fragment" : ""}`;
  const canManage = can("media:manage");
  return (
    <section class="media-files" x-data={`mediaView('${picker ? "picker" : "manage"}')`}>
      <header class="row page-header">
        <div class="col-4">
          <h1 class="page-title">
            {t.T("globals.terms.media")}{" "}
            <span x-text="'(' + (page.total != null ? page.total : '-') + ')'"></span>
          </h1>
        </div>
        <div class="col-8 hstack justify-end buttons">
          <form method="get" action={action} class="search-form">
            <HiddenFields params={params} exclude={["query", "page"]} />
            <fieldset class="group">
              <input
                name="query"
                aria-label="Search"
                data-testid="query"
                placeholder="Search"
                value={params.get("query") ?? ""}
                autofocus
              />
              <button
                type="submit"
                class="outline external"
                data-testid="btn-query"
                aria-label="Search"
              >
                <Icon name="search" />
              </button>
            </fieldset>
          </form>
          {canManage ? <Upload t={t} /> : null}
        </div>
      </header>

      <Alert name="error" />
      <div class="card page-content" x-bind:aria-busy="loading">
        <ul class="unstyled gallery">
          <template x-for="m in media" x-bind:key="m.id">
            <li>
              <Item t={t} picker={picker} canManage={canManage} />
            </li>
          </template>
        </ul>
        <div x-show="!loading && !media.length" style="display: none">
          <EmptyState text={t.T("globals.messages.emptyState")} />
        </div>
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
    </section>
  );
}

export const mediaView: AdminView = (request) => {
  const { context, can } = request;
  const t = context.app.i18n;
  return {
    title: t.T("globals.terms.media"),
    pageId: "campaigns.media",
    script: "media",
    translationKeys: mediaKeys,
    body: (
      <>
        <Breadcrumbs
          parent={t.T("globals.terms.campaigns")}
          href={can("campaigns:get", "campaigns:get_all") ? "/admin/campaigns" : null}
          current={t.T("globals.terms.media")}
        />
        <Gallery request={request} picker={false} />
      </>
    ),
  };
};

/** The gallery alone, which the campaign form's picker frames. */
export const mediaFragmentView: AdminView = (request) => ({
  title: request.context.app.i18n.T("globals.terms.media"),
  pageId: "campaigns.media",
  script: "media",
  translationKeys: mediaKeys,
  bare: true,
  body: <Gallery request={request} picker={true} />,
});
