// Adapted from listmonk static/admin/assets/js/views/import.js at 6fcd95f. Upstream's page arrives
// with the status and lists; here this module reads them from the API. Upstream polls on a fixed
// interval for as long as the tab stays open; here one read follows another, stops at the bounds
// below and pauses while the page is hidden.
import Alpine from '@alpinejs/csp';
import { read } from '@/assets/admin/js/listing.js';
import {
  api, csrfToken, i18n, ListTag, urls,
} from '@/assets/admin/js/main.js';
import * as u from '@/assets/admin/js/utils.js';

const POLL_MS = 1000;
// One hour of watching, counted only while the page is visible.
const MAX_POLLS = 3600;
const MAX_POLL_FAILURES = 5;
// The API keeps up to 1 MiB of log; the page shows the end of it.
const MAX_LOG_LINES = 1000;

// Regexp for splitting a log line into [timestamp] [message].
// 2026/10/31 12:00:00.123 processing 'subscribers.csv'
const reLine = /^([0-9/]+ [0-9:]+\.[0-9]+) (.+)$/;

function splitLine(l) {
  const parts = reLine.exec(l);
  return parts ? { timestamp: parts[1], message: parts[2] } : { timestamp: '', message: l };
}

function component() {
  return {
    form: {
      mode: 'subscribe',
      subStatus: 'unconfirmed',
      delim: ',',
      lists: [],
      overwriteUserInfo: false,
      overwriteSubStatus: false,
      file: null,
    },

    ready: false,
    isProcessing: false,
    status: { status: 'none' },
    logLines: [],
    error: '',
    pollTimer: null,
    polling: false,
    polls: 0,
    failures: 0,

    async init() {
      // Reset the status radio whenever the mode changes.
      this.$watch('form.mode', (mode) => {
        this.form.subStatus = mode === 'subscribe' ? 'unconfirmed' : 'unsubscribed';
      });
      document.addEventListener('visibilitychange', () => this.onVisibility());

      try {
        this.status = await read('/import/subscribers');
      } catch (e) {
        this.error = e.message;
        return;
      }
      this.ready = true;

      if (this.isRunning) {
        this.poll();
      } else if (this.isDone) {
        this.getLogs().catch((e) => {
          this.error = e.message;
        });
      } else {
        this.fetchLists();
      }
    },

    // The list selector takes names, not counts, so this is the minimal listing.
    async fetchLists() {
      try {
        const data = await read('/lists?minimal=true&per_page=all');
        window._lists = (Array.isArray(data) ? data : data.results) || [];
        const ids = new URLSearchParams(window.location.search).getAll('list_id').map(Number);
        this.form.lists = window._lists.filter((l) => ids.includes(l.id)).map((l) => new ListTag(l));
      } catch (e) {
        this.error = e.message;
      }
    },

    // ===============
    // State getters.
    get isIdle() {
      return this.ready && (this.status.status === 'none' || this.status.status === '');
    },

    get isRunning() {
      return this.status.status === 'importing' || this.status.status === 'stopping';
    },

    get isDone() {
      return ['finished', 'stopped', 'failed'].includes(this.status.status);
    },

    // The API's status stays `finished` after a stop; its log says so.
    get wasStopped() {
      return this.status.status === 'finished'
        && this.logLines.some((l) => l.message.includes('stop request received'));
    },

    get canUpload() {
      return !!this.form.file && !(this.form.mode === 'subscribe' && this.form.lists.length === 0);
    },

    get progress() {
      if (!this.status || !(this.status.total > 0)) {
        return 0;
      }
      return Math.ceil((this.status.imported / this.status.total) * 100);
    },

    get recordsLabel() {
      return i18n.ts('import.recordsCount', { num: this.status.imported || 0, total: this.status.total || 0 });
    },

    // Badge colour for the current status.
    get statusVariant() {
      if (this.status.status === 'finished') {
        return 'success';
      }
      if (['failed', 'stopped'].includes(this.status.status)) {
        return 'danger';
      }

      return 'secondary';
    },

    // ===============
    // Event handlers.
    onUpload() {
      if (this.form.mode === 'subscribe' && this.form.overwriteSubStatus) {
        u.confirm(i18n.t('import.subscribeWarning')).then((ok) => {
          if (ok) {
            this.onSubmit();
          }
        });
        return;
      }
      this.onSubmit();
    },

    async onSubmit() {
      this.isProcessing = true;
      this.error = '';

      const params = new FormData();
      params.set('params', JSON.stringify({
        mode: this.form.mode,
        subscription_status: this.form.subStatus,
        delim: this.form.delim,
        lists: this.form.mode === 'subscribe' ? this.form.lists.map((l) => l.id) : [],
        overwrite_userinfo: this.form.overwriteUserInfo,
        overwrite_subscription_status: this.form.overwriteSubStatus,
      }));
      params.set('file', this.form.file);

      try {
        const resp = await fetch(`${urls.api}/import/subscribers`, {
          method: 'POST',
          body: params,
          headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
        });

        const out = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          this._refused(out.message || resp.statusText);
          return;
        }

        // Reload so the page reads the status again.
        u.reload({ message: i18n.t('import.importStarted') });
      } catch (err) {
        this._refused(err.message);
      }
    },

    // Stop a running import or clear a finished one.
    async stopImport() {
      this.isProcessing = true;
      const wasDone = this.isDone;
      try {
        const status = await api('import', '/import/subscribers', 'DELETE');
        if (wasDone) {
          u.reload();
          return;
        }
        this.status = status;
        this.polls = 0;
        this.failures = 0;
        this.poll();
      } catch (e) {
        // api() has shown the message.
      }
      this.isProcessing = false;
    },

    onVisibility() {
      if (document.hidden) {
        clearTimeout(this.pollTimer);
      } else if (this.isRunning && this.polls < MAX_POLLS && this.failures < MAX_POLL_FAILURES) {
        this.poll();
      }
    },

    // ===============
    // Private functions.
    // One read at a time: the next is timed from the end of this one, so a slow server gets no
    // pile of requests. A failure keeps the last status on the screen.
    async poll() {
      if (this.polling) {
        return;
      }
      this.polling = true;
      clearTimeout(this.pollTimer);
      this.polls += 1;
      try {
        this.status = await read('/import/subscribers');
        await this.getLogs();
        this.failures = 0;
        this.error = '';
      } catch (e) {
        this.failures += 1;
        this.error = e.message;
      }
      this.polling = false;

      if (!this.isRunning) {
        return;
      }
      if (this.polls >= MAX_POLLS || this.failures >= MAX_POLL_FAILURES) {
        this.error = `${this.error} ${i18n.t('import.pollStopped')}`.trim();
        return;
      }
      if (!document.hidden) {
        this.pollTimer = setTimeout(() => this.poll(), POLL_MS);
      }
    },

    async getLogs() {
      const out = await read('/import/subscribers/logs');
      this.logLines = (out || '').split('\n').filter((l) => l).slice(-MAX_LOG_LINES).map(splitLine);

      this.$nextTick(() => {
        if (this.$refs.logLines) {
          this.$refs.logLines.scrollTop = this.$refs.logLines.scrollHeight;
        }
      });
    },

    _refused(message) {
      this.error = message;
      this.isProcessing = false;
      this.form.file = null;
      this.$refs.file.value = '';
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('importView', component);
}, { once: true });
