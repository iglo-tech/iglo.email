// Adapted from listmonk static/admin/assets/js/views/bounces.js at 6fcd95f. Upstream's page arrives
// with its bounces; here this module reads them from the API.
import Alpine from 'alpinejs';
import {
  filterTitle, initials, pageLinks, pageQuery, read, viewTitle,
} from '@/assets/admin/js/listing.js';
import { api, i18n } from '@/assets/admin/js/main.js';
import * as u from '@/assets/admin/js/utils.js';

const pageKeys = ['page', 'order', 'order_by', 'source', 'type', 'campaign_id'];
const filterKeys = ['source', 'type', 'campaign_id'];
const urlParams = new URLSearchParams(window.location.search);

// The filters exactly as the page's own read sent them. A source is stored text and may hold
// spaces, so "all" trims nothing: a trimmed value would select another source's bounces.
function selectionFilters() {
  const out = {};
  filterKeys.forEach((key) => {
    if (urlParams.get(key)) {
      out[key] = urlParams.get(key);
    }
  });
  return out;
}

function component() {
  return {
    bounces: [],
    page: { total: null, per_page: 0 },
    pages: [],
    loading: true,
    error: '',
    selection: selectionFilters(),

    // JSON meta details of a given bounce item viewed in the dialog.
    meta: {},
    metaTitle: '',

    init() {
      this.fetchPage();
    },

    async fetchPage() {
      try {
        const data = await read(`/bounces?${pageQuery(urlParams, pageKeys)}`);
        this.bounces = data.results || [];
        this.page = data;
        this.pages = pageLinks(urlParams, data.page, data.per_page, data.total);
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
    },

    // ===============
    // Row text.
    initials,
    viewTitle,
    filterTitle,
    niceDate: u.niceDate,

    typeLabel(type) {
      return i18n.t(`bounces.${type}`);
    },

    statusLabel(status) {
      return i18n.t(`globals.terms.${status}`);
    },

    filterLink(key, value) {
      return `?${new URLSearchParams({ [key]: value })}`;
    },

    // ===============
    // Event handlers.
    onView(title, meta) {
      this.metaTitle = title;
      this.meta = meta || {};
      this.$refs.metaDialog.showModal();
    },

    async onDeleteBounce(id, email) {
      if (!(await u.confirm())) {
        return;
      }

      await api('bounces', `/bounces/${id}`, 'DELETE');
      u.reload({ message: i18n.ts('globals.messages.deleted', { name: email }) });
    },

    // ===============
    // Bulk actions.
    async onDeleteSelected(num, params) {
      if (num === 0 || !(await u.confirm(i18n.ts('globals.messages.confirmDelete', {
        num,
        name: i18n.tc('globals.terms.bounce', num).toLowerCase(),
      })))) {
        return;
      }

      await api('bounces', `/bounces?${params}`, 'DELETE');

      u.reload({
        message: i18n.ts('globals.messages.deletedCount', {
          num,
          name: i18n.tc('globals.terms.bounce', num),
        }),
      });
    },

    async onBlocklistSelected(allSelected, total, params) {
      const subIDs = [...new Set(Array.from(this.root.querySelectorAll('input[name="id"]:checked'))
        .map((el) => Number(el.dataset.subscriberId))
        .filter((id) => id > 0))];

      const num = allSelected ? total : subIDs.length;
      const message = i18n.ts('subscribers.confirmBlocklist', {
        num: allSelected ? i18n.t('globals.terms.all') : num,
      });
      if (num === 0 || !(await u.confirm(message))) {
        return;
      }

      await api('bounces', `/bounces/blocklist?${params}`, 'PUT');

      u.reload({ message: i18n.t('globals.messages.done') });
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('bouncesView', component);
}, { once: true });
