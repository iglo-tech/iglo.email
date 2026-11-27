// The instance Projects page (B143a, D157). Native: listmonk has no instance. It creates, edits and
// deletes projects through /api/instance/projects with the instance session's own CSRF cookie,
// `instance_csrf`, then reloads: the page arrives with its rows.
import Alpine from '@alpinejs/csp';
import { config, i18n } from '@/assets/admin/js/main.js';
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

/** The textarea's hostnames: one per line or comma, trimmed, empty lines dropped. */
function lines(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter((h) => h);
}

const blank = () => ({ slug: '', name: '', hostname: '', extra: '', primary: false });

function instanceProjects() {
  const projects = config.projects || [];
  return {
    form: blank(),
    edit: { slug: '', name: '', extra: '', before: [], customCss: '', customJs: '', code: null },
    doomed: '',
    confirm: '',

    get removedHosts() {
      const kept = new Set(lines(this.edit.extra));
      return this.edit.before.filter((h) => !kept.has(h)).join(', ');
    },

    get confirmMismatch() {
      return this.confirm !== this.doomed;
    },

    closeDialogs() {
      this.$refs.newDialog.close();
      this.$refs.editDialog.close();
      this.$refs.deleteDialog.close();
    },

    openNew() {
      this.form = blank();
      this.$refs.newDialog.showModal();
    },

    async openEdit(event) {
      const slug = event.currentTarget.dataset.slug;
      const project = projects.find((p) => p.slug === slug);
      if (!project) {
        return;
      }
      // D201: the public custom CSS and JS are the instance's to write, read from the project.
      const code = await call(`/projects/${encodeURIComponent(slug)}/appearance`, 'GET');
      this.edit = {
        slug,
        name: project.name,
        extra: project.extra.join('\n'),
        before: [...project.extra],
        customCss: code.custom_css,
        customJs: code.custom_js,
        code,
      };
      this.$refs.editDialog.showModal();
    },

    openDelete(event) {
      this.doomed = event.currentTarget.dataset.slug;
      this.confirm = '';
      this.$refs.deleteDialog.showModal();
    },

    async create() {
      const body = {
        slug: this.form.slug.trim(),
        name: this.form.name,
        hostname: this.form.hostname.trim(),
        extra: lines(this.form.extra),
      };
      if (this.form.primary) {
        body.primary = true;
      }
      await call('/projects', 'POST', body);
      u.reload({ message: i18n.t('globals.messages.done') });
    },

    async save() {
      const path = `/projects/${encodeURIComponent(this.edit.slug)}`;
      await call(path, 'PUT', {
        name: this.edit.name,
        extra: lines(this.edit.extra),
      });
      const code = this.edit.code;
      if (code && (code.custom_css !== this.edit.customCss || code.custom_js !== this.edit.customJs)) {
        await call(`${path}/appearance`, 'PUT', {
          custom_css: this.edit.customCss,
          custom_js: this.edit.customJs,
        });
      }
      u.reload({ message: i18n.t('globals.messages.done') });
    },

    async remove() {
      if (this.confirmMismatch) {
        return;
      }
      await call(`/projects/${encodeURIComponent(this.doomed)}`, 'DELETE', {
        confirm: this.confirm,
      });
      u.reload({ message: i18n.t('globals.messages.done') });
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('instanceProjects', instanceProjects);
}, { once: true });
