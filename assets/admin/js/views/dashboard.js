// Adapted from listmonk static/admin/assets/js/views/dashboard.js at 6fcd95f. Upstream's page
// arrives with its data; here each section reads /api/dashboard/* and shows its own refusal.
import Alpine from 'alpinejs';
import { lineChart } from '@/assets/admin/js/charts.js';
import { initials, read } from '@/assets/admin/js/listing.js';
import { i18n } from '@/assets/admin/js/main.js';
import * as u from '@/assets/admin/js/utils.js';

function dashboardView() {
  return {
    counts: null,
    countsError: '',
    chartsLoading: true,
    chartsError: '',
    campaigns: null,
    campaignsError: '',

    init() {
      read('/dashboard/counts').then((d) => { this.counts = d; })
        .catch((e) => { this.countsError = e.message; });

      read('/dashboard/charts').then((d) => {
        lineChart('chart-views', d?.campaign_views);
        lineChart('chart-clicks', d?.link_clicks);
      }).catch((e) => { this.chartsError = e.message; })
        .finally(() => { this.chartsLoading = false; });

      read('/dashboard/campaigns').then((d) => { this.campaigns = d || []; })
        .catch((e) => { this.campaignsError = e.message; });
    },

    // A value out of the counts by its dotted path, or a placeholder until they arrive.
    count(path) {
      if (this.counts === null) {
        return '-';
      }
      return u.formatNumber(path.split('.').reduce((o, key) => o?.[key], this.counts) ?? 0);
    },

    initials,

    statusLabel(c) {
      return i18n.t(`globals.terms.${c.status}`);
    },

    viewTitle(c) {
      return `${i18n.t('globals.buttons.view')} ${c.name}`;
    },

    filterTitle(c) {
      return `${i18n.t('globals.buttons.filter')} ${this.statusLabel(c)}`;
    },

    campaignDate(c) {
      return u.niceDate(c.status === 'scheduled' && c.send_at ? c.send_at : c.created_at);
    },

    analyticsLink(c) {
      const from = c.started_at ? new Date(c.started_at) : new Date(Date.now() - 30 * 86400000);
      return `/admin/campaigns/analytics?id=${c.id}&from=${from.toISOString().slice(0, 10)}`;
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('dashboardView', dashboardView);
}, { once: true });
