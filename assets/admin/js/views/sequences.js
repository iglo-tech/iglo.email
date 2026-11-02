// Native screens with no upstream source (docs/design/05-sequences.md#admin-ui). Stored names reach
// the page by x-text, and a save sends back the stored step with only the shown fields changed.
import Alpine from '@alpinejs/csp';
import {
  initials, pageLinks, pageQuery, read, subscriberID, viewTitle,
} from '@/assets/admin/js/listing.js';
import {
  api, config, i18n, urls,
} from '@/assets/admin/js/main.js';
import { previewMixin } from '@/assets/admin/js/preview.js';
import * as u from '@/assets/admin/js/utils.js';

const urlParams = new URLSearchParams(window.location.search);
const statusLabel = (status) => i18n.t(`sequences.status.${status}`);

function sequencesView() {
  return {
    sequences: [],
    page: { total: null, per_page: 0 },
    pages: [],
    counts: { enrollments: [], steps: [] },
    countsError: '',
    loading: true,
    error: '',

    async init() {
      try {
        const data = await read(`/sequences?${pageQuery(urlParams, ['page', 'status'])}`);
        this.sequences = data.results || [];
        this.page = data;
        this.pages = pageLinks(urlParams, data.page, data.per_page, data.total);
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
      this.fetchCounts();
    },

    // Apart from the list: this one runs in the analytics reader and can be refused as busy.
    async fetchCounts() {
      if (!this.sequences.length) {
        return;
      }
      const query = new URLSearchParams(this.sequences.map((s) => ['id', s.id]));
      try {
        this.counts = await read(`/sequences/counts?${query}`);
      } catch (e) {
        this.countsError = e.message;
      }
    },

    enrollmentCount(id, status) {
      const row = this.counts.enrollments.find((c) => c.sequence_id === id && c.status === status);
      return u.formatNumber(row?.count ?? 0);
    },

    stepCounts(id) {
      return this.counts.steps.filter((c) => c.sequence_id === id);
    },

    initials,
    viewTitle,
    statusLabel,
    niceDate: u.niceDate,
    formatNumber: u.formatNumber,
  };
}

let uid = 0;
const makeStep = (stored = {}) => {
  uid += 1;
  return {
    uid,
    stored,
    wait: stored.wait ?? 'PT0S',
    kind: stored.kind ?? 'transactional',
    template_id: stored.template_id ?? null,
    condition: stored.condition ? JSON.stringify(stored.condition, null, 2) : '',
    on_false: stored.on_false ?? 'exit',
  };
};

// JSON text as a value, or null when empty; `field` names it in the message.
function parsed(text, field) {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(i18n.ts('sequences.invalidJSON', { field }));
  }
}

function sequenceForm() {
  return {
    ...previewMixin(),
    isNew: !!config.is_new,
    ready: false,
    error: '',
    saved: { id: null, name: '', status: 'draft', active_enrollments: 0 },
    form: {
      name: '', event: '', where: '', exitOn: '', reentry: 'never', list_id: null,
    },
    steps: [],
    // Bumped to rebuild the cards: a moved editor element would lose its document.
    generation: 0,
    templates: [],
    templatesReadable: true,
    lists: [],
    testSubscriber: '',
    testError: '',

    async init() {
      try {
        await this.fetchChoices();
        if (this.isNew) {
          this.steps = [makeStep()];
        } else {
          this.load(await read(`/sequences/${config.sequence_id}`));
        }
        this.ready = true;
      } catch (e) {
        this.error = e.message;
      }
    },

    // What a viewer may not read stays an ID: the form still shows and keeps it.
    async fetchChoices() {
      try {
        this.templates = (await read('/templates?no_body=true')).filter((t) => t.type === 'tx');
      } catch {
        this.templatesReadable = false;
      }
      try {
        this.lists = (await read('/lists?per_page=100')).results || [];
      } catch {
        this.lists = [];
      }
    },

    load(s) {
      this.saved = s;
      this.form = {
        name: s.name,
        event: s.trigger.event,
        where: s.trigger.where ? JSON.stringify(s.trigger.where, null, 2) : '',
        exitOn: (s.exit_on || []).join('\n'),
        reentry: s.reentry,
        list_id: s.list_id,
      };
      this.steps = s.steps.map(makeStep);
      this.generation += 1;
    },

    initials,
    statusLabel,

    get liveWarning() {
      return i18n.ts('sequences.editLive', { count: this.saved.active_enrollments });
    },

    stepTitle(i) {
      return i18n.ts('sequences.step', { position: i + 1 });
    },

    templateOptions(step) {
      if (!step.template_id || this.templates.some((t) => t.id === step.template_id)) {
        return this.templates;
      }
      return [...this.templates, { id: step.template_id, name: `#${step.template_id}` }];
    },

    listOptions() {
      const id = this.form.list_id;
      if (!id || this.lists.some((l) => l.id === id)) {
        return this.lists;
      }
      return [...this.lists, { id, name: `#${id}` }];
    },

    onAddStep() {
      this.steps.push(makeStep());
    },

    onRemoveStep(i) {
      this.steps.splice(i, 1);
      this.generation += 1;
    },

    onMove(i, by) {
      const [step] = this.steps.splice(i, 1);
      this.steps.splice(i + by, 0, step);
      this.generation += 1;
    },

    onExample(step, event) {
      const text = event.target.value;
      event.target.value = '';
      if (!text) {
        return;
      }
      const editor = event.target.closest('.step-card').querySelector('code-editor');
      editor.value = text;
      step.condition = text;
    },

    onPreviewTemplate(step) {
      const name = this.templates.find((t) => t.id === step.template_id)?.name ?? `#${step.template_id}`;
      this.previewSaved(name, `${urls.api}/templates/${step.template_id}/preview`);
    },

    // What goes back: the stored fields, with the shown ones replaced. `status` stays out, so a
    // save never changes it.
    payload() {
      const where = parsed(this.form.where, i18n.t('sequences.triggerWhere'));
      return {
        name: this.form.name,
        trigger: { event: this.form.event, ...(where === null ? {} : { where }) },
        exit_on: this.form.exitOn.split('\n').map((name) => name.trim()).filter(Boolean),
        reentry: this.form.reentry,
        list_id: this.form.list_id,
        steps: this.steps.map((s, i) => ({
          ...s.stored,
          wait: s.wait,
          kind: s.kind,
          template_id: s.template_id,
          condition: parsed(s.condition, `${this.stepTitle(i)}: ${i18n.t('sequences.condition')}`),
          on_false: s.on_false,
        })),
      };
    },

    async onSubmit() {
      this.error = '';
      let body;
      try {
        body = this.payload();
      } catch (e) {
        this.error = e.message;
        return;
      }
      const live = this.saved.active_enrollments;
      if (live > 0 && !(await u.confirm(i18n.ts('sequences.editLiveConfirm', { count: live })))) {
        return;
      }
      try {
        const name = { name: body.name };
        if (this.isNew) {
          const data = await api('sequences', '/sequences', 'POST', body);
          u.redirect(`${urls.admin}/sequences/${data.id}`, {
            message: i18n.ts('globals.messages.created', name),
          });
        } else {
          await api('sequences', `/sequences/${this.saved.id}`, 'PUT', body);
          u.reload({ message: i18n.ts('globals.messages.updated', name) });
        }
      } catch (e) {
        this.error = e.message;
      }
    },

    async onStatus(status) {
      if (status === 'archived' && !(await u.confirm(i18n.t('sequences.archiveConfirm')))) {
        return;
      }
      this.error = '';
      try {
        await api('sequences', `/sequences/${this.saved.id}/status`, 'PUT', { status });
        u.reload({ message: i18n.ts('globals.messages.updated', { name: this.saved.name }) });
      } catch (e) {
        this.error = e.message;
      }
    },

    async onDelete() {
      if (!(await u.confirm())) {
        return;
      }
      this.error = '';
      try {
        await api('sequences', `/sequences/${this.saved.id}`, 'DELETE');
        u.redirect(`${urls.admin}/sequences`, {
          message: i18n.ts('globals.messages.deleted', { name: this.saved.name }),
        });
      } catch (e) {
        this.error = e.message;
      }
    },

    onOpenTest() {
      this.testError = '';
      this.$refs.testDialog.showModal();
    },

    async onStartTest() {
      this.testError = '';
      try {
        const subscriber = await subscriberID(this.testSubscriber);
        const data = await api('sequences.test', '/enrollments', 'POST', {
          sequence_id: this.saved.id,
          subscriber_id: subscriber,
          test: true,
        });
        u.redirect(`${urls.admin}/sequences/enrollments/${data.id}`);
      } catch (e) {
        this.testError = e.message;
      }
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('sequencesView', sequencesView);
  Alpine.data('sequenceForm', sequenceForm);
}, { once: true });
