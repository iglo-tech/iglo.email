// Adapted from listmonk static/admin/assets/js/views/maintenance.js at 6fcd95f, without its VACUUM
// settings: nothing here runs them.
import Alpine from 'alpinejs';
import {
  api,
  isLoading,
  i18n,
  urls,
} from '@/assets/admin/js/main.js';
import * as u from '@/assets/admin/js/utils.js';

// Returns a 'YYYY-MM-DD' string for (today - n days), for <input type="date"> defaults.
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Converts a 'YYYY-MM-DD' date input value to an RFC3339 timestamp.
function toRFC3339(date) {
  return new Date(date).toISOString();
}

function component() {
  return {
    isLoading,

    subscriberType: 'orphan',
    subscriptionType: 'optin',
    analyticsType: 'all',
    exportType: 'views',
    subscriptionDate: daysAgo(7),
    analyticsDate: daysAgo(7),
    exportDate: daysAgo(30),

    get exportURL() {
      if (!this.exportDate) {
        return '#';
      }
      const since = encodeURIComponent(toRFC3339(this.exportDate));
      return `${urls.api}/maintenance/analytics/${this.exportType}/export?since=${since}`;
    },

    // ===============
    // Event handlers.
    async deleteSubscribers() {
      if (!(await u.confirm())) {
        return;
      }

      const data = await api('maintenance', `/maintenance/subscribers/${this.subscriberType}`, 'DELETE');
      u.toast(i18n.ts('globals.messages.deletedCount', {
        name: i18n.tc('globals.terms.subscribers', 2),
        num: data.count,
      }));
    },

    async deleteSubscriptions() {
      if (!(await u.confirm())) {
        return;
      }

      const since = encodeURIComponent(toRFC3339(this.subscriptionDate));
      const data = await api('maintenance', `/maintenance/subscriptions/unconfirmed?before_date=${since}`, 'DELETE');
      u.toast(i18n.ts('globals.messages.deletedCount', {
        name: i18n.tc('globals.terms.subscriptions', 2),
        num: data.count,
      }));
    },

    async deleteAnalytics() {
      if (!(await u.confirm())) {
        return;
      }

      const since = encodeURIComponent(toRFC3339(this.analyticsDate));
      await api('maintenance', `/maintenance/analytics/${this.analyticsType}?before_date=${since}`, 'DELETE');
      u.toast(i18n.t('globals.messages.done'));
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('maintenanceView', component);
}, { once: true });
