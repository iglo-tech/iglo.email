// Adapted from listmonk static/admin/assets/js/views/lists.js at 6fcd95f. Upstream's page arrives
// with its lists; here this module reads them from the API.
import Alpine from 'alpinejs';
import {
  filterTitle, iconHref, initials, pageLinks, pageQuery, read, statusIcon, urlFilters, viewTitle,
} from '@/assets/admin/js/listing.js';
import {
  api, urls, config, i18n,
} from '@/assets/admin/js/main.js';
import * as u from '@/assets/admin/js/utils.js';

const pageKeys = ['page', 'order', 'order_by', 'query', 'status', 'type', 'optin', 'tag'];
const urlParams = new URLSearchParams(window.location.search);
const manageable = new Set(config.manage_lists?.split(',').filter(Boolean).map(Number));

function component() {
  // Init a fresh form payload.
  const makeForm = () => ({
    id: null,
    uuid: '',
    name: '',
    type: 'private',
    optin: 'single',
    status: 'active',
    tags: [],
    description: '',
  });
  const makeFormFromList = (list) => ({
    ...makeForm(),
    ...list,
    tags: Array.isArray(list.tags) ? list.tags : [],
  });

  return {
    urlParams,
    form: makeForm(),
    lists: [],
    page: { total: null, per_page: 0 },
    pages: [],
    loading: true,
    error: '',
    ready: false,

    init() {
      if (config.list_id) {
        this.fetchList();
      } else if (!config.is_new) {
        this.fetchPage();
      }
    },

    // ===============
    // Reads.
    async fetchPage() {
      try {
        const data = await read(`/lists?${pageQuery(urlParams, pageKeys)}`);
        this.lists = data.results || [];
        this.page = data;
        this.pages = pageLinks(urlParams, data.page, data.per_page, data.total);
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
    },

    async fetchList() {
      try {
        this.form = makeFormFromList(await read(`/lists/${config.list_id}`));
        this.ready = true;
      } catch (e) {
        this.error = e.message;
      }
    },

    // ===============
    // Row text.
    initials,
    viewTitle,
    filterTitle,
    statusIcon,
    niceDate: u.niceDate,
    formatNumber: u.formatNumber,

    typeLabel(type) {
      return i18n.t(`globals.terms.${type}`);
    },

    typeIcon(type) {
      return iconHref(type === 'public' ? 'eye' : 'eye-off');
    },

    optinLabel(optin) {
      return i18n.t(`lists.optins.${optin}`);
    },

    optinIcon(optin) {
      return iconHref(optin === 'double' ? 'user-check' : 'user-x');
    },

    canManage(id) {
      return config.manage_lists === 'all' || manageable.has(id);
    },

    analyticsLink(l) {
      const from = new Date();
      from.setMonth(from.getMonth() - 3);
      return `/admin/lists/analytics?id=${l.id}&from=${from.toISOString().slice(0, 10)}`;
    },

    // The current page's filters plus one more tag, with the page itself dropped.
    tagLink(tag) {
      const query = new URLSearchParams(urlParams);
      query.delete('page');
      query.append('tag', tag);
      return `?${query}`;
    },

    urlFilters() {
      return urlFilters(urlParams, pageKeys, { status: 'active' });
    },

    metersLabel(l) {
      return `${i18n.t('globals.terms.subscribers')}: ${l.name} — ${i18n.t('globals.fields.status')}`;
    },

    // The bars and percentages of a list's subscriber column.
    stats(l) {
      const total = Math.max(l.subscriber_count, 1);
      const counts = l.subscriber_statuses || {};
      const names = l.optin === 'double' ? ['confirmed', 'unconfirmed', 'unsubscribed'] : ['unsubscribed'];
      return names.map((status) => {
        const count = counts[status] || 0;
        const percent = (count / total) * 100;
        const label = i18n.t(`globals.terms.${status}`);
        return {
          status, count, total, percent, label, title: `${label} ${u.formatNumber(count)} (${Math.round(percent)}%)`,
        };
      });
    },

    // ===============
    // Event handlers.
    async onSubmitNew() {
      const data = await api('lists.save', '/lists', 'POST', this._payload());
      u.redirect(`${urls.admin}/lists/${data.id}`, { message: i18n.ts('globals.messages.created', { name: data.name }) });
    },

    async onSubmitUpdate() {
      const data = await api('lists.save', `/lists/${this.form.id}`, 'PUT', this._payload());
      this.form = makeFormFromList(data);
      u.reload({ message: i18n.ts('globals.messages.updated', { name: data.name }) });
    },

    async onDeleteList(id, name) {
      if (!(await u.confirm(i18n.t('lists.confirmDelete')))) {
        return;
      }
      await api('lists', `/lists/${id}`, 'DELETE');
      u.reload({ message: i18n.ts('globals.messages.deleted', { name }) });
    },

    async onDeleteSelected(count, params) {
      if (count === 0 || !(await u.confirm(i18n.ts('globals.messages.confirmDelete', {
        num: count,
        name: i18n.tc('globals.terms.list', count).toLowerCase(),
      })))) {
        return;
      }

      await api('lists', `/lists?${params}`, 'DELETE');
      u.reload({
        message: i18n.ts('globals.messages.deletedCount', {
          num: count,
          name: i18n.tc('globals.terms.list', count),
        }),
      });
    },

    async onCreateOptinCampaign(id, name) {
      if (!(await u.confirm())) {
        return;
      }

      const data = await api('lists', '/campaigns', 'POST', {
        name: i18n.ts('lists.optinTo', { name }),
        subject: i18n.ts('lists.confirmSub', { name }),
        lists: [id],
        from_email: '',
        content_type: 'richtext',
        messenger: 'email',
        type: 'optin',
      });
      window.location.href = `/admin/campaigns/${data.id}#tab=content`;
    },

    // ===============
    // Public functions.
    get isArchived() {
      return this.form.status === 'archived';
    },

    set isArchived(value) {
      this.form.status = value ? 'archived' : 'active';
    },

    // ===============
    // Private functions.
    _payload() {
      return {
        name: this.form.name,
        type: this.form.type,
        optin: this.form.optin,
        status: this.form.status,
        tags: this.form.tags,
        description: this.form.description || '',
      };
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('listsView', component);
}, { once: true });
