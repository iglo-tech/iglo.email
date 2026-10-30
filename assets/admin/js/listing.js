// What the views that read their rows from the API share. Adapted from listmonk models/common.go
// (NewPageProps) and cmd/avatar.go at 6fcd95f; upstream's paginator is a server-side Go package.
import { i18n, urls } from '@/assets/admin/js/main.js';

const statusIcons = {
  confirmed: 'check',
  blocklisted: 'x-circle',
  disabled: 'pause-circle',
  unsubscribed: 'x',
  unconfirmed: 'help-circle',
};

// One read. A refused one (a busy reader answers 429, a bad query 400) throws the server's message
// for its section to show, instead of the global toast of api().
export async function read(uri) {
  const resp = await fetch(`${urls.api}${uri}`, { headers: { Accept: 'application/json' } });
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(out.message || resp.statusText);
  }
  return out.data;
}

// cmd/avatar.go makeInitials.
export function initials(name) {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => [...w]);
  if (!words.length) {
    return '?';
  }
  return (words[0][0] + (words[1]?.[0] ?? words[0][1] ?? '')).toUpperCase();
}

export function iconHref(name) {
  return `/admin/static/icons.svg#icon-${name}`;
}

export function statusIcon(status) {
  return iconHref(statusIcons[status] ?? 'help-circle');
}

// makeQuery: the allowed filters of the request, for a bulk action over all that match. A default
// is part of the selection: "all" on the lists page must not reach archived lists.
export function urlFilters(params, keys, defaults = {}) {
  const out = { ...defaults };
  for (const key of keys) {
    const values = params.getAll(key).map((value) => value.trim()).filter(Boolean);
    if (values.length) {
      out[key] = values;
    }
  }
  return out;
}

// The query for one API page, without a per_page=all that would read every row.
export function pageQuery(params, keys) {
  const out = new URLSearchParams();
  for (const key of keys) {
    params.getAll(key).filter(Boolean).forEach((value) => out.append(key, value));
  }
  const perPage = Number(params.get('per_page'));
  if (Number.isInteger(perPage) && perPage >= 1 && perPage <= 1000) {
    out.set('per_page', perPage);
  }
  return out;
}

// Links to ten pages around the current one, with the first and last, as paginator.HTML does.
export function pageLinks(params, page, perPage, total) {
  if (!perPage || total <= perPage) {
    return [];
  }
  const last = Math.ceil(total / perPage);
  const start = Math.max(1, Math.min(page - 4, last - 9));
  const end = Math.min(last, start + 9);
  const link = (n, label = String(n)) => {
    const query = new URLSearchParams(params);
    query.set('page', n);
    return {
      key: label, label, href: `?${query}`, current: n === page && label === String(n),
    };
  };
  const out = [];
  if (start > 1) {
    out.push(link(1, '«'));
  }
  for (let n = start; n <= end; n += 1) {
    out.push(link(n));
  }
  if (end < last) {
    out.push(link(last, '»'));
  }
  return out;
}

export function viewTitle(name) {
  return `${i18n.t('globals.buttons.view')} ${name}`;
}

export function filterTitle(name) {
  return `${i18n.t('globals.buttons.filter')} ${name}`;
}
