// Adapted from listmonk static/admin/assets/js/views/templates.js at 6fcd95f. Upstream's page
// arrives with its templates; here this module reads them from the API.
import Alpine from '@alpinejs/csp';
import {
  filterTitle, iconHref, initials, pageQuery, read, viewTitle,
} from '@/assets/admin/js/listing.js';
import {
  api, config, i18n, urls,
} from '@/assets/admin/js/main.js';
import { previewMixin } from '@/assets/admin/js/preview.js';
import * as u from '@/assets/admin/js/utils.js';

const urlParams = new URLSearchParams(window.location.search);

// templatesView is the templates list page component.
function templatesView() {
  return {
    ...previewMixin(),
    templates: [],
    loading: true,
    error: '',

    async init() {
      try {
        const type = urlParams.get('type');
        const data = await read(`/templates?no_body=true&${pageQuery(urlParams, ['query', 'order_by', 'order'])}`);
        this.templates = type ? data.filter((t) => t.type === type) : data;
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
    },

    initials,
    viewTitle,
    filterTitle,
    niceDate: u.niceDate,

    typeLabel(type) {
      return i18n.tc(type === 'tx' ? 'globals.terms.tx' : 'globals.terms.campaign', 1);
    },

    typeIcon(type) {
      return iconHref(type === 'tx' ? 'terminal' : 'send');
    },

    typeLink(type) {
      const query = new URLSearchParams(urlParams);
      query.set('type', type);
      return `?${query}`;
    },

    onPreview(id, name) {
      this.previewSaved(name, `${urls.api}/templates/${id}/preview`);
    },

    // Clone a template by fetching its full body and creating a copy.
    async onClone(id, name) {
      const newName = window.prompt(i18n.t('globals.fields.name'), i18n.ts('globals.messages.copyOf', { name }));
      if (!newName) {
        return;
      }

      try {
        const t = await api('templates', `/templates/${id}`);
        const data = await api('templates', '/templates', 'POST', {
          name: newName,
          type: t.type,
          subject: t.subject,
          body: t.body,
          body_source: t.body_source,
        });
        u.reload({ message: i18n.ts('globals.messages.created', { name: data.name }) });
      } catch { /* api() showed the message. */ }
    },

    async onSetDefault(id, name) {
      if (!(await u.confirm())) {
        return;
      }
      try {
        await api('templates', `/templates/${id}/default`, 'PUT');
        u.reload({ message: i18n.ts('globals.messages.updated', { name }) });
      } catch { /* api() showed the message. */ }
    },

    async onDelete(id, name) {
      if (!(await u.confirm(i18n.t('globals.messages.confirm')))) {
        return;
      }
      try {
        await api('templates', `/templates/${id}`, 'DELETE');
        u.reload({ message: i18n.ts('globals.messages.deleted', { name }) });
      } catch { /* api() showed the message. */ }
    },
  };
}

// templateForm is the add/edit template form page component.
function templateForm() {
  return {
    ...previewMixin(),
    isNew: !!config.is_new,
    ready: !!config.is_new,
    error: '',
    saved: { name: '' },

    form: {
      id: null,
      name: '',
      type: 'campaign',
      subject: '',
      body: '',
      body_source: null,
    },

    async init() {
      if (this.isNew) {
        return;
      }
      try {
        const t = await read(`/templates/${config.template_id}`);
        this.saved = t;
        this.form = {
          id: t.id,
          name: t.name,
          type: t.type,
          subject: t.subject || '',
          body: t.body || '',
          body_source: t.body_source || null,
        };
        this.ready = true;
      } catch (e) {
        this.error = e.message;
      }
    },

    initials,
    viewTitle,

    // Preview the current (unsaved) body by POSTing it to the preview endpoint.
    onPreviewBody() {
      this.previewPosted(this.form.name, `${urls.api}/templates/preview`, {
        template_type: this.form.type,
        body: this.form.body || '',
      });
    },

    onSaveShortcut() {
      this.onSubmit();
    },

    async onSubmit() {
      try {
        if (this.isNew) {
          const data = await api('templates', '/templates', 'POST', this._payload());
          u.redirect(`${urls.admin}/templates`, { message: i18n.ts('globals.messages.created', { name: data.name }) });
        } else {
          const data = await api('templates', `/templates/${this.form.id}`, 'PUT', this._payload());
          u.reload({ message: i18n.ts('globals.messages.updated', { name: data.name }) });
        }
      } catch { /* api() showed the message. */ }
    },

    _payload() {
      return {
        name: this.form.name,
        type: this.form.type,
        subject: this.form.subject,
        body: this.form.body,
        body_source: this.form.body_source,
      };
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('templatesView', templatesView);
  Alpine.data('templateForm', templateForm);
}, { once: true });
