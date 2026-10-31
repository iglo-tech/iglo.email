// Adapted from listmonk static/admin/assets/js/views/analytics.js at 6fcd95f. Upstream's page
// arrives with its data. Here this module reads each chart from the M3.3 routes and shows a refusal
// (429, 422, 500) in that chart. Upstream's date presets send the browser's wall clock to a server
// that reads it in its own zone; here the form is in UTC, as the API reads it.
import Alpine from 'alpinejs';
import Chart from 'chart.js/auto';
import { read } from '@/assets/admin/js/listing.js';
import { api, config } from '@/assets/admin/js/main.js';

const chartColorRed = '#ee7d5b';
const chartColors = [
  '#0055d4',
  '#FFB50D',
  '#41AC9C',
  chartColorRed,
  '#7FC7BC',
  '#3a82d6',
  '#688ED9',
  '#FFC43D',
];

const tooltip = {
  backgroundColor: '#fff',
  borderColor: '#ddd',
  borderWidth: 1,
  bodyColor: '#666',
  bodyFont: { size: 15 },
  bodySpacing: 10,
  padding: 10,
};

const DEFAULT_DONUT = {
  type: 'doughnut',
  options: {
    responsive: true,
    cutout: '70%',
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        ...tooltip,
        titleColor: '#666',
        callbacks: {
          label: (item) => {
            const data = item.chart.data.datasets[item.datasetIndex];
            return formatCount(data.data[item.dataIndex], data.sent[item.dataIndex]);
          },
        },
      },
    },
  },
};

const DEFAULT_LINE = {
  type: 'line',
  options: {
    responsive: true,
    lineTension: 0.5,
    maintainAspectRatio: false,
    interaction: { intersect: false, axis: 'index' },
    plugins: {
      legend: { display: false },
      tooltip: {
        ...tooltip,
        displayColors: true,
        callbacks: {
          labelColor: (item) => ({
            backgroundColor: item.dataset.borderColor,
            borderColor: 'transparent',
          }),
        },
      },
    },
    scales: {
      x: { grid: { display: false } },
      y: { grid: { display: false }, ticks: { precision: 0 } },
    },
  },
};

const DEFAULT_BAR = {
  type: 'bar',
  options: {
    responsive: true,
    indexAxis: 'y',
    barThickness: 40,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { ...tooltip, titleColor: '#666' },
    },
    scales: {
      x: { grid: { display: false } },
      y: { grid: { display: false } },
    },
  },
};

// Zero-pad a number to two digits.
const pad = (n) => String(n).padStart(2, '0');

// Format a timestamp string into a chart axis label.
function toLabel(s) {
  const d = new Date(s);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// AnalyticsTag is the object used in the <ot-taginput> analytics selector.
class AnalyticsTag {
  constructor(c) {
    this.id = c.id;
    this.name = c.name;
    this.sent = c.sent || 0;
    this.label = `#${c.id}: ${c.name}`;
  }

  toString() {
    return this.label;
  }
}

// Create a Chart.js instance on the canvas with the given id.
function draw(id, def, data, extraOptions) {
  const canvas = document.getElementById(id);
  if (!canvas) {
    return null;
  }

  Chart.getChart(canvas)?.destroy();
  return new Chart(canvas, {
    type: def.type,
    data,
    options: { ...def.options, ...(extraOptions || {}) },
  });
}

// Use the campaign's sent count instead of the chart total.
function formatCount(count, sent) {
  return sent > 0 ? `${count} (${((count / sent) * 100).toFixed(2)}%)` : `${count}`;
}

// Group each series once for chart points and legend totals.
function groupCounts(rows, idKey) {
  const groups = new Map();
  rows.forEach((row) => {
    const id = row[idKey];
    if (!groups.has(id)) {
      groups.set(id, { points: [], total: 0 });
    }
    const group = groups.get(id);
    group.points.push({ x: toLabel(row.timestamp), y: row.count });
    group.total += row.count;
  });
  return groups;
}

// Render per-item time series and totals, with optional unsubscription lines.
function renderCounts(key, items, idKey, counts, unsubs) {
  const datasets = items.map((c, n) => ({
    label: c.label,
    data: counts.get(c.id)?.points || [],
    borderColor: chartColors[n % chartColors.length],
    backgroundColor: chartColors[n % chartColors.length],
    borderWidth: 2,
    pointHoverBorderWidth: 5,
    pointBorderWidth: 0.5,
  }));
  const labels = datasets.map((d) => d.label);

  if (unsubs) {
    const label = document.getElementById(`chart-${key}`)?.dataset.extraLabel;
    datasets.push(...items.map((c, n) => ({
      ...datasets[n],
      label: `${datasets[n].label}: ${label}`,
      data: unsubs.get(c.id)?.points || [],
      borderDash: [6, 4],
    })));
  }

  draw(`chart-${key}`, DEFAULT_LINE, { datasets });
  draw(`chart-${key}-donut`, DEFAULT_DONUT, {
    labels,
    datasets: [{
      data: items.map((c) => counts.get(c.id)?.total || 0),
      sent: items.map((c) => c.sent),
      backgroundColor: chartColors,
      borderWidth: 6,
    }],
  });
}

// Render the link-clicks bar chart.
function renderLinks(rows) {
  const urls = rows.map((l) => l.url);
  const labels = rows.map((l) => {
    try {
      const u = new URL(l.url);
      if (l.url.length > 80) {
        return `${u.hostname}${u.pathname.substr(0, 50)}..`;
      }
      return u.hostname + u.pathname;
    } catch {
      return l.url;
    }
  });

  draw('chart-links', DEFAULT_BAR, {
    labels,
    datasets: [{ data: rows.map((l) => l.count), backgroundColor: chartColors }],
  }, {
    onClick: (e) => {
      const bars = e.chart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, true);
      if (bars.length > 0) {
        window.open(urls[bars[0].index], '_blank', 'noopener noreferrer');
      }
    },
  });
}

function analyticsView() {
  const settings = config.analytics;
  const { resource } = settings;
  const idKey = resource === 'lists' ? 'list_id' : 'campaign_id';
  let queryTimer = null;

  // The charts this page has, as [key, API type, unique]. The server rendered the same ones.
  const counts = settings.charts ? [
    ['views', 'views', false],
    ...(settings.unique ? [['unique_views', 'views', true]] : []),
    ['clicks', 'clicks', false],
    ...(settings.unique ? [['unique_clicks', 'clicks', true]] : []),
    ['bounces', 'bounces', false],
  ] : [];
  const section = () => ({ loading: true, ready: false, error: '', total: 0, extra: 0 });

  return {
    // What the form holds, and what the charts below show.
    chosen: [],
    items: [],
    submitting: false,
    error: '',
    from: settings.from,
    to: settings.to,
    sections: Object.fromEntries([
      ['subscriptions', section()],
      ...counts.map(([key]) => [key, section()]),
    ]),
    links: { loading: true, ready: false, error: '', count: 0 },
    groups: {},

    async init() {
      const found = await Promise.allSettled(settings.ids.map(
        (id) => read(`/${resource}/${id}${resource === 'campaigns' ? '?no_body=true' : ''}`),
      ));
      const refused = found.find((r) => r.status === 'rejected');
      if (refused) {
        this.error = refused.reason.message;
      }
      this.items = found.filter((r) => r.status === 'fulfilled').map((r) => new AnalyticsTag(r.value));
      this.chosen = this.items;
      if (this.items.length) {
        this.$nextTick(() => this.readCharts());
      }
    },

    query(type, unique) {
      const params = new URLSearchParams({ from: settings.from, to: settings.to });
      if (type !== 'links') {
        params.set('interval', settings.interval);
      }
      if (unique) {
        params.set('unique', 'true');
      }
      this.items.forEach((c) => params.append('id', c.id));
      return `/${resource}/analytics/${type}?${params}`;
    },

    readCharts() {
      counts.forEach(([key, type, unique]) => this.readCounts(key, type, unique));
      if (resource === 'lists') {
        this.readSubscriptions();
      }
      if (settings.charts) {
        this.readLinks();
      }
    },

    async readCounts(key, type, unique) {
      const s = this.sections[key];
      try {
        const groups = groupCounts((await read(this.query(type, unique))) || [], idKey);
        this.groups[key] = { counts: groups };
        s.total = [...groups.values()].reduce((sum, g) => sum + g.total, 0);
        this.$nextTick(() => renderCounts(key, this.items, idKey, groups));
      } catch (e) {
        s.error = e.message;
      } finally {
        s.loading = false;
        s.ready = !s.error;
      }
    },

    async readSubscriptions() {
      const s = this.sections.subscriptions;
      try {
        const [subscribed, left] = await Promise.all([
          read(this.query('subscriptions')), read(this.query('unsubscriptions')),
        ]);
        const groups = groupCounts(subscribed || [], idKey);
        const unsubs = groupCounts(left || [], idKey);
        this.groups.subscriptions = { counts: groups, unsubs };
        s.total = [...groups.values()].reduce((sum, g) => sum + g.total, 0);
        s.extra = [...unsubs.values()].reduce((sum, g) => sum + g.total, 0);
        this.$nextTick(() => renderCounts('subscriptions', this.items, idKey, groups, unsubs));
      } catch (e) {
        s.error = e.message;
      } finally {
        s.loading = false;
        s.ready = !s.error;
      }
    },

    async readLinks() {
      try {
        const rows = (await read(this.query('links'))) || [];
        this.links.count = rows.length;
        this.$nextTick(() => renderLinks(rows));
      } catch (e) {
        this.links.error = e.message;
      } finally {
        this.links.loading = false;
        this.links.ready = !this.links.error;
      }
    },

    color(n) {
      return chartColors[n % chartColors.length];
    },

    count(key) {
      return `(${this.sections[key].total.toLocaleString()})`;
    },

    legendCount(key, c) {
      return formatCount(this.groups[key]?.counts.get(c.id)?.total || 0, c.sent);
    },

    extraCount(key, c) {
      return this.groups[key]?.unsubs?.get(c.id)?.total || 0;
    },

    get rangeLabel() {
      return [this.from, this.to]
        .map((value) => (value ? value.slice(0, 16).replace('T', ' ') : '…'))
        .join(' – ');
    },

    onDateRange(amount, unit) {
      const now = new Date();
      const from = new Date(now);
      // The form holds minutes: round up, or the current minute is left out.
      const to = new Date(now.getTime() + 60 * 1000);
      if (unit === 'month') {
        // Clamp to the last day when the target month is short.
        from.setUTCDate(1);
        from.setUTCMonth(from.getUTCMonth() - amount);

        const lastDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0)).getUTCDate();
        from.setUTCDate(Math.min(now.getUTCDate(), lastDay));
      } else if (unit === 'day') {
        from.setUTCDate(from.getUTCDate() - amount);
      } else {
        from.setTime(from.getTime() - amount * 60 * 60 * 1000);
      }

      this.from = from.toISOString().slice(0, 16);
      this.to = to.toISOString().slice(0, 16);
      this.$refs.dates.hidePopover();
      this.$nextTick(() => this.$root.querySelector('form').requestSubmit());
    },

    // Populate the selector's suggestions with the resource API.
    onQuery(el) {
      clearTimeout(queryTimer);
      queryTimer = setTimeout(async () => {
        const ti = el.closest('ot-taginput');
        const chosen = new Set((ti ? ti.value : []).map((c) => c.id));
        const params = new URLSearchParams({
          query: el.value.trim(),
          order_by: 'created_at',
          order: 'DESC',
          no_body: 'true',
          per_page: '10',
        });

        try {
          const data = await api(`analytics.${resource}`, `/${resource}?${params.toString()}`, 'GET');
          el.list.replaceChildren(...(data.results || [])
            .filter((c) => !chosen.has(c.id))
            .map((c) => {
              const tag = new AnalyticsTag(c);
              const o = new Option(tag.label);
              o.data = tag;
              return o;
            }));
        } catch (err) { /* api() shows a toast. */ }
      }, 200);
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('analyticsView', analyticsView);
}, { once: true });
