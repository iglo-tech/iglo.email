// Native (15-external-sources section 4, B155f, D181): the source stream's retry queue, read-only.
// The rows come from /api/settings/source/retries and reach the page only through x-text; the
// page reads again every 30 seconds, as the queue's loop works through it.
import Alpine from '@alpinejs/csp';
import { i18n } from '@/assets/admin/js/main.js';
import { read } from '@/assets/admin/js/listing.js';
import * as u from '@/assets/admin/js/utils.js';

const POLL_INTERVAL = 30000;

function component() {
  return {
    rows: [],
    stream: null,
    more: false,
    ready: false,
    error: '',
    pollID: null,

    init() {
      this.fetchRows();
      this.pollID = setInterval(() => this.fetchRows(), POLL_INTERVAL);
    },

    destroy() {
      clearInterval(this.pollID);
    },

    async fetchRows() {
      try {
        const data = await read('/settings/source/retries');
        this.rows = data.results || [];
        this.stream = data.stream;
        this.more = data.more;
        this.error = '';
      } catch (e) {
        this.error = e.message;
      } finally {
        this.ready = true;
      }
    },

    niceDate: u.niceDate,

    kindLabel(kind) {
      return i18n.t(`sources.retries.kind.${kind}`);
    },

    statusLabel(status) {
      return i18n.t(`sources.retries.status.${status}`);
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('sourceRetriesView', component);
}, { once: true });
