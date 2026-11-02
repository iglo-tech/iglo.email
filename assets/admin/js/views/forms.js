// Adapted from listmonk static/admin/assets/js/views/forms.js at 6fcd95f. Upstream's page arrives
// with its lists; here this module reads them from the API. Upstream writes a list's name and
// description, and the root URL, into the snippet as they are: here every value is escaped, as
// the snippet is pasted into someone's page. No captcha, as the public form serves none.
import Alpine from '@alpinejs/csp';
import { read } from '@/assets/admin/js/listing.js';
import { config, i18n } from '@/assets/admin/js/main.js';
import * as u from '@/assets/admin/js/utils.js';

function escapeHTML(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function component() {
  return {
    lists: [],
    ready: false,
    error: '',
    checked: [],
    redirectURL: '',
    html: '',

    init() {
      this.$watch('checked', () => this.renderHTML());
      this.$watch('redirectURL', () => this.renderHTML());
      this.fetchLists();
    },

    // The minimal listing has no type filter, and a list's counts are of no use here.
    async fetchLists() {
      try {
        const data = await read('/lists?minimal=true&per_page=all');
        const lists = (Array.isArray(data) ? data : data.results) || [];
        this.lists = lists.filter((l) => l.type === 'public');
      } catch (e) {
        this.error = e.message;
      }
      this.ready = true;
    },

    // ===============
    // Event handlers.
    copyHTML() {
      u.copyToClipboard(this.html);
    },

    // ===============
    // Private functions.
    renderHTML() {
      if (this.checked.length === 0) {
        this.html = '';
        return;
      }

      const root = escapeHTML(config.root_url || '');
      const subscribe = escapeHTML(i18n.t('globals.buttons.subscribe'));

      let h = `<form method="post" action="${root}/subscription/form" class="listmonk-form">\n`
        + '  <div>\n'
        + `    <h3>${subscribe}</h3>\n`
        + '    <input type="hidden" name="nonce" />\n';

      if (this.redirectURL) {
        h += `    <input type="hidden" name="next" value="${escapeHTML(this.redirectURL)}" />\n`;
      }

      h += '\n'
        + `    <p><input type="email" name="email" required placeholder="${escapeHTML(i18n.t('globals.fields.email'))}" /></p>\n`
        + `    <p><input type="text" name="name" placeholder="${escapeHTML(i18n.t('public.subName'))}" /></p>\n\n`;

      this.checked.forEach((uuid) => {
        const l = this.lists.find((x) => x.uuid === uuid);
        if (!l) {
          return;
        }

        const id = escapeHTML(l.uuid.substr(0, 5));
        h += '    <p>\n'
          + `      <input id="${id}" type="checkbox" name="l" checked value="${escapeHTML(l.uuid)}" />\n`
          + `      <label for="${id}">${escapeHTML(l.name)}</label>\n`;

        if (l.description) {
          h += '      <br />\n'
            + `      <span>${escapeHTML(l.description)}</span>\n`;
        }

        h += '    </p>\n';
      });

      h += '\n'
        + `    <input type="submit" value="${subscribe} " />\n`
        + '  </div>\n'
        + '</form>';

      this.html = h;
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('formsView', component);
}, { once: true });
