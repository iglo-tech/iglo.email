// Adapted from listmonk static/admin/assets/js/views/media.js at 6fcd95f. Upstream's page arrives
// with its files; here this module reads them from the API.
import Alpine from '@alpinejs/csp';
import {
  fileExt, pageLinks, pageQuery, rasterThumb, read,
} from '@/assets/admin/js/listing.js';
import {
  api, csrfToken, i18n, urls,
} from '@/assets/admin/js/main.js';
import * as u from '@/assets/admin/js/utils.js';

const pageKeys = ['page', 'query'];
const urlParams = new URLSearchParams(window.location.search);

function component(mode) {
  return {
    media: [],
    page: { total: null, per_page: 0 },
    pages: [],
    loading: true,
    error: '',
    files: [],
    pickFiles(event) {
      this.files = [...event.target.files];
    },
    isUploading: false,
    isPicker: mode === 'picker',

    init() {
      this.fetchPage();
    },

    async fetchPage() {
      try {
        const query = pageQuery(urlParams, pageKeys);
        if (!query.has('per_page')) {
          query.set('per_page', 100);
        }
        const data = await read(`/media?${query}`);
        this.media = data.results || [];
        this.page = data;
        this.pages = pageLinks(urlParams, data.page, data.per_page, data.total);
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
    },

    // ===============
    // Item text.
    fileExt,
    rasterThumb,
    niceDate: u.niceDate,

    // ===============
    // Event handlers.
    // Post the picked media to the parent window (picker runs inside an iframe).
    onPick(m) {
      const {
        id, filename, url, thumb_url: thumbURL, created_at: createdAt,
      } = m;
      window.parent.postMessage({
        type: 'media-select',
        media: {
          id, filename, url, thumb_url: thumbURL, created_at: createdAt,
        },
      }, window.location.origin);
    },

    // The URL resolved by the browser, with a quote percent-encoded too, so a name stays inside
    // whatever attribute the copied text is pasted into.
    onCopy(m) {
      const url = new URL(m.url, window.location.origin).href;
      u.copyToClipboard(url.replace(/'/g, '%27'));
      this.$el.closest('[popover]').hidePopover();
    },

    // One request at a time: the API admits eight uploads in progress across every client. A
    // refused file keeps the page, so its reason stays on the screen instead of going in a reload.
    async onUpload() {
      if (this.files.length === 0 || this.isUploading) {
        return;
      }

      this.isUploading = true;
      this.error = '';
      const failures = [];
      for (const file of this.files) {
        try {
          await this._upload(file);
        } catch (err) {
          failures.push(`${file.name}: ${err.message}`);
        }
      }
      this.isUploading = false;

      if (failures.length === 0) {
        u.reload({ message: i18n.t('globals.messages.done') });
        return;
      }

      this.files = [];
      this.$refs.uploadInput.value = '';
      this.$refs.uploadMenu.hidePopover();
      await this.fetchPage();
      this.error = failures.join(' ');
    },

    async onDelete(id, name) {
      if (!(await u.confirm())) {
        return;
      }

      await api('media', `/media/${id}`, 'DELETE');
      u.reload({ message: i18n.ts('globals.messages.deleted', { name }) });
    },

    // ===============
    // Private functions.
    async _upload(file) {
      const params = new FormData();
      params.set('file', file);

      const resp = await fetch(`${urls.api}/media`, {
        method: 'POST',
        body: params,
        headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      });
      if (!resp.ok) {
        const out = await resp.json().catch(() => ({}));
        throw new Error(out.message || resp.statusText);
      }
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('mediaView', (mode) => component(mode));
}, { once: true });
