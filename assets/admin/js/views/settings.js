// Adapted from listmonk static/admin/assets/js/views/settings.js at 6fcd95f. The settings come from
// the API, and a save is that same object with the shown fields edited: PUT /api/settings replaces
// everything, so a key the form does not show is sent back as it was read. A masked secret goes
// back empty, which the API reads as "keep the stored value". After a save the form is read again,
// so a secret just typed is masked and a new server has its UUID. A save takes effect at once; only
// the root URL, a read-only flag, needs a restart. B139 (D154): the same page serves a project's keys
// from /api/settings and, on the instance host, the instance keys from /api/instance/settings; a key
// the side does not have is not in its object, so every step below skips what is absent.
import Alpine from '@alpinejs/csp';
import { read } from '@/assets/admin/js/listing.js';
import {
  api, config, csrfToken, i18n, urls,
} from '@/assets/admin/js/main.js';
import * as u from '@/assets/admin/js/utils.js';

// Quick-fill templates for known SMTP providers.
const smtpTemplates = {
  gmail: { host: 'smtp.gmail.com', port: 465, auth_protocol: 'login', tls_type: 'TLS' },
  gmailrelay: { host: 'smtp-relay.gmail.com', port: 465, auth_protocol: 'login', tls_type: 'TLS', hello_hostname: true },
  ses: { host: 'email-smtp.YOUR-REGION.amazonaws.com', port: 465, auth_protocol: 'login', tls_type: 'TLS' },
  azure: { host: 'smtp.azurecomm.net', port: 587, auth_protocol: 'login', tls_type: 'STARTTLS' },
  mailjet: { host: 'in-v3.mailjet.com', port: 465, auth_protocol: 'cram', tls_type: 'TLS' },
  mailgun: { host: 'smtp.mailgun.org', port: 465, auth_protocol: 'login', tls_type: 'TLS' },
  sendgrid: { host: 'smtp.sendgrid.net', port: 465, auth_protocol: 'login', tls_type: 'TLS' },
  forwardemail: { host: 'smtp.forwardemail.net', port: 465, auth_protocol: 'login', tls_type: 'TLS' },
  postmark: { host: 'smtp.postmarkapp.com', port: 587, auth_protocol: 'cram', tls_type: 'STARTTLS' },
  lettermint: { host: 'smtp.lettermint.co', port: 465, auth_protocol: 'login', tls_type: 'TLS' },
};

// Settings edited as one entry per line.
const lineKeys = [
  'app.from_email', 'privacy.domain_blocklist', 'privacy.domain_allowlist',
  'security.trusted_urls', 'security.trusted_proxies', 'bounce.ses_topic_arns',
];

function isDummy(pwd) {
  return !pwd || (pwd.match(/•/g) || []).length === pwd.length;
}

function hasDummy(pwd) {
  return (pwd || '').includes('•');
}

// Persist the open/closed state of SMTP accordions.
const OPEN_KEY = 'settings.openBoxes';
function loadOpen() {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY)) || {};
  } catch (e) {
    return {};
  }
}

// Where this side's settings are served.
const base = config.settings_side === 'instance' ? '/instance/settings' : '/settings';

function component() {
  const openState = loadOpen();

  // Normalize the raw settings into a display-friendly form (mirrors the old getSettings()).
  const normalize = (data) => {
    const d = JSON.parse(JSON.stringify(data));

    // Serialize the email_headers map to a display string, and remember what an untouched
    // server sends back: a null stays null.
    (d.smtp || []).forEach((s, i) => {
      s.strEmailHeaders = JSON.stringify(s.email_headers || [], null, 4);
      s.savedHeaders = s.strEmailHeaders;
      s.showHeaders = false;
      s.open = !!openState.smtp?.[i];
      s.noFromAddresses = !s.from_addresses;
      s.from_addresses ||= [];
    });

    lineKeys.filter((key) => key in d).forEach((key) => {
      d[key] = (d[key] || []).join('\n');
    });

    // B147 (D160): a preference field's allowed values are edited one per line.
    (d['privacy.preference_fields'] || []).forEach((f) => {
      f.strOptions = (f.options || []).join('\n');
    });

    if ('app.notify_emails' in d) {
      d['app.notify_emails'] = (d['app.notify_emails'] || []).join(', ');
    }

    return d;
  };

  const lines = (value) => value.split('\n').map((v) => v.trim()).filter((v) => v !== '');

  // B117f (D136 item 1): the administrator field holds one address per comma. A comma inside a quoted display
  // name, a comment or an angle address belongs to that address, so only a top-level comma separates two.
  const addressList = (value) => {
    const entries = [];
    let entry = '';
    let quoted = false;
    let depth = 0;
    for (let i = 0; i < value.length; i += 1) {
      const c = value[i];
      if (quoted && c === '\\') {
        entry += c + (value[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (c === '"') {
        quoted = !quoted;
      } else if (!quoted) {
        if (c === '<' || c === '(') {
          depth += 1;
        } else if ((c === '>' || c === ')') && depth > 0) {
          depth -= 1;
        } else if (c === ',' && depth === 0) {
          entries.push(entry);
          entry = '';
          continue;
        }
      }
      entry += c;
    }
    entries.push(entry);
    return entries.map((v) => v.trim()).filter((v) => v !== '');
  };

  // Keep search index+DOM references outside of Alpine.
  let searchIndex = [];
  let tabButtons = [];
  let tabPanels = [];

  return {
    clearDefaultExclusion(item) {
      if (!item.name) {
        item.exclude_from_default = false;
      }
    },

    form: null,
    error: '',

    // One provider at a time, as upstream's provider radio; the API takes ALTCHA if both are on.
    get captchaEnabled() {
      return this.form['security.captcha'].altcha.enabled || this.form['security.captcha'].hcaptcha.enabled;
    },
    set captchaEnabled(v) {
      this.form['security.captcha'].altcha.enabled = !!v;
      this.form['security.captcha'].hcaptcha.enabled = false;
    },

    get captchaProvider() {
      return this.form['security.captcha'].hcaptcha.enabled ? 'hcaptcha' : 'altcha';
    },
    set captchaProvider(v) {
      this.form['security.captcha'].hcaptcha.enabled = v === 'hcaptcha';
      this.form['security.captcha'].altcha.enabled = v === 'altcha';
    },

    smtpTestItem: null,
    testEmail: '',
    errMsg: '',
    // "Check SES account" (B145a): the saved credentials' GetAccount values, or the AWS error.
    sesCheck: null,

    // The check's values as lines; the AWS error is shown on its own.
    get sesCheckLines() {
      const a = this.sesCheck?.account;
      if (!a) {
        return [];
      }
      const n = (v) => Number(v).toLocaleString();
      const lines = [
        `Max send rate: ${n(a.max_send_rate)}/s`,
        `24-hour quota: ${a.max_24_hour_send < 0 ? 'no limit' : n(a.max_24_hour_send)}`,
        `Sent in the last 24 hours: ${n(a.sent_last_24_hours)}`,
        `Production access: ${a.production_access_enabled ? 'yes' : 'no (sandbox)'}`,
        `Sending enabled: ${a.sending_enabled ? 'yes' : 'no'}`,
        `Read at: ${new Date(a.read_at).toLocaleString()}`,
      ];
      if (this.sesCheck.setting > a.max_send_rate || (this.sesCheck.setting === 0 && a.max_send_rate > 0)) {
        lines.push(`The send rate setting (${this.sesCheck.setting || 'no cap'}) is higher than SES's ${n(a.max_send_rate)}/s.`);
      }
      return lines;
    },
    get sesCheckError() {
      if (!this.sesCheck) {
        return '';
      }
      if (!this.sesCheck.configured) {
        return 'No SES API credentials are saved: there is no capacity forecast.';
      }
      return this.sesCheck.error || '';
    },

    async doSESCheck() {
      this.sesCheck = null;
      try {
        this.sesCheck = await api('settings.checkSES', `${base}/ses/check`, 'POST', {});
      } catch (err) {
        this.sesCheck = { configured: true, error: err.message, account: null };
      }
    },

    async init() {
      try {
        this.form = normalize(await read(base));
        this.$nextTick(() => this.buildSearchIndex());
      } catch (e) {
        this.error = e.message;
      }
    },

    // ===============
    // Search.
    // Index every keyword tagged block and its tab.
    buildSearchIndex() {
      const tabs = this.$refs.tabs;
      if (!tabs) {
        return;
      }

      tabButtons = Array.from(tabs.querySelectorAll(':scope > [role="tablist"] > [role="tab"]'));
      tabPanels = Array.from(tabs.querySelectorAll(':scope > [role="tabpanel"]'));
      searchIndex = [];
      tabPanels.forEach((p, i) => {
        p.querySelectorAll('[data-keywords]').forEach((el) => {
          searchIndex.push({ el, panelIndex: i, keywords: (el.dataset.keywords || '').toLowerCase() });
        });
      });
    },

    onSearch(e) {
      const q = (e.target.value || '').trim().toLowerCase();
      const terms = q.split(/\s+/).filter(Boolean);

      // If there are no matches, then all settings are shown as normal.
      const panels = new Set();
      const matches = searchIndex.map((b) => {
        const ok = terms.length > 0 && terms.every((t) => b.keywords.includes(t));
        if (ok) {
          panels.add(b.panelIndex);
        }
        return ok;
      });

      if (panels.size === 0) {
        this.resetSearch();
        return;
      }

      this.$root.classList.add('is-searching');
      searchIndex.forEach((b, i) => b.el.classList.toggle('search-hide', !matches[i]));

      // Show only panels+tabs that have at least one matching block.
      tabPanels.forEach((p, i) => p.classList.toggle('search-match', panels.has(i)));
      tabButtons.forEach((t, i) => t.classList.toggle('search-hide', !panels.has(i)));
    },

    // Undo all search filters and render tabs and panels as normal.
    resetSearch() {
      this.$root.classList.remove('is-searching');
      searchIndex.forEach((b) => b.el.classList.remove('search-hide'));
      tabButtons.forEach((t) => t.classList.remove('search-hide'));
      tabPanels.forEach((p) => p.classList.remove('search-match'));
    },

    clearSearch() {
      this.$refs.search.value = '';
      this.resetSearch();
    },

    // Clicking a tab while searching resets the search and navigates to that tab.
    onTabClick(e) {
      if (e.target.closest('[role="tab"]') && this.$root.classList.contains('is-searching')) {
        this.clearSearch();
      }
    },

    // ot-tabs handles left/right arrows. Since this is vertical, handle up/down.
    onTabKeydown(e) {
      const dir = { ArrowUp: -1, ArrowDown: 1 }[e.key];
      if (!dir || !e.target.closest('[role="tab"]')) {
        return;
      }
      e.preventDefault();

      const tabs = this.$refs.tabs;
      const btns = tabs.querySelectorAll(':scope > [role="tablist"] > [role="tab"]');
      const next = (tabs.activeIndex + dir + btns.length) % btns.length;

      tabs.activeIndex = next;
      btns[next].focus();
    },

    // ===============
    // Event handlers.
    countLines(str) {
      return (str || '').split('\n').filter((l) => l.trim()).length;
    },

    // Toggle and persist accordion box open/closed state.
    setOpen(group, n, open) {
      this.form[group][n].open = open;
      (openState[group] ??= {})[n] = open;
      localStorage.setItem(OPEN_KEY, JSON.stringify(openState));
    },

    // ===============
    // Preference center fields (B147, D160).
    addPreferenceField() {
      this.form['privacy.preference_fields'].push({
        key: '', label: '', type: 'text', editable: true, required: false, min: null, max: null,
        options: [], strOptions: '',
      });
      this.$nextTick(() => {
        const items = document.querySelectorAll('.preference-field input[placeholder="city"]');
        items[items.length - 1]?.focus();
      });
    },

    async removePreferenceField(n) {
      if (!(await u.confirm())) {
        return;
      }
      this.form['privacy.preference_fields'].splice(n, 1);
    },

    // ===============
    // SMTP.
    addSMTP() {
      this.form.smtp.push({
        name: '', enabled: true, exclude_from_default: false, host: '', hello_hostname: '', port: 587, auth_protocol: 'none',
        username: '', password: '', email_headers: [], strEmailHeaders: '[]', savedHeaders: '[]', showHeaders: false,
        from_addresses: [], max_conns: 10, max_msg_retries: 2, msg_retry_delay: '10ms',
        idle_timeout: '15s', wait_timeout: '5s', tls_type: 'STARTTLS', tls_skip_verify: false,
        open: true,
      });
      this.$nextTick(() => {
        const items = document.querySelectorAll('.mail-servers input[placeholder="smtp.yourmailserver.net"]');
        items[items.length - 1]?.focus();
      });
    },

    async removeSMTP(n) {
      if (!(await u.confirm())) {
        return;
      }
      this.form.smtp.splice(n, 1);
    },

    // A template names a provider's host, and a saved password is sent with a blank field as "keep".
    // So a template on a saved server empties the password and marks it: onSubmit asks for it again
    // unless auth is none. A new server (no uuid) has no saved password to protect, so it is not marked.
    // Comparing the host with the form's would miss a host typed by hand before the template.
    fillSMTP(n, key) {
      this.form.smtp[n] = {
        ...this.form.smtp[n],
        ...smtpTemplates[key],
        username: '',
        password: '',
        needsPassword: !!this.form.smtp[n].uuid,
        hello_hostname: smtpTemplates[key].hello_hostname ? new URL(config.root_url).hostname : '',
        tls_skip_verify: false,
      };
      this.$nextTick(() => document.querySelector(`.smtp-username-${n}`)?.focus());
    },

    showSMTPTest(n) {
      this.smtpTestItem = this.smtpTestItem === n ? null : n;
      this.errMsg = '';
      if (this.smtpTestItem === n) {
        // The test box lives inside the accordion body, so make sure it's open.
        this.form.smtp[n].open = true;
        this.$nextTick(() => document.querySelector(`.test-email-${n}`)?.focus());
      }
    },

    isTestEnabled(item) {
      if (!item.host || !item.port) {
        return false;
      }
      if (item.auth_protocol !== 'none' && hasDummy(item.password)) {
        return false;
      }
      return true;
    },

    // The headers in the text box as a server's value. Throws on JSON that does not parse.
    _headers(s) {
      if (s.strEmailHeaders === s.savedHeaders) {
        return s.email_headers;
      }
      return s.strEmailHeaders.trim() ? JSON.parse(s.strEmailHeaders) : [];
    },

    _badHeaders() {
      u.toast(i18n.ts('globals.messages.invalidFields', { name: i18n.t('globals.fields.customHeaders') }), 'danger');
    },

    // The form's values, unsaved. The API has no stored password to fall back on here, so a masked
    // one has to be typed again, and a masked DKIM key cannot sign: the test goes out unsigned.
    async doSMTPTest(item, n) {
      if (!this.isTestEnabled(item)) {
        u.toast(i18n.t('settings.smtp.testEnterEmail'), 'warning');
        this.$nextTick(() => {
          const el = document.querySelector(`.smtp-password-${n}`);
          this.form.smtp[n].password = '';
          el?.focus();
        });
        return;
      }

      const body = this._server(JSON.parse(JSON.stringify(item)));
      if (!body) {
        return;
      }
      delete body.dkim;
      this.errMsg = '';
      try {
        await api('settings.testSMTP', `${base}/smtp/test`, 'POST', { ...body, email: this.testEmail });
        u.toast(i18n.t('campaigns.testSent'));
      } catch (err) {
        this.errMsg = err.message;
      }
    },

    // A server without what only the page uses. Null on headers that do not parse.
    _server(s) {
      try {
        s.email_headers = this._headers(s);
      } catch {
        this._badHeaders();
        return null;
      }
      if (s.noFromAddresses && !s.from_addresses.length) {
        s.from_addresses = null;
      }
      ['strEmailHeaders', 'savedHeaders', 'showHeaders', 'open', 'noFromAddresses', 'needsPassword'].forEach((key) => delete s[key]);
      return s;
    },

    // ===============
    // Submit.
    // B129 (D127): a logo or favicon goes to media, and its URL is set in the form; Save stores it.
    async uploadImage(key, event) {
      const input = event.target;
      const file = input.files?.[0];
      input.value = '';
      if (!file) {
        return;
      }
      const params = new FormData();
      params.set('file', file);
      try {
        const resp = await fetch(`${urls.api}/media`, {
          method: 'POST',
          body: params,
          headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
        });
        const out = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          throw new Error(out.message || resp.statusText);
        }
        this.form[key] = out.data.url;
        u.toast(i18n.ts('settings.general.imageUploaded'), 'success');
      } catch (err) {
        u.toast(err.message, 'danger');
      }
    },

    clearImage(key) {
      this.form[key] = '';
    },

    async onSubmit() {
      if (!config.can_manage) {
        return;
      }
      const form = JSON.parse(JSON.stringify(this.form));
      let dummy = '';

      // B56: the API refuses two items of one list with the same uuid. A later duplicate (only a
      // row saved before that rule can hold one) goes as a new item, so it takes no stored secret.
      [form.smtp, form['bounce.mailboxes'], form.messengers].filter(Boolean).forEach((items) => {
        const seen = new Set();
        (items || []).forEach((item) => {
          if (!item?.uuid) {
            return;
          }
          if (seen.has(item.uuid)) {
            item.uuid = '';
          } else {
            seen.add(item.uuid);
          }
        });
      });

      // Blank a masked secret. A partly masked one is a mistake to point out, not a value to store.
      const secret = (obj, key, name) => {
        if (!obj || !(key in obj)) {
          return;
        }
        if (isDummy(obj[key])) {
          obj[key] = '';
        } else if (hasDummy(obj[key])) {
          dummy = name;
        }
      };

      for (let i = 0; i < (form.smtp || []).length; i += 1) {
        form.smtp[i].host = form.smtp[i].host?.trim();
        // Auth none sends no password, so there is nothing to re-enter (the field is disabled then).
        if (form.smtp[i].needsPassword && form.smtp[i].auth_protocol !== 'none' && isDummy(form.smtp[i].password)) {
          u.toast(i18n.ts('settings.smtp.passwordRequired', { name: form.smtp[i].host || `smtp #${i + 1}` }), 'warning');
          return;
        }
        secret(form.smtp[i], 'password', `smtp #${i + 1}`);
        secret(form.smtp[i].dkim, 'private_key', `dkim #${i + 1}`);
        if (!this._server(form.smtp[i])) {
          return;
        }
      }

      (form['bounce.mailboxes'] || []).forEach((b, i) => secret(b, 'password', `bounce #${i + 1}`));
      (form.messengers || []).forEach((m, i) => secret(m, 'password', `messenger #${i + 1}`));
      secret(form, 'upload.s3.aws_secret_access_key', 's3');
      secret(form, 'bounce.sendgrid_key', 'sendgrid');
      secret(form, 'ses.api_secret_access_key', 'ses');
      secret(form['bounce.azure'], 'shared_secret', 'azure shared secret');
      secret(form['security.captcha']?.hcaptcha, 'secret', 'captcha');
      secret(form['security.oidc'], 'client_secret', 'oidc');
      secret(form['bounce.postmark'], 'password', 'postmark');
      secret(form['bounce.forwardemail'], 'key', 'forwardemail');
      secret(form['bounce.lettermint'], 'key', 'lettermint');

      if (dummy) {
        u.toast(i18n.ts('globals.messages.passwordChangeFull', { name: dummy }), 'warning');
        return;
      }

      // One entry per line back to arrays.
      lineKeys.filter((key) => key in form).forEach((key) => {
        form[key] = lines(form[key]);
      });
      ['privacy.domain_blocklist', 'privacy.domain_allowlist'].filter((key) => key in form).forEach((key) => {
        form[key] = form[key].map((v) => v.toLowerCase());
      });

      // B147 (D160): options back to an array; an empty bound is no bound; a bound or option a type
      // does not take is dropped, so switching a field's type does not leave a value the API refuses.
      (form['privacy.preference_fields'] || []).forEach((f) => {
        const bounded = f.type === 'text' || f.type === 'number';
        const bound = (v) => (bounded && v !== '' && v !== null && v !== undefined ? Number(v) : null);
        f.min = bound(f.min);
        f.max = bound(f.max);
        f.options = f.type === 'select' ? lines(f.strOptions || '') : [];
        f.required = f.type === 'boolean' ? false : !!f.required;
        delete f.strOptions;
      });

      if ('app.notify_emails' in form) {
        form['app.notify_emails'] = typeof form['app.notify_emails'] === 'string'
          ? addressList(form['app.notify_emails'])
          : (form['app.notify_emails'] || []);
      }

      try {
        await api('settings', base, 'PUT', form);
      } catch {
        return;
      }

      this.smtpTestItem = null;
      u.toast(i18n.ts('globals.messages.updated', { name: i18n.t('globals.terms.settings') }), 'success');
      try {
        this.form = normalize(await read(base));
      } catch (e) {
        this.error = e.message;
      }
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('settingsView', component);
}, { once: true });
