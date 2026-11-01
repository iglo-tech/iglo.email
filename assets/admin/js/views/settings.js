// Adapted from listmonk static/admin/assets/js/views/settings.js at 6fcd95f. The settings come from
// the API, and a save is that same object with the shown fields edited: PUT /api/settings replaces
// everything, so a key the form does not show is sent back as it was read. A masked secret goes
// back empty, which the API reads as "keep the stored value". After a save the form is read again,
// so a secret just typed is masked and a new server has its UUID. A save takes effect at once; only
// the root URL, a read-only flag, needs a restart.
import Alpine from '@alpinejs/csp';
import { read } from '@/assets/admin/js/listing.js';
import {
  api, config, i18n,
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
  'security.trusted_urls', 'security.trusted_proxies',
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

function component() {
  const openState = loadOpen();

  // Normalize the raw settings into a display-friendly form (mirrors the old getSettings()).
  const normalize = (data) => {
    const d = JSON.parse(JSON.stringify(data));

    // Serialize the email_headers map to a display string, and remember what an untouched
    // server sends back: a null stays null.
    d.smtp.forEach((s, i) => {
      s.strEmailHeaders = JSON.stringify(s.email_headers || [], null, 4);
      s.savedHeaders = s.strEmailHeaders;
      s.showHeaders = false;
      s.open = !!openState.smtp?.[i];
      s.noFromAddresses = !s.from_addresses;
      s.from_addresses ||= [];
    });

    lineKeys.forEach((key) => {
      d[key] = (d[key] || []).join('\n');
    });

    return d;
  };

  const lines = (value) => value.split('\n').map((v) => v.trim()).filter((v) => v !== '');

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

    smtpTestItem: null,
    testEmail: '',
    errMsg: '',

    async init() {
      try {
        this.form = normalize(await read('/settings'));
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

    fillSMTP(n, key) {
      this.form.smtp[n] = {
        ...this.form.smtp[n],
        ...smtpTemplates[key],
        username: '',
        password: '',
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
        await api('settings.testSMTP', '/settings/smtp/test', 'POST', { ...body, email: this.testEmail });
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
      ['strEmailHeaders', 'savedHeaders', 'showHeaders', 'open', 'noFromAddresses'].forEach((key) => delete s[key]);
      return s;
    },

    // ===============
    // Submit.
    async onSubmit() {
      if (!config.can_manage) {
        return;
      }
      const form = JSON.parse(JSON.stringify(this.form));
      let dummy = '';

      // Blank a masked secret. A partly masked one is a mistake to point out, not a value to store.
      const secret = (obj, key, name) => {
        if (!obj) {
          return;
        }
        if (isDummy(obj[key])) {
          obj[key] = '';
        } else if (hasDummy(obj[key])) {
          dummy = name;
        }
      };

      for (let i = 0; i < form.smtp.length; i += 1) {
        form.smtp[i].host = form.smtp[i].host?.trim();
        secret(form.smtp[i], 'password', `smtp #${i + 1}`);
        secret(form.smtp[i].dkim, 'private_key', `dkim #${i + 1}`);
        if (!this._server(form.smtp[i])) {
          return;
        }
      }

      form['bounce.mailboxes'].forEach((b, i) => secret(b, 'password', `bounce #${i + 1}`));
      form.messengers.forEach((m, i) => secret(m, 'password', `messenger #${i + 1}`));
      secret(form, 'upload.s3.aws_secret_access_key', 's3');
      secret(form, 'bounce.sendgrid_key', 'sendgrid');
      secret(form['bounce.azure'], 'shared_secret', 'azure shared secret');
      secret(form['security.captcha'].hcaptcha, 'secret', 'captcha');
      secret(form['security.oidc'], 'client_secret', 'oidc');
      secret(form['bounce.postmark'], 'password', 'postmark');
      secret(form['bounce.forwardemail'], 'key', 'forwardemail');
      secret(form['bounce.lettermint'], 'key', 'lettermint');
      secret(form['bounce.mailgun'], 'key', 'mailgun');

      if (dummy) {
        u.toast(i18n.ts('globals.messages.passwordChangeFull', { name: dummy }), 'warning');
        return;
      }

      // One entry per line back to arrays.
      lineKeys.forEach((key) => {
        form[key] = lines(form[key]);
      });
      ['privacy.domain_blocklist', 'privacy.domain_allowlist'].forEach((key) => {
        form[key] = form[key].map((v) => v.toLowerCase());
      });

      try {
        await api('settings', '/settings', 'PUT', form);
      } catch {
        return;
      }

      this.smtpTestItem = null;
      u.toast(i18n.ts('globals.messages.updated', { name: i18n.t('globals.terms.settings') }), 'success');
      try {
        this.form = normalize(await read('/settings'));
      } catch (e) {
        this.error = e.message;
      }
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('settingsView', component);
}, { once: true });
