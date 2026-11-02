// Adapted from listmonk static/admin/assets/js/views/subscribers.js at 6fcd95f. Upstream's page
// arrives with its subscribers and lists; here this module reads them from the API.
import Alpine from '@alpinejs/csp';
import {
  filterTitle, iconHref, initials, pageLinks, pageQuery, read, statusIcon, urlFilters, viewTitle,
} from '@/assets/admin/js/listing.js';
import {
  api, urls, config, i18n, ListTag,
} from '@/assets/admin/js/main.js';
import * as u from '@/assets/admin/js/utils.js';

const pageKeys = [
  'page', 'order', 'order_by', 'search', 'query', 'status', 'subscription_status', 'list_id',
];

// The tabs that read one page of the subscriber's records.
const activityPaths = {
  events: 'subscriber-events',
  enrollments: 'enrollments',
  sends: 'sends',
};

function component() {
  const params = new URLSearchParams(window.location.search);
  const listIDs = config.list_id ? [Number(config.list_id)] : params.getAll('list_id').filter(Boolean).map(Number);

  // The current view's filters.
  const filters = {
    listIDs,
    search: params.get('search') || '',
    query: params.get('query') || '',
    subStatus: params.get('subscription_status') || '',
    status: params.get('status') || '',
  };

  // Init a fresh form payload.
  const makeForm = () => ({
    id: null,
    uuid: '',
    email: '',
    name: '',
    status: 'enabled',
    lists: [],
    preconfirm: false,
    strAttribs: '{}',
  });
  const makeFormFromSub = (s) => ({
    ...makeForm(),
    ...s,
    lists: (Array.isArray(s.lists) ? s.lists : []).map((l) => new ListTag(l)),
    strAttribs: JSON.stringify(s.attribs || {}, null, 4),
  });

  return {
    subscriberFilters: filters,
    query: filters.query,
    isSqlOpen: false,
    onSqlToggle(event) {
      this.isSqlOpen = event.newState === 'open';
      if (this.isSqlOpen) {
        this.$nextTick(() => this.$refs.queryInput.focus());
      }
    },
    listNames: (lists) => lists.map((list) => list.name).join(', '),
    get advanced() {
      return this.query.trim() !== '';
    },

    subscribers: [],
    page: { total: null, per_page: 0 },
    pages: [],
    loading: true,
    error: '',
    ready: false,
    activity: [],
    activityPages: [],
    currentList: null,
    bounces: [],

    form: makeForm(),
    subscriptions: [],

    // Manage-lists box state (subscriber edit page).
    manage: {
      action: 'add', lists: [], preconfirm: false,
    },

    // Bulk manage-lists dialog state.
    bulk: {
      action: 'add', lists: [], preconfirm: false, allSelected: false, selected: [],
    },

    init() {
      this.fetchLists();
      if (config.subscriber_id) {
        this.fetchSubscriber();
      } else if (!config.is_new) {
        this.fetchPage();
      }
    },

    // ===============
    // Reads. The list selector takes names and opt-ins, not counts, so it asks for the minimal
    // listing: the full one holds the server for its counts at large sizes.
    async fetchLists() {
      const lists = async (query) => {
        const data = await read(`/lists?minimal=true&per_page=all${query}`);
        return (Array.isArray(data) ? data : data.results) || [];
      };
      try {
        window._lists = await lists('');
        if (config.list_id) {
          const id = Number(config.list_id);
          let list = window._lists.find((l) => l.id === id);
          if (!list) {
            list = (await lists('&status=archived')).find((l) => l.id === id);
          }
          this.currentList = list ? { name: list.name, archived: list.status === 'archived' } : null;
        }
      } catch (e) {
        this.error = e.message;
      }
    },

    async fetchPage() {
      const query = pageQuery(params, pageKeys);
      if (config.list_id) {
        query.set('list_id', config.list_id);
      }
      try {
        const data = await read(`/subscribers?${query}`);
        this.subscribers = data.results || [];
        this.page = data;
        this.pages = pageLinks(params, data.page, data.per_page, data.total);
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
    },

    async fetchSubscriber() {
      try {
        const sub = await read(`/subscribers/${config.subscriber_id}`);
        this.form = makeFormFromSub(sub);
        this.subscriptions = Array.isArray(sub.lists) ? sub.lists : [];
        if (config.tab === 'bounces') {
          this.bounces = (await read(`/subscribers/${config.subscriber_id}/bounces`)) || [];
        }
        const activityPath = activityPaths[config.tab];
        if (activityPath) {
          const query = new URLSearchParams();
          if (params.get('page')) {
            query.set('page', params.get('page'));
          }
          const data = await read(`/subscribers/${config.subscriber_id}/${activityPath}?${query}`);
          this.activity = data.results || [];
          this.activityPages = pageLinks(params, data.page, data.per_page, data.total);
        }
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

    statusLabel(status) {
      return i18n.t(`globals.terms.${status}`);
    },

    optinLabel(optin) {
      return i18n.t(`lists.optins.${optin}`);
    },

    optinIcon(optin) {
      return iconHref(optin === 'double' ? 'user-check' : 'user-x');
    },

    listTitle(l) {
      return `${i18n.t('globals.buttons.view')} ${l.name}: ${this.statusLabel(l.subscription_status)}`;
    },

    moreLists(s) {
      return `+${s.lists.length - 3} ${i18n.t('globals.terms.lists').toLowerCase()}`;
    },

    statusFilter(s) {
      const base = config.list_id ? `/admin/subscribers/lists/${config.list_id}` : '/admin/subscribers';
      return `${base}?status=${s.status}`;
    },

    urlFilters() {
      return urlFilters(params, pageKeys);
    },

    // ===============
    // New / edit form.
    async onSubmitNew() {
      const payload = this._payload();
      if (!payload) {
        return;
      }
      const data = await api('subscribers.save', '/subscribers', 'POST', payload);
      u.redirect(`${urls.admin}/subscribers`, { message: i18n.ts('globals.messages.created', { name: data.email }) });
    },

    async onSubmitUpdate() {
      // PATCH the profile. Subscriptions (lists) are managed separately via the manage-lists dialog.
      const attribs = this._validateAttribs(this.form.strAttribs);
      if (attribs === null) {
        return;
      }
      const data = await api('subscribers.save', `/subscribers/${this.form.id}`, 'PATCH', {
        email: this.form.email,
        name: this.form.name,
        status: this.form.status,
        attribs,
      });

      u.reload({ message: i18n.ts('globals.messages.updated', { name: data.email }) });
    },

    onOpenManage() {
      this.manage = { action: 'add', lists: [], preconfirm: false };
      this.$refs.manageDialog.showModal();
    },

    // Apply the manage-lists action (add / remove / unsubscribe) to the subscriber for
    // the picked lists.
    async onManageLists() {
      const lists = this.manage.lists.map((l) => l.id);
      if (lists.length === 0) {
        return;
      }

      const data = {
        ids: [this.form.id],
        action: this.manage.action,
        target_list_ids: lists,
      };
      if (this.manage.preconfirm) {
        data.status = 'confirmed';
      }

      await api('subscribers', '/subscribers/lists', 'PUT', data);
      u.reload({ message: i18n.t('subscribers.listChangeApplied') });
    },

    async onDeleteSubscriber(id, email) {
      if (!(await u.confirm(i18n.ts('subscribers.confirmDelete', { num: 1 })))) {
        return;
      }

      await api('subscribers', `/subscribers/${id}`, 'DELETE');
      u.reload({ message: i18n.ts('globals.messages.deleted', { name: email }) });
    },

    async onSendOptin() {
      if (!this.hasOptinSub) {
        return;
      }
      if (!(await u.confirm())) {
        return;
      }

      await api('subscribers', `/subscribers/${this.form.id}/optin`, 'POST');
      u.toast(i18n.t('subscribers.sentOptinConfirm'), 'success');
    },

    // ===============
    // Per-subscription actions in the Subscriptions tab.
    async _manageSub(action, listID, status) {
      if (!(await u.confirm())) {
        return;
      }

      await api('subscribers', '/subscribers/lists', 'PUT', {
        ids: [this.form.id],
        action,
        target_list_ids: [listID],
        status: status || '',
      });

      u.reload({ message: i18n.t('subscribers.listChangeApplied') });
    },

    onConfirmSub(id) {
      return this._manageSub('add', id, 'confirmed');
    },

    onResubscribe(id) {
      return this._manageSub('add', id, 'unconfirmed');
    },

    onUnsubscribe(id) {
      return this._manageSub('unsubscribe', id);
    },

    onDeleteSub(id) {
      return this._manageSub('remove', id);
    },

    // ===============
    // List selector helpers.
    get hasOptinList() {
      return this.form.lists.some((l) => l.optin === 'double');
    },

    get manageHasOptinList() {
      return this.manage.lists.some((l) => l.optin === 'double');
    },

    get hasOptinSub() {
      return this.subscriptions.some((l) => l.optin === 'double');
    },

    get bulkHasOptinList() {
      return this.bulk.lists.some((l) => l.optin === 'double');
    },

    // ===============
    // Bulk actions.
    onExport(allSelected, selected, total) {
      const num = (!allSelected && selected.length > 0) ? selected.length : total;
      u.confirm(i18n.ts('subscribers.confirmExport', { num })).then((ok) => {
        if (!ok) {
          return;
        }

        const q = new URLSearchParams();
        if (this.subscriberFilters.search) {
          q.append('search', this.subscriberFilters.search);
        }
        if (this.subscriberFilters.query) {
          q.append('query', this.subscriberFilters.query);
        }
        this.subscriberFilters.listIDs.forEach((id) => q.append('list_id', id));
        if (this.subscriberFilters.status) {
          q.append('status', this.subscriberFilters.status);
        }
        if (this.subscriberFilters.subStatus) {
          q.append('subscription_status', this.subscriberFilters.subStatus);
        }
        if (!allSelected && selected.length > 0) {
          selected.forEach((id) => q.append('id', id));
        }

        window.location.href = `${urls.api}/subscribers/export?${q.toString()}`;
      });
    },

    async onDeleteSelected(allSelected, selected, total) {
      const num = allSelected ? total : selected.length;
      if (!(await u.confirm(i18n.ts('subscribers.confirmDelete', { num })))) {
        return;
      }

      if (!allSelected) {
        const q = new URLSearchParams();
        selected.forEach((id) => q.append('id', id));
        await api('subscribers', `/subscribers?${q.toString()}`, 'DELETE');
      } else {
        await api('subscribers', '/subscribers/query/delete', 'POST', this._queryBody());
      }

      u.reload({ message: i18n.ts('subscribers.subscribersDeleted', { num }) });
    },

    async onBlocklistSelected(allSelected, selected, total) {
      const num = allSelected ? total : selected.length;
      if (!(await u.confirm(i18n.ts('subscribers.confirmBlocklist', { num })))) {
        return;
      }

      if (!allSelected) {
        await api('subscribers', '/subscribers/blocklist', 'PUT', { ids: selected.map(Number) });
      } else {
        await api('subscribers', '/subscribers/query/blocklist', 'PUT', this._queryBody());
      }

      u.reload();
    },

    onOpenManageLists(allSelected, selected) {
      this.bulk = {
        action: 'add',
        lists: [],
        preconfirm: false,
        allSelected,
        selected: selected.map(Number),
      };
      this.$refs.listDialog.showModal();
    },

    async onSubmitManageLists() {
      const lists = this.bulk.lists.map((l) => l.id);
      if (lists.length === 0) {
        return;
      }

      const data = { action: this.bulk.action, target_list_ids: lists };
      if (this.bulk.preconfirm) {
        data.status = 'confirmed';
      }

      if (!this.bulk.allSelected) {
        data.ids = this.bulk.selected;
        await api('subscribers', '/subscribers/lists', 'PUT', data);
      } else {
        Object.assign(data, this._queryBody());
        await api('subscribers', '/subscribers/query/lists', 'PUT', data);
      }

      this.$refs.listDialog.close();
      u.reload({ message: i18n.t('subscribers.listChangeApplied') });
    },

    // ===============
    // Bounces tab.
    async onDeleteBounces() {
      if (!(await u.confirm())) {
        return;
      }
      await api('subscribers', `/subscribers/${this.form.id}/bounces`, 'DELETE');
      u.reload({ message: i18n.t('globals.messages.done') });
    },

    // ===============
    // Private functions.
    // Body for the "by query" bulk endpoints.
    _queryBody() {
      const search = this.subscriberFilters.search || '';
      const query = this.subscriberFilters.query || '';
      return {
        all: query.trim() === '' && search.trim() === '',
        search,
        query,
        list_ids: this.subscriberFilters.listIDs,
        subscription_status: this.subscriberFilters.subStatus || null,
        subscriber_status: this.subscriberFilters.status || '',
      };
    },

    _payload() {
      const attribs = this._validateAttribs(this.form.strAttribs);
      if (attribs === null) {
        return null;
      }

      return {
        email: this.form.email,
        name: this.form.name,
        status: this.form.status,
        attribs,
        preconfirm_subscriptions: this.form.preconfirm,
        lists: this.form.lists.map((l) => l.id),
      };
    },

    _validateAttribs(str) {
      if (!str || !str.trim()) {
        return {};
      }
      try {
        const a = JSON.parse(str);
        if (Array.isArray(a)) {
          u.toast(i18n.t('subscribers.invalidJSON'), 'danger');
          return null;
        }
        return a;
      } catch (e) {
        u.toast(`${i18n.t('subscribers.invalidJSON')}: ${e.toString()}`, 'danger');
        return null;
      }
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('subscribersView', component);
}, { once: true });
