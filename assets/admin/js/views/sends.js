// The send log (B127). Rows come from /api/sends, filtered by the URL's query, which the filter form
// rewrites. Labels come from send-labels.js, so a status or reason reads as on the other screens.
import Alpine from '@alpinejs/csp';
import { pageLinks, pageQuery, read, subscriberID } from '@/assets/admin/js/listing.js';
import {
  sequenceStepText, skipText, sourceText, statusText, statusVariant, subjectText,
} from '@/assets/admin/js/send-labels.js';
import * as u from '@/assets/admin/js/utils.js';

const urlParams = new URLSearchParams(window.location.search);
const pageKeys = ['page', 'status', 'source', 'kind', 'subscriber_id', 'list_id'];

function sendsView() {
  return {
    sends: [],
    page: { total: null, per_page: 0 },
    pages: [],
    loading: true,
    error: '',
    lists: [],
    filter: {
      status: urlParams.get('status') ?? '',
      source: urlParams.get('source') ?? '',
      kind: urlParams.get('kind') ?? '',
      subscriber: urlParams.get('subscriber_id') ?? '',
      list_id: urlParams.get('list_id') ?? '',
    },

    // The list filter is optional: a viewer who may not read lists keeps the rest of the filters.
    async fetchLists() {
      try {
        const lists = await read('/lists?minimal=true&per_page=all');
        return (Array.isArray(lists) ? lists : lists.results) || [];
      } catch (e) {
        return [];
      }
    },

    async init() {
      this.lists = await this.fetchLists();
      try {
        const data = await read(`/sends?${pageQuery(urlParams, pageKeys)}`);
        this.sends = data.results || [];
        this.page = data;
        this.pages = pageLinks(urlParams, data.page, data.per_page, data.total);
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
    },

    // The filter form: a subscriber is an ID or an exact address, as on the sequence screens.
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

    // ===============
    // Row text.
    niceDate: u.niceDate,
    statusText,
    statusVariant,
    skipText,
    subjectText,

    sourceText,

    sequenceText: sequenceStepText,
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('sendsView', sendsView);
}, { once: true });
