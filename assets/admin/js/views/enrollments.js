// Native screens with no upstream source (docs/design/05-sequences.md#admin-ui): the enrollment
// explorer and one enrollment's timeline, which follows the scheduler while the enrollment runs.
import Alpine from '@alpinejs/csp';
import {
  pageLinks, pageQuery, read, subscriberID,
} from '@/assets/admin/js/listing.js';
import {
  api, config, i18n, urls,
} from '@/assets/admin/js/main.js';
import {
  exitText, skipLabel, statusText, statusVariant,
} from '@/assets/admin/js/send-labels.js';
import * as u from '@/assets/admin/js/utils.js';

const urlParams = new URLSearchParams(window.location.search);
const pageKeys = ['page', 'sequence_id', 'subscriber_id', 'status', 'exit_reason'];
const POLL_MS = 5000;
const statusLabel = (status) => i18n.t(`sequences.status.${status}`);

const cancel = async (id) => {
  if (await u.confirm()) {
    await api('enrollments', `/enrollments/${id}`, 'DELETE');
    return true;
  }
  return false;
};

function enrollmentsView() {
  return {
    enrollments: [],
    sequenceOptions: [],
    page: { total: null, per_page: 0 },
    pages: [],
    loading: true,
    error: '',
    filter: {
      sequence_id: urlParams.get('sequence_id') ?? '',
      subscriber: urlParams.get('subscriber_id') ?? '',
      status: urlParams.get('status') ?? '',
      exit_reason: urlParams.get('exit_reason') ?? '',
    },
    enroll: { sequence_id: '', subscriber: '', force: false },
    enrollError: '',

    async init() {
      try {
        const data = await read(`/enrollments?${pageQuery(urlParams, pageKeys)}`);
        this.enrollments = data.results || [];
        this.page = data;
        this.pages = pageLinks(urlParams, data.page, data.per_page, data.total);
        this.sequenceOptions = (await read('/sequences?per_page=100')).results || [];
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
    },

    statusLabel,
    niceDate: u.niceDate,
    exitText,

    async onFilter() {
      this.error = '';
      const query = new URLSearchParams();
      const { subscriber, ...rest } = this.filter;
      Object.entries(rest).filter(([, value]) => value).forEach((pair) => query.set(...pair));
      try {
        if (subscriber.trim()) {
          query.set('subscriber_id', await subscriberID(subscriber));
        }
        window.location.search = query.toString();
      } catch (e) {
        this.error = e.message;
      }
    },

    onOpenEnroll() {
      this.enrollError = '';
      this.$refs.enrollDialog.showModal();
    },

    async onEnroll() {
      this.enrollError = '';
      try {
        const data = await api('enrollments', '/enrollments', 'POST', {
          sequence_id: Number(this.enroll.sequence_id),
          subscriber_id: await subscriberID(this.enroll.subscriber),
          force: this.enroll.force,
        });
        u.redirect(`${urls.admin}/sequences/enrollments/${data.id}`);
      } catch (e) {
        this.enrollError = e.message;
      }
    },

    async onCancel(id) {
      try {
        if (await cancel(id)) {
          u.reload();
        }
      } catch (e) {
        this.error = e.message;
      }
    },
  };
}

function enrollmentView() {
  return {
    e: {},
    entries: [],
    ready: false,
    error: '',
    timer: null,

    async init() {
      await this.fetchTimeline();
    },

    destroy() {
      clearTimeout(this.timer);
    },

    async fetchTimeline() {
      try {
        const data = await read(`/enrollments/${config.enrollment_id}/timeline`);
        this.e = data.enrollment;
        this.entries = data.entries;
        this.error = '';
        this.ready = true;
      } catch (e) {
        this.error = e.message;
      }
      if (!this.ready || this.e.status === 'active') {
        this.timer = setTimeout(() => this.fetchTimeline(), POLL_MS);
      }
    },

    statusLabel,
    niceDate: u.niceDate,

    json(value) {
      return JSON.stringify(value, null, 2);
    },

    entryLabel(entry) {
      if (entry.type === 'trigger') {
        return i18n.ts('sequences.entry.trigger', { name: entry.name });
      }
      if (entry.type === 'enrolled') {
        return i18n.t('sequences.entry.enrolled');
      }
      if (entry.type === 'ended') {
        // The exit names its event or its condition (B127); the date beside the entry is when it ended.
        const status = statusLabel(entry.status);
        return entry.reason
          ? i18n.ts('sequences.entry.endedReason', {
            status,
            reason: exitText(entry.reason, null, entry.condition),
          })
          : i18n.ts('sequences.entry.ended', { status });
      }
      const kind = entry.kind ? i18n.t(`sequences.kind.${entry.kind}`) : '';
      if (entry.type === 'waiting') {
        const position = (entry.position ?? 0) + 1;
        // A cap-held wait names the cap and its end (B127); the date beside it is that end.
        return entry.held
          ? i18n.ts('sequences.entry.waitingHeld', { position, kind })
          : i18n.ts('sequences.entry.waiting', { position, kind });
      }
      const id = entry.step_id;
      const decision = statusText(entry.decision);
      const key = entry.removed ? 'stepRemoved' : 'step';
      return entry.reason
        ? i18n.ts(`sequences.entry.${key}Reason`, { id, kind, decision, reason: skipLabel(entry.reason) })
        : i18n.ts(`sequences.entry.${key}`, { id, kind, decision });
    },

    // The date an entry shows: a cap-held wait shows when the cap frees the step, not when it was due.
    entryAt(entry) {
      return entry.held ? entry.held_until : entry.at;
    },

    // A step's tone: a skipped step is a warning, a failed one a danger, a sent one a success.
    entryVariant(entry) {
      return entry.type === 'step' ? statusVariant(entry.decision) : null;
    },

    async onCancel(id) {
      try {
        if (await cancel(id)) {
          u.reload();
        }
      } catch (e) {
        this.error = e.message;
      }
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('enrollmentsView', enrollmentsView);
  Alpine.data('enrollmentView', enrollmentView);
}, { once: true });
