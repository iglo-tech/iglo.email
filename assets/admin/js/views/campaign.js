// Adapted from listmonk static/admin/assets/js/views/campaign.js at 6fcd95f. Upstream's page arrives
// with its campaign, lists and templates; here this module reads them from the API. The media
// picker is a dialog over /api/media, where upstream frames a media page (M4.5).
import Alpine from 'alpinejs';
import { convert, htmlToText } from '@/assets/admin/js/content.js';
import { initials, read, viewTitle } from '@/assets/admin/js/listing.js';
import {
  api, config, csrfToken, i18n, ListTag, urls,
} from '@/assets/admin/js/main.js';
import { previewMixin } from '@/assets/admin/js/preview.js';
import * as u from '@/assets/admin/js/utils.js';

const manageable = new Set(config.manage_campaigns?.split(',').filter(Boolean).map(Number));

// Media tag for <ot-taginput> attachments.
class MediaTag {
  constructor(m) { Object.assign(this, m); }

  toString() { return this.filename; }
}

// Convert an ISO datetime to a value for <input type="datetime-local"> in local time.
function toLocalInput(iso) {
  if (!iso) {
    return '';
  }

  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }

  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function makeForm(c) {
  return {
    id: c.id || null,
    uuid: c.uuid || '',
    status: c.status || 'draft',
    type: c.type || 'regular',
    name: c.name || '',
    subject: c.subject || '',
    from_email: c.from_email || config.from_emails?.[0] || '',
    messenger: c.messenger || 'email',
    content_type: c.content_type || 'richtext',
    tags: Array.isArray(c.tags) ? c.tags : [],
    lists: (c.lists || []).map((l) => new ListTag(l)),
    template_id: c.template_id || null,
    body: c.body || '',
    body_source: c.body_source || null,
    altbody: c.altbody === undefined ? null : c.altbody,
    media: (c.media || []).map((m) => new MediaTag(m.id ? m : { ...m, filename: `❌ ${m.filename}` })),
    headersStr: JSON.stringify(c.headers || [], null, 4),
    attribsStr: c.attribs ? JSON.stringify(c.attribs, null, 4) : '{}',
    archive: !!c.archive,
    archive_slug: c.archive_slug || '',
    archive_template_id: c.archive_template_id || null,
    archiveMetaStr: c.archive_meta ? JSON.stringify(c.archive_meta, null, 4) : '{}',
    sendLater: !!c.send_at,
    sendAtLocal: toLocalInput(c.send_at),
    testEmails: [],
  };
}

function component() {
  return {
    ...previewMixin(),
    isNew: !!config.is_new,
    ready: false,
    error: '',
    saved: { name: '' },
    templates: [],
    isHeadersVisible: false,
    activeTab: 'campaign',
    contentReady: false,
    editorReady: false,
    // What the rich-text editor left out of the body, by name.
    editorRemoved: [],
    // A status change is in flight, or asking: a second click starts nothing.
    changing: false,
    _mediaTarget: null,
    mediaItems: [],
    mediaQuery: '',
    mediaError: '',
    mediaBusy: false,
    form: makeForm({}),

    async init() {
      // Mount content editor plugins only when the 'content' tab is active.
      if (new URLSearchParams(window.location.hash.slice(1)).get('tab') === 'content') {
        this.activeTab = 'content';
        this.contentReady = true;
      }
      this.$root.addEventListener('ot-tab-change', (e) => {
        if (e.detail?.tab?.id) {
          this.activeTab = e.detail.tab.id;
        }
        if (e.detail?.tab?.id === 'content') {
          this.contentReady = true;
        }
      });

      try {
        await this._load();
      } catch (e) {
        this.error = e.message;
      }
    },

    async _load() {
      const [camp, lists, templates] = await Promise.all([
        this.isNew ? {} : read(`/campaigns/${config.campaign_id}`),
        read('/lists?minimal=true&per_page=all'),
        config.can_templates ? read('/templates?no_body=true') : [],
      ]);
      window._lists = (Array.isArray(lists) ? lists : lists.results) || [];

      // The selects need their options before the model selects one.
      this.templates = templates;
      await this.$nextTick();

      const c = camp;
      if (this.isNew) {
        // A new campaign's lists: the optional `?list_id` query params this user may read.
        const ids = new URLSearchParams(window.location.search).getAll('list_id').map(Number);
        c.lists = window._lists.filter((l) => ids.includes(l.id));
      }
      c.media = await this._mediaDetails(c.media || []);
      this.saved = c;
      this.form = makeForm(c);
      this.isHeadersVisible = (c.headers || []).length > 0;

      // Default the content + archive templates if none are set.
      const def = this.templatesFor('campaign').find((t) => t.is_default) || this.templatesFor('campaign')[0];
      if (def) {
        this.form.template_id ||= def.id;
        this.form.archive_template_id ||= def.id;
      }

      // An editor reads its disabled attribute when it connects.
      if (!this.canEdit) {
        this.$root.querySelectorAll('template[data-editor]').forEach((t) => {
          t.content.firstElementChild.toggleAttribute('disabled', true);
        });
      }
      this.ready = true;
    },

    // The API's attachments carry an ID and a name; the gallery shows the URL and thumbnail.
    async _mediaDetails(media) {
      if (!config.can_media) {
        return media;
      }
      return Promise.all(media.map(async (m) => {
        if (!m.id) {
          return m;
        }
        try {
          const full = await read(`/media/${m.id}`);
          return {
            ...m, url: full.url, thumb_url: full.thumb_url, created_at: full.created_at,
          };
        } catch {
          return m;
        }
      }));
    },

    initials,
    viewTitle,

    statusLabel(status) {
      return i18n.t(`globals.terms.${status}`);
    },

    // ===============
    // Status-based computed getters.

    // The update and status routes take the manage scope of this campaign's lists.
    get canManage() {
      return this.isNew || config.manage_campaigns === 'all'
        || this.form.lists.some((l) => manageable.has(l.id));
    },

    get canEdit() {
      return this.canManage && (this.isNew || ['draft', 'scheduled', 'paused'].includes(this.form.status));
    },

    get canSend() {
      return !!config.can_send && this.canManage;
    },

    get canStart() {
      return this.canSend && ['draft', 'paused'].includes(this.form.status) && !this.form.sendLater;
    },

    get canSchedule() {
      return this.canSend && ['draft', 'paused'].includes(this.form.status)
        && this.form.sendLater && !!this.form.sendAtLocal;
    },

    get canUnSchedule() {
      return this.canSend && this.form.status === 'scheduled';
    },

    get canArchive() {
      return this.canManage && this.form.status !== 'cancelled' && this.form.type !== 'optin';
    },

    get showEditorSpinner() {
      // Read both flags unconditionally so Alpine tracks them as dependencies even
      // on the first evaluation (when contentReady is still false). A short-circuit
      // here would drop editorReady from the dependency set, so a later editor-ready
      // event wouldn't clear the spinner.
      const { contentReady, editorReady } = this;
      return contentReady && this.form.content_type !== 'plain' && !editorReady;
    },

    get editorNotice() {
      return i18n.ts('editor.removed', { items: this.editorRemoved.join(', ') });
    },

    get archiveURL() {
      return `${config.root_url.replace(/\/+$/, '')}/archive/${this.saved.archive_slug || this.form.uuid}`;
    },

    templatesFor(type) {
      return this.templates.filter((t) => t.type === type);
    },

    // Generate for the content-settings dropdown.
    get contentSettingsLabel() {
      const type = i18n.t(`editor.contentType.${this.form.content_type}`);
      const tpl = this.templatesFor('campaign').find((t) => t.id === this.form.template_id);
      return tpl && this.form.content_type !== 'visual' ? `${type} / ${tpl.name}` : type;
    },

    onToggleSendLater() {
      // Prefill a +7 day schedule if there's no existing value.
      if (this.form.sendLater && !this.form.sendAtLocal) {
        const d = new Date();
        d.setDate(d.getDate() + 7);
        d.setHours(0, 0, 0, 0);
        this.form.sendAtLocal = toLocalInput(d.toISOString());
      }
    },

    // The slug starts from the subject when the archive is turned on, not at creation, where two
    // campaigns with one subject would conflict.
    onToggleArchive() {
      if (this.form.archive && !this.form.archive_slug) {
        this.form.archive_slug = this.form.subject.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
      }
    },

    // ===============
    // Content type switching (converts the body between formats).
    async onContentTypeChange(e) {
      const to = e.target.value;
      const from = this.form.content_type;
      if (to === from) {
        return;
      }

      // Confirm before converting a non-empty body.
      if (this.form.body && this.form.body.trim()
        && !(await u.confirm(i18n.t('editor.confirmSwitchFormat')))) {
        e.target.value = from;
        return;
      }

      const { body, bodySource } = convert(this.form.body, from, to);
      if (from === 'visual') {
        this.form.template_id = this.templatesFor('campaign').find((t) => t.is_default)?.id ?? null;
      }

      // The new editor will remount. Hide it behind the spinner until it's ready.
      this.editorReady = false;
      this.form.content_type = to;
      this.form.body = body;
      this.form.body_source = bodySource;
      if (to === 'plain') {
        this.form.altbody = null;
      }
      this.$nextTick(() => this._syncEditor());
    },

    // Push the converted body into the new editor element.
    _syncEditor() {
      const el = this.$root.querySelector('.editor-body richtext-editor, .editor-body code-editor');
      if (el) {
        el.value = this.form.body;
      }
    },

    // ===============
    // Save / create / test / status.

    _payload() {
      let headers = [];
      const hs = (this.form.headersStr || '').trim();
      if (hs && hs !== '[]') {
        try { headers = JSON.parse(hs); } catch (e) { u.toast(`${i18n.t('subscribers.invalidJSON')}: ${e}`, 'danger'); return null; }
      }

      let attribs = null;
      const as = (this.form.attribsStr || '').trim();
      if (as) {
        try { attribs = JSON.parse(as); } catch (e) { u.toast(`${i18n.t('subscribers.invalidJSON')}: ${e}`, 'danger'); return null; }
      }

      // Hidden while the archive is off, and kept: only a visible field stops a save.
      let archiveMeta = (!this.form.archive && this.saved.archive_meta) || {};
      if (this.form.archiveMetaStr) {
        try {
          archiveMeta = JSON.parse(this.form.archiveMetaStr);
        } catch (e) {
          if (this.form.archive) {
            u.toast(`${i18n.t('subscribers.invalidJSON')}: ${e}`, 'danger');
            return null;
          }
        }
      }

      return {
        name: this.form.name,
        subject: this.form.subject,
        lists: this.form.lists.map((l) => l.id),
        from_email: this.form.from_email,
        messenger: this.form.messenger,
        type: 'regular',
        tags: this.form.tags,
        send_at: (this.form.sendLater && this.form.sendAtLocal) ? new Date(this.form.sendAtLocal).toISOString() : null,
        headers,
        attribs,
        template_id: this.form.template_id,
        content_type: this.form.content_type,
        body: this.form.body,
        body_source: this.form.body_source,
        altbody: this.form.content_type !== 'plain' ? this.form.altbody : null,
        archive: this.form.archive,
        archive_slug: this.form.archive_slug,
        archive_template_id: this.form.archive_template_id,
        archive_meta: archiveMeta,
        media: this.form.media.filter((m) => m.id).map((m) => m.id),
      };
    },

    async onCreate() {
      const p = this._payload();
      if (!p) {
        return;
      }

      const data = {
        name: p.name,
        subject: p.subject,
        lists: p.lists,
        from_email: p.from_email,
        content_type: p.content_type,
        messenger: p.messenger,
        type: 'regular',
        tags: p.tags,
        send_at: p.send_at,
        headers: p.headers,
        attribs: p.attribs,
        media: p.media,
      };

      try {
        const d = await api('campaigns', '/campaigns', 'POST', data);
        u.redirect(`${urls.admin}/campaigns/${d.id}#tab=content`, { message: i18n.ts('globals.messages.created', { name: d.name }) });
      } catch { /* api() showed the message. */ }
    },

    // True once stored.
    async _save() {
      const p = this._payload();
      if (!p) {
        return false;
      }

      const d = await api('campaigns', `/campaigns/${this.form.id}`, 'PUT', p);
      this.saved = d;
      this.form.archive_slug = d.archive_slug || this.form.archive_slug;
      return true;
    },

    async onSave() {
      try {
        if (await this._save()) {
          u.toast(i18n.ts('globals.messages.updated', { name: this.saved.name }));
        }
      } catch {
        await this._refreshStatus();
      }
    },

    // api() showed the server's message. The form was stale if another user moved the campaign
    // on: take its status, which decides the controls.
    async _refreshStatus() {
      try {
        const d = await read(`/campaigns/${this.form.id}?no_body=true`);
        this.form.status = d.status;
      } catch { /* The next action reports it. */ }
    },

    // Global Ctrl/Cmd+S handler.
    onSaveShortcut() {
      if (this.isNew) {
        this.onCreate();
      } else if (this.canEdit) {
        this.onSave();
      } else if (this.canArchive) {
        this.onSaveArchive();
      }
    },

    async _changeStatus(status, done) {
      if (this.changing) {
        return;
      }
      this.changing = true;
      const msg = status === 'scheduled' ? i18n.t('campaigns.confirmSchedule') : null;
      if (!(await u.confirm(msg))) {
        this.changing = false;
        return;
      }

      try {
        if (status !== 'draft' && !(await this._save())) {
          this.changing = false;
          return;
        }
        await api('campaigns', `/campaigns/${this.form.id}/status`, 'PUT', { status });
        done();
      } catch {
        await this._refreshStatus();
        this.changing = false;
      }
    },

    async onStart() {
      if (!this.canStart && !this.canSchedule) {
        return;
      }

      const status = this.canStart ? 'running' : 'scheduled';
      await this._changeStatus(status, () => {
        u.redirect(`${urls.admin}/campaigns`, { message: i18n.ts('globals.messages.statusChanged', { name: this.form.name, status: i18n.t(`globals.terms.${status}`) }) });
      });
    },

    async onUnschedule() {
      await this._changeStatus('draft', () => u.reload());
    },

    async onTest() {
      const p = this._payload();
      if (!p) {
        return;
      }

      try {
        await api('campaigns.test', `/campaigns/${this.form.id}/test`, 'POST', {
          ...p,
          id: this.form.id,
          subscribers: this.form.testEmails,
        });
        u.toast(i18n.t('campaigns.testSent'));
      } catch { /* api() showed the message. */ }
    },

    async onSaveArchive() {
      let meta = {};
      try { meta = JSON.parse(this.form.archiveMetaStr || '{}'); } catch (e) { u.toast(`${i18n.t('subscribers.invalidJSON')}: ${e}`, 'danger'); return; }

      try {
        const d = await api('campaigns', `/campaigns/${this.form.id}/archive`, 'PUT', {
          archive: this.form.archive,
          archive_template_id: this.form.archive_template_id,
          archive_meta: meta,
          archive_slug: this.form.archive_slug,
        });
        this.saved = { ...this.saved, archive_slug: d.archive_slug };
        this.form.archive_slug = d.archive_slug || this.form.archive_slug;
        u.toast(i18n.t('globals.messages.done'));
      } catch { /* api() showed the message. */ }
    },

    // ===============
    // Alt body / archive meta helpers.
    onAddAltBody() {
      this.form.altbody = htmlToText(this.form.body || '');
    },

    async onRemoveAltBody() {
      if (await u.confirm()) {
        this.form.altbody = null;
      }
    },

    onFillArchiveMeta() {
      const s = `{"email": "email@domain.com", "name": "${i18n.t('globals.fields.name')}", "attribs": {}}`;
      this.form.archiveMetaStr = JSON.stringify(JSON.parse(s), null, 4);
    },

    // ===============
    // Preview.
    onPreviewContent() {
      this.previewPosted(this.form.name, `${urls.api}/campaigns/${this.form.id}/preview`, {
        template_id: this.form.template_id || '',
        content_type: this.form.content_type,
        body: this.form.body || '',
      });
    },

    onPreviewArchive() {
      this.previewPosted(this.form.name, `${urls.api}/campaigns/${this.form.id}/preview/archive`, {
        template_id: this.form.archive_template_id || '',
        archive_meta: this.form.archiveMetaStr,
      });
    },

    // ===============
    // Media picker.
    async fetchMedia() {
      try {
        const query = new URLSearchParams({ per_page: 100, query: this.mediaQuery });
        const data = await read(`/media?${query}`);
        this.mediaItems = data.results || [];
        this.mediaError = '';
      } catch (e) {
        this.mediaError = e.message;
      }
    },

    onOpenMedia(target) {
      this._mediaTarget = target;
      this.fetchMedia();
      this.$refs.mediaDialog.showModal();
    },

    onEditorMedia(e) {
      this.onOpenMedia(e.detail.cb);
    },

    onMediaClose() {
      this._mediaTarget = null;
    },

    async onUploadMedia(e) {
      const file = this.$refs.mediaFile.files[0];
      if (!file || this.mediaBusy) {
        return;
      }

      this.mediaBusy = true;
      try {
        const body = new FormData();
        body.append('file', file);
        const resp = await fetch(`${urls.api}/media`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
          body,
        });
        const out = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          throw new Error(out.message || resp.statusText);
        }
        e.target.reset();
        await this.fetchMedia();
      } catch (err) {
        this.mediaError = err.message;
      }
      this.mediaBusy = false;
    },

    onPickMedia(m) {
      const t = this._mediaTarget;
      if (typeof t === 'function') {
        t(m.url);
      } else if (t === 'attach' && !this.form.media.some((x) => x.id === m.id)) {
        this.form.media.push(new MediaTag({
          id: m.id, filename: m.filename, url: m.url, thumb_url: m.thumb_url, created_at: m.created_at,
        }));
      }

      this.$refs.mediaDialog.close();
    },

    fileExt(filename) {
      const i = (filename || '').lastIndexOf('.');
      return i > 0 ? filename.slice(i + 1).toUpperCase() : '';
    },

    // Used for the attachment gallery captions to match the media gallery.
    niceDate: u.niceDate,

    // Remove an attachment. It's persisted only when the campaign is saved.
    async onDeleteAttachment(m) {
      if (!(await u.confirm())) {
        return;
      }
      this.form.media = this.form.media.filter((x) => x !== m);
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('campaignView', component);
}, { once: true });
