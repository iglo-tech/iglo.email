// The instance Account page (B140, D153). Native: listmonk has no instance. It talks to
// /api/instance/** with the instance session's own CSRF cookie, `instance_csrf`, never the project's.
import Alpine from '@alpinejs/csp';
import { i18n } from '@/assets/admin/js/main.js';
import * as u from '@/assets/admin/js/utils.js';

function instanceCsrf() {
  const part = document.cookie.split('; ').find((c) => c.startsWith('instance_csrf='));
  return part ? part.slice('instance_csrf='.length) : '';
}

async function call(uri, method, data) {
  const resp = await fetch(`/api/instance${uri}`, {
    method,
    body: data ? JSON.stringify(data) : null,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
      'X-CSRF-Token': instanceCsrf(),
    },
  });
  const out = await resp.json().catch(() => ({}));
  if (resp.status === 401) {
    window.location.href = '/admin/instance/login';
    throw new Error(out.message || resp.statusText);
  }
  if (!resp.ok) {
    u.toast(out.message || resp.statusText, 'danger');
    throw new Error(out.message || resp.statusText);
  }
  return out.data;
}

function instanceAccount() {
  return {
    form: { current: '', password: '', password2: '' },
    totpQR: null,
    totpSecret: null,
    totpCode: '',
    disablePassword: '',

    async changePassword() {
      if (this.form.password !== this.form.password2) {
        u.toast(i18n.t('users.passwordMismatch'), 'danger');
        return;
      }
      await call('/account/password', 'PUT', {
        current: this.form.current,
        password: this.form.password,
      });
      this.form = { current: '', password: '', password2: '' };
      u.toast(i18n.t('globals.messages.done'));
    },

    async startTotp() {
      const data = await call('/account/totp', 'GET');
      this.totpQR = data.qr;
      this.totpSecret = data.secret;
    },

    async confirmTotp() {
      if (!/^[0-9]{6}$/.test(this.totpCode)) {
        u.toast(i18n.t('globals.messages.invalidValue'), 'danger');
        return;
      }
      await call('/account/twofa', 'PUT', { secret: this.totpSecret, code: this.totpCode });
      u.reload({ message: i18n.t('users.twoFAEnabled') });
    },

    async disableTotp() {
      await call('/account/twofa', 'DELETE', { password: this.disablePassword });
      u.reload({ message: i18n.t('globals.messages.done') });
    },

    async logout() {
      await call('/logout', 'POST');
      window.location.href = '/admin/instance/login';
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('instanceAccount', instanceAccount);
}, { once: true });
