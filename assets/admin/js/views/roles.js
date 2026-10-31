// Adapted from listmonk static/admin/assets/js/views/roles.js at 6fcd95f. Upstream's list page
// arrives with its rows; here this module reads them from the API.
import Alpine from 'alpinejs';
import {
  initials, pageQuery, read, viewTitle,
} from '@/assets/admin/js/listing.js';
import {
  api, config, i18n, urls,
} from '@/assets/admin/js/main.js';
import * as u from '@/assets/admin/js/utils.js';

const urlParams = new URLSearchParams(window.location.search);

// rolesView is the list page component (user or list roles).
function rolesView() {
  const type = config.roles_view;
  const path = type === 'list' ? '/roles/lists' : '/roles/users';

  return {
    roles: [],
    loading: true,
    error: '',

    async init() {
      try {
        this.roles = await read(`${path}?${pageQuery(urlParams, ['query', 'order_by', 'order'])}`);
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
    },

    initials,
    viewTitle,
    niceDate: u.niceDate,

    link(r) {
      return `${urls.admin}/users/roles${type === 'list' ? '/lists' : ''}/${r.id}`;
    },

    // Clone a role by creating a copy of the definition this page read.
    async onCloneRole(r) {
      const newName = window.prompt(i18n.t('globals.fields.name'), i18n.ts('globals.messages.copyOf', { name: r.name }));
      if (!newName) {
        return;
      }

      const payload = { name: newName };
      if (type === 'list') {
        payload.lists = (r.lists || []).map((l) => ({ id: l.id, permissions: l.permissions }));
      } else {
        payload.permissions = r.permissions;
      }

      await api('roles', path, 'POST', payload);
      u.reload({ message: i18n.ts('globals.messages.created', { name: newName }) });
    },

    async onDeleteRole(r) {
      if (!(await u.confirm(i18n.t('globals.messages.confirm')))) {
        return;
      }
      await api('roles', `/roles/${r.id}`, 'DELETE');
      u.reload({ message: i18n.ts('globals.messages.deleted', { name: r.name }) });
    },
  };
}

// roleForm is the add/edit form page component (user or list roles).
function roleForm() {
  const type = config.role_form;
  const role = config.role || {};
  const isNew = config.is_new;
  const path = type === 'list' ? '/roles/lists' : '/roles/users';
  const listRef = (l) => ({ id: l.id, name: l.name, permissions: [...(l.permissions || [])] });

  const makeForm = () => ({
    id: role.id ?? null,
    name: role.name || '',
    permissions: [...(isNew ? (config.default_permissions || []) : (role.permissions || []))],
    lists: (role.lists || []).map(listRef),
    curList: null,
  });

  return {
    // The primordial super admin role (id 1), the role you hold or lacking manage permission
    // disables the form.
    disabled: config.read_only,
    form: makeForm(),
    allLists: [],

    get isNew() {
      return isNew;
    },

    // Lists not yet added to the role.
    get filteredLists() {
      const chosen = new Set(this.form.lists.map((l) => l.id));
      return this.allLists.filter((l) => !chosen.has(l.id));
    },

    // The lists the viewer may read. A list on the role that they may not keeps its row.
    async init() {
      if (type !== 'list' || this.disabled) {
        return;
      }
      try {
        const data = await read('/lists?minimal=true&per_page=all');
        this.allLists = data.results || [];
        this._nextList();
      } catch (e) {
        u.toast(e.message, 'danger');
      }
    },

    _nextList() {
      this.form.curList = this.filteredLists.length > 0 ? this.filteredLists[0].id : null;
    },

    onAddListPerm() {
      const l = this.allLists.find((x) => x.id === this.form.curList);
      if (!l) {
        return;
      }
      this.form.lists.push(listRef({ ...l, permissions: ['list:get', 'list:manage'] }));
      this._nextList();
    },

    onDeleteListPerm(id) {
      this.form.lists = this.form.lists.filter((l) => l.id !== id);
      this._nextList();
    },

    onToggleSelect() {
      this.form.permissions = this.form.permissions.length > 0 ? [] : [...config.all_permissions];
    },

    onSubmit() {
      if (this.disabled) {
        return;
      }
      if (!this.isNew) {
        this.updateRole();
      } else {
        this.createRole();
      }
    },

    _payload() {
      const payload = { name: this.form.name };
      if (type === 'list') {
        payload.lists = this.form.lists.map((l) => ({ id: l.id, permissions: l.permissions }));
      } else {
        payload.permissions = this.form.permissions;
      }
      return payload;
    },

    _listURL() {
      return type === 'list' ? `${urls.admin}/users/roles/lists` : `${urls.admin}/users/roles`;
    },

    async createRole() {
      const data = await api('roles.save', path, 'POST', this._payload());
      u.redirect(this._listURL(), { message: i18n.ts('globals.messages.created', { name: data.name }) });
    },

    async updateRole() {
      const data = await api('roles.save', `${path}/${this.form.id}`, 'PUT', this._payload());
      u.reload({ message: i18n.ts('globals.messages.updated', { name: data.name }) });
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('rolesView', rolesView);
  Alpine.data('roleForm', roleForm);
}, { once: true });
