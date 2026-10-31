// Adapted from listmonk static/admin/assets/js/views/campaigns.js and the date functions of
// cmd/init.go and cmd/utils.go at 6fcd95f. Upstream's page arrives with its rows; here this module
// reads them from the API.
import Alpine from 'alpinejs';
import {
  filterTitle, initials, pageLinks, pageQuery, read, urlFilters, viewTitle,
} from '@/assets/admin/js/listing.js';
import {
  api, config, i18n, urls,
} from '@/assets/admin/js/main.js';
import { previewMixin } from '@/assets/admin/js/preview.js';
import * as u from '@/assets/admin/js/utils.js';

const pageKeys = ['page', 'order', 'order_by', 'query', 'status', 'tag', 'type'];
const filterKeys = ['status', 'tag', 'type'];
const urlParams = new URLSearchParams(window.location.search);
const manageable = new Set(config.manage_campaigns?.split(',').filter(Boolean).map(Number));

// Running stats are one read at a time, this far apart; failed reads back off to the maximum.
const pollInterval = 2000;
const maxPollInterval = 30000;
const pollTimeout = 10000;

const pad = (n) => String(n).padStart(2, '0');
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// compactDate: omits the current year.
function compactDate(iso, withTime = false, omitYear = false) {
  const d = new Date(iso);
  let out = `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}`;
  if (d.getFullYear() !== new Date().getFullYear() && !omitYear) {
    out += ` ${d.getFullYear()}`;
  }
  return withTime ? `${out}, ${hhmm(d)}` : out;
}

// ExactDate.
function exactDate(iso) {
  const d = new Date(iso);
  const offset = -d.getTimezoneOffset();
  const zone = `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${hhmm(d)}:${pad(d.getSeconds())} (UTC ${zone})`;
}

// formatTimestamps: an A - B date without the components both share.
function formatTimestamps(fromISO, toISO) {
  const from = new Date(fromISO);
  const to = new Date(toISO);
  if (to < from) {
    return '';
  }
  const end = `${days[to.getDay()]} ${pad(to.getDate())} ${months[to.getMonth()]} ${to.getFullYear()}`;
  if (from.toDateString() === to.toDateString()) {
    return `${hhmm(from)} - ${hhmm(to)}\n${end}`;
  }
  let start = `${days[from.getDay()]} ${pad(from.getDate())}`;
  const otherYear = from.getFullYear() !== to.getFullYear();
  if (from.getMonth() !== to.getMonth() || otherYear) {
    start += ` ${months[from.getMonth()]}`;
  }
  if (otherYear && from.getFullYear() !== new Date().getFullYear()) {
    start += ` ${from.getFullYear()}`;
  }
  return `${start} - ${end}`;
}

// Duration and niceDuration.
function duration(fromISO, toISO) {
  const ms = fromISO && toISO ? new Date(toISO) - new Date(fromISO) : 0;
  if (ms <= 0) {
    return '';
  }
  const total = Math.round(ms / 1000);
  const [d, h, m, s] = [
    Math.floor(total / 86400), Math.floor(total / 3600) % 24, Math.floor(total / 60) % 60, total % 60,
  ];
  if (d > 0) {
    return `${d}d ${h}h ${m}m`;
  }
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const hasEnded = (c) => ['finished', 'cancelled', 'paused'].includes(c.status) && !!c.started_at && !!c.updated_at;

function component() {
  return {
    ...previewMixin(),
    urlParams,
    campaigns: [],
    page: { total: null, per_page: 0 },
    pages: [],
    loading: true,
    error: '',
    // A status change is in flight, or asking: a second click starts nothing.
    changing: false,

    _pollID: null,
    _polling: false,
    _failures: 0,

    init() {
      this.fetchPage();
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          clearTimeout(this._pollID);
          this._pollID = null;
        } else if (!this._polling) {
          this._schedule(0);
        }
      });
    },

    destroy() {
      clearTimeout(this._pollID);
      this._pollID = null;
    },

    async fetchPage() {
      try {
        const query = pageQuery(urlParams, pageKeys);
        query.set('no_body', 'true');
        const data = await read(`/campaigns?${query}`);
        this.campaigns = data.results || [];
        this.page = data;
        this.pages = pageLinks(urlParams, data.page, data.per_page, data.total);
        this.error = '';
        this._schedule(0);
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
    },

    // ===============
    // Row text.
    initials,
    viewTitle,
    filterTitle,
    formatNumber: u.formatNumber,
    compactDate,
    exactDate,

    urlFilters() {
      return urlFilters(urlParams, filterKeys);
    },

    filterLink(key, value) {
      const query = new URLSearchParams(urlParams);
      query.delete('page');
      query.set(key, value);
      return `?${query}`;
    },

    statusLabel(status) {
      return i18n.t(`globals.terms.${status}`);
    },

    percent(c) {
      return c.to_send ? Math.floor((c.sent * 100) / c.to_send) : 0;
    },

    runTime(c) {
      return duration(c.started_at, c.updated_at);
    },

    analyticsLink(c) {
      const from = c.started_at ? new Date(c.started_at) : new Date(Date.now() - 30 * 86400000);
      return `/admin/campaigns/analytics?id=${c.id}&from=${from.toISOString().slice(0, 10)}`;
    },

    // The timestamp cell: the sorted date, or the campaign's timeline.
    timestamp(c) {
      const field = urlParams.get('order_by');
      if (['created_at', 'started_at', 'updated_at', 'send_at'].includes(field)) {
        const date = field !== 'updated_at' || hasEnded(c) ? c[field] : null;
        return date ? { text: u.niceDate(date, true), title: exactDate(date) } : { text: null };
      }

      const lines = [`${i18n.t('globals.fields.createdAt')}: ${exactDate(c.created_at)}`];
      if (c.send_at) {
        lines.push(`${i18n.t('globals.terms.scheduled')}: ${exactDate(c.send_at)}`);
      }
      if (c.started_at) {
        lines.push(`${i18n.t('globals.fields.startedAt')}: ${exactDate(c.started_at)}`);
      }
      if (hasEnded(c)) {
        lines.push(`${i18n.t('globals.fields.endedAt')}: ${exactDate(c.updated_at)}`);
      }
      const run = duration(c.started_at, c.updated_at);
      if (run) {
        lines.push(`${i18n.t('globals.fields.duration')}: ${run}`);
      }

      let text = u.niceDate(c.created_at);
      if (hasEnded(c)) {
        text = formatTimestamps(c.started_at, c.updated_at);
      } else if (c.status !== 'draft' && c.status !== 'scheduled' && c.started_at) {
        text = `${compactDate(c.started_at, true)} ${i18n.t('globals.fields.startedAt').toLowerCase()}`;
      }
      return { text, title: lines.join('\n') };
    },

    // The status route takes campaigns:send and the manage scope of this campaign's lists.
    canChange(c) {
      return !!config.can_send
        && (config.manage_campaigns === 'all' || c.lists.some((l) => manageable.has(l.id)));
    },

    // ===============
    // Row actions.
    onPreview(id, name) {
      this.previewSaved(name, `${urls.api}/campaigns/${id}/preview`);
    },

    async onChangeStatus(c, status) {
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
        await api('campaigns', `/campaigns/${c.id}/status`, 'PUT', { status });
        u.reload({ message: i18n.ts('globals.messages.statusChanged', { name: c.name, status: i18n.t(`globals.terms.${status}`) }) });
      } catch {
        // api() showed the server's message. The row was stale: show what is true now.
        await this.fetchPage();
        this.changing = false;
      }
    },

    async onClone(id, name) {
      const newName = window.prompt(i18n.t('globals.fields.name'), i18n.ts('globals.messages.copyOf', { name }));
      if (!newName || !newName.trim()) {
        return;
      }

      try {
        // Fetch the full campaign (with body) to clone.
        const c = await api('campaigns', `/campaigns/${id}`);
        const data = {
          name: newName,
          subject: c.subject,
          lists: (c.lists || []).map((l) => l.id),
          type: c.type,
          from_email: c.from_email,
          content_type: c.content_type,
          messenger: c.messenger,
          tags: c.tags,
          template_id: c.template_id,
          body: c.body,
          body_source: c.body_source,
          altbody: c.altbody,
          headers: c.headers,
          attribs: c.attribs,
          send_at: c.send_at,
          archive: c.archive,
          archive_template_id: c.archive_template_id,
          archive_meta: c.archive_meta,
          media: (c.media || []).map((m) => m.id),
        };
        if (c.archive) {
          data.archive_slug = `${newName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now().toString().slice(-4)}`;
        }

        const d = await api('campaigns', '/campaigns', 'POST', data);
        u.redirect(`/admin/campaigns/${d.id}`, { message: i18n.ts('globals.messages.created', { name: d.name }) });
      } catch { /* api() showed the message. */ }
    },

    async onDelete(id, name) {
      if (!(await u.confirm(i18n.ts('globals.messages.confirmDeleteNamed', { name })))) {
        return;
      }
      try {
        await api('campaigns', `/campaigns/${id}`, 'DELETE');
        u.reload({ message: i18n.ts('globals.messages.deleted', { name }) });
      } catch { /* api() showed the message. */ }
    },

    // ===============
    // Bulk actions (called from within the table() scope).
    async onDeleteSelected(count, params) {
      if (count === 0 || !(await u.confirm(i18n.ts('globals.messages.confirmDelete', {
        num: count,
        name: i18n.tc('globals.terms.campaign', count).toLowerCase(),
      })))) {
        return;
      }

      try {
        await api('campaigns', `/campaigns?${params}`, 'DELETE');
        u.reload({
          message: i18n.ts('globals.messages.deletedCount', {
            num: count,
            name: i18n.tc('globals.terms.campaign', count),
          }),
        });
      } catch { /* api() showed the message. */ }
    },

    // ===============
    // Live stats polling for running campaigns: nothing runs or the page is hidden, no timer.
    _schedule(delay) {
      clearTimeout(this._pollID);
      this._pollID = null;
      if (!document.hidden && this.campaigns.some((c) => c.status === 'running')) {
        this._pollID = setTimeout(() => this._poll(), delay);
      }
    },

    async _poll() {
      this._polling = true;
      let delay = pollInterval;
      try {
        const resp = await fetch(`${urls.api}/campaigns/running/stats`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(pollTimeout),
        });
        if (resp.status === 401 || resp.status === 403) {
          return;
        }
        if (!resp.ok) {
          throw new Error(resp.statusText);
        }

        const { data } = await resp.json();
        this._failures = 0;
        for (const c of this.campaigns.filter((row) => row.status === 'running')) {
          const stats = data.find((s) => s.id === c.id);
          if (!stats) {
            // It finished, or another user changed it.
            await this.fetchPage();
            return;
          }
          Object.assign(c, {
            sent: stats.sent, to_send: stats.to_send, rate: stats.rate, updated_at: stats.updated_at,
          });
        }
      } catch {
        // Retry transient network, timeout and JSON errors, less often each time.
        this._failures += 1;
        delay = Math.min(pollInterval * 2 ** this._failures, maxPollInterval);
      } finally {
        this._polling = false;
      }
      this._schedule(delay);
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('campaignsView', component);
}, { once: true });
