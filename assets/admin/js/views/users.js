// Adapted from listmonk static/admin/assets/js/views/users.js at 6fcd95f. Upstream's list page
// arrives with its rows; here this module reads them from the API and applies the URL's filters.
import Alpine from '@alpinejs/csp';
import { filterTitle, initials, pageQuery, read, viewTitle } from '@/assets/admin/js/listing.js';
import {
  api, config, i18n, urls,
} from '@/assets/admin/js/main.js';
import * as u from '@/assets/admin/js/utils.js';

const urlParams = new URLSearchParams(window.location.search);

// usersView is the users list page component.
function usersView() {
  const wanted = (r) => {
    const type = urlParams.get('type');
    const status = urlParams.get('status');
    const userRole = urlParams.get('user_role_id');
    const listRole = urlParams.get('list_role_id');
    return (!type || r.type === type)
      && (!status || r.status === status)
      && (!userRole || String(r.user_role.id) === userRole)
      && (!listRole || String(r.list_role?.id) === listRole);
  };

  return {
    users: [],
    loading: true,
    error: '',
    apiLabel: i18n.t('users.type.api'),
    disabledLabel: i18n.t('globals.terms.disabled'),

    async init() {
      try {
        const rows = await read(`/users?${pageQuery(urlParams, ['order_by', 'order'])}`);
        this.users = rows.filter(wanted);
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
    },

    initials,
    viewTitle,
    filterTitle,
    niceDate: u.niceDate,

    // ===============
    // Table actions.
    async onDeleteUser(id, name) {
      if (!(await u.confirm(i18n.t('globals.messages.confirm')))) {
        return;
      }

      await api('users', `/users/${id}`, 'DELETE');
      u.reload({ message: i18n.ts('globals.messages.deleted', { name }) });
    },

    async onDeleteSelected(count, params) {
      if (count === 0 || !(await u.confirm(i18n.ts('globals.messages.confirmDelete', {
        num: count,
        name: i18n.tc('globals.terms.user', count).toLowerCase(),
      })))) {
        return;
      }

      await api('users', `/users?${params}`, 'DELETE');
      u.reload({
        message: i18n.ts('globals.messages.deletedCount', {
          num: count,
          name: i18n.tc('globals.terms.user', count),
        }),
      });
    },
  };
}

// userForm is the add/edit form page component.
function userForm() {
  const isNew = config.is_new;
  const canSave = config.can_save;

  // Init a fresh form payload.
  const makeForm = () => ({
    id: null,
    username: '',
    name: '',
    email: '',
    password: '',
    password2: '',
    password_login: false,
    type: 'user',
    status: 'enabled',
    user_role_id: config.default_role,
    list_role_id: '',
  });

  const fromUser = (us) => ({
    ...makeForm(),
    ...us,
    email: us.email || '',
    password: '',
    password2: '',
    user_role_id: us.user_role.id,
    list_role_id: us.list_role ? String(us.list_role.id) : '',
  });

  return {
    form: makeForm(),
    ready: isNew,
    error: '',
    apiToken: null,
    createdName: '',

    get isNew() {
      return isNew;
    },

    async init() {
      if (isNew) {
        return;
      }
      try {
        this.form = fromUser(await read(`/users/${config.user_id}`));
        this.ready = true;
      } catch (e) {
        this.error = e.message;
      }
    },

    onSubmit() {
      if (!canSave || !this._validate()) {
        return;
      }
      if (!isNew) {
        this.updateUser();
      } else {
        this.createUser();
      }
    },

    // Redirect to the users list once the one-time API token dialog is dismissed.
    onTokenDialogClose() {
      this.apiToken = null;
      u.redirect(`${urls.admin}/users`, { message: i18n.ts('globals.messages.created', { name: this.createdName }) });
    },

    async createUser() {
      const data = await api('users.save', '/users', 'POST', this._payload());

      // For API users, show the one-time token in a dialog before redirecting.
      if (data.type === 'api') {
        this.apiToken = data.password;
        this.createdName = data.name;
        this.$refs.tokenDialog.showModal();
        return;
      }

      u.redirect(`${urls.admin}/users`, { message: i18n.ts('globals.messages.created', { name: data.name }) });
    },

    async updateUser() {
      const data = await api('users.save', `/users/${this.form.id}`, 'PUT', this._payload());
      u.reload({ message: i18n.ts('globals.messages.updated', { name: data.name }) });
    },

    // ===============
    // Private functions.
    _validate() {
      const f = this.form;
      const withPassword = f.type !== 'api' && f.password_login;
      if (withPassword && f.password && f.password !== f.password2) {
        u.toast(i18n.t('users.passwordMismatch'), 'danger');
        return false;
      }

      return true;
    },

    _payload() {
      const f = this.form;
      const out = {
        username: f.username,
        name: f.name,
        email: f.email,
        type: f.type,
        status: f.status,
        password_login: f.type !== 'api' ? f.password_login : false,
        password: (f.type !== 'api' && f.password_login && f.password) ? f.password : null,
        user_role_id: Number(f.user_role_id),
        list_role_id: f.list_role_id ? Number(f.list_role_id) : null,
      };
      // Your own roles are not on offer here. The API reads 0 as "keep what is stored", so a role
      // changed by someone else since this page loaded is not put back either.
      if (config.self) {
        out.user_role_id = 0;
        out.list_role_id = 0;
      }
      return out;
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('usersView', usersView);
  Alpine.data('userForm', userForm);
}, { once: true });
