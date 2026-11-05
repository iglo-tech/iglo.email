// Authored HTML on its way into the admin page (D66). listmonk mounts it as it is. This parses it
// in a document with no browsing context, where nothing runs or loads, and copies across only the
// elements and attributes listed here. A copy, not an edit of the parsed tree: a <form> can shadow
// any property of itself with a named control, and a new element carries nothing unlisted.

const ELEMENTS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br',
  'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div',
  'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's',
  'samp', 'section', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
]);

// Removed with their contents, which are code or make no sense as text. Any other unlisted element
// goes and leaves its contents.
const DROPPED = new Set([
  'applet', 'audio', 'base', 'button', 'canvas', 'datalist', 'embed', 'frame', 'frameset', 'head',
  'iframe', 'input', 'link', 'map', 'meta', 'noembed', 'noframes', 'noscript', 'object', 'option',
  'plaintext', 'script', 'select', 'style', 'template', 'textarea', 'title', 'video', 'xmp',
]);

const ATTRIBUTES = new Set([
  'align', 'alt', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'class', 'color', 'colspan',
  'data-embed', 'datetime', 'dir', 'face', 'headers', 'height', 'hspace', 'id', 'lang', 'nowrap',
  'open', 'rel', 'reversed', 'role', 'rowspan', 'scope', 'size', 'span', 'start', 'style', 'target',
  'title', 'type', 'valign', 'vspace', 'width',
]);

const URL_ATTRIBUTES = new Set(['background', 'cite', 'href', 'src']);
const SCHEMES = new Set(['cid', 'ftp', 'http', 'https', 'mailto', 'sms', 'tel']);
const DATA_IMAGE = /^data:image\/(?:gif|jpe?g|png|webp)[;,]/i;

// A value with no scheme is relative, or Liquid such as `{{ unsubscribe_url }}`. A browser drops
// tabs and newlines inside a URL and C0 controls and spaces around it, so `java\tscript:` counts.
export function safeURL(value, image = false) {
  const url = value.replace(/[\u0000- ]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase();
  return !scheme || SCHEMES.has(scheme) || (image && DATA_IMAGE.test(url));
}

// What this page's policy would refuse to load (D71): the address stays in a data attribute until
// the body leaves the editor, so nothing is requested and no violation is reported. With
// `remote_images`, the operator asked for this page's policy to allow them.
export function heldURL(value) {
  const url = URL.parse(value.trim(), window.location.href);
  if (!url || url.protocol === 'data:') {
    return false;
  }
  if (window._LM_CONFIG?.remote_images && /^https?:$/.test(url.protocol)) {
    return false;
  }
  // The server names the root origin in the policy only when it is a plain host (a name with `_`
  // is not, as it could end a directive), so only then is it one this page may load from.
  const root = URL.parse(window._LM_CONFIG?.root_url ?? '')?.origin;
  const rootNamed = root !== undefined && /^https?:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d+)?$/.test(root);
  return url.origin !== window.location.origin && !(rootNamed && url.origin === root);
}

// Addresses a style would fetch: url(), image-set() and image() forms. A CSS escape can spell any
// of them differently, so a declaration with one is held whenever it has a backslash at all.
const STYLE_FETCH = /\b(?:url|image-set|image|src)\s*\(/i;
const STYLE_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi;
function heldDeclaration(value) {
  if (!STYLE_FETCH.test(value) && !value.includes('\\')) {
    return false;
  }
  const urls = [...value.matchAll(STYLE_URL)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
  const plain = value.replace(STYLE_URL, '');
  return urls.some((url) => heldURL(url)) || STYLE_FETCH.test(plain) || plain.includes('\\');
}

// A style attribute as its declarations, split on the semicolons outside quotes, brackets and
// escapes. Text that never closes stays whole in the last one.
function declarations(style) {
  const list = [];
  let start = 0;
  let quote = '';
  let depth = 0;
  for (let i = 0; i < style.length; i += 1) {
    const c = style[i];
    if (c === '\\') {
      i += 1;
    } else if (quote) {
      quote = c === quote ? '' : quote;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
    } else if (c === ';' && depth === 0) {
      list.push(style.slice(start, i));
      start = i + 1;
    }
  }
  list.push(style.slice(start));
  return list.map((d) => d.trim()).filter(Boolean);
}

const property = (declaration) => declaration.split(':', 1)[0].trim().toLowerCase();

// The declarations of `base`, then those of `added` for properties `base` does not set: what the
// editor wrote wins over what was held.
function mergeStyle(base, added) {
  const list = declarations(base);
  const seen = new Set(list.map(property));
  for (const declaration of declarations(added)) {
    if (!seen.has(property(declaration))) {
      list.push(declaration);
    }
  }
  return list.join('; ');
}

const HOLDABLE = ['src', 'background'];

// The stored form of what the editor holds. A held style is only the declarations that fetch; they
// join whatever the style is now.
export function restoreHeld(html) {
  if (!html.includes('data-rte-')) {
    return html;
  }
  const root = inertElement(html);
  for (const name of HOLDABLE) {
    for (const el of root.querySelectorAll(`[data-rte-${name}]`)) {
      el.setAttribute(name, el.getAttribute(`data-rte-${name}`));
      el.removeAttribute(`data-rte-${name}`);
    }
  }
  for (const el of root.querySelectorAll('[data-rte-style]')) {
    el.setAttribute('style', mergeStyle(el.getAttribute('style') ?? '', el.getAttribute('data-rte-style')));
    el.removeAttribute('data-rte-style');
  }
  return root.innerHTML;
}

const allowed = (element, name) => (name === 'name' ? element === 'a'
  : ATTRIBUTES.has(name) || /^aria-[a-z]+$/.test(name));

// The live style keeps every declaration that fetches nothing, so the editor's changes to it are
// kept; the rest wait in `data-rte-style` until the body leaves the editor.
function copyStyle(from, to, held) {
  if (!from.hasAttribute('data-rte-style') && !declarations(from.getAttribute('style') ?? '').some(heldDeclaration)) {
    // Nothing to hold: the style is copied as written.
    to.setAttribute('style', from.getAttribute('style') ?? '');
    return;
  }
  const all = mergeStyle(from.getAttribute('style') ?? '', from.getAttribute('data-rte-style') ?? '');
  const live = [];
  const waiting = [];
  for (const declaration of declarations(all)) {
    (heldDeclaration(declaration) ? waiting : live).push(declaration);
  }
  if (live.length || from.hasAttribute('style')) {
    to.setAttribute('style', live.join('; '));
  }
  if (waiting.length) {
    to.setAttribute('data-rte-style', waiting.join('; '));
    for (const declaration of waiting) {
      held.add(declaration);
    }
  }
}

function copyAttributes(from, to, removed, held) {
  const element = to.localName;
  for (const attribute of from.attributes) {
    // A held address that left the editor by a path `restoreHeld` does not see, such as a drag.
    // It is the address it stands for and passes the same checks.
    const alias = /^data-rte-(src|background|style)$/.exec(attribute.name)?.[1];
    if (alias && from.hasAttribute(alias)) {
      // A style and its held declarations on one element, as after a paste or the source dialog:
      // `style` below carries both, so nothing the element had is dropped.
      if (alias !== 'style') {
        continue;
      }
    }
    const name = alias ?? attribute.name;
    if (name === 'style') {
      if (attribute.name === 'style' || !from.hasAttribute('style')) {
        copyStyle(from, to, held);
      }
      continue;
    }
    const { value } = attribute;
    if (URL_ATTRIBUTES.has(name)
      ? (name !== 'src' || element === 'img') && safeURL(value, name === 'src')
      : allowed(element, name)) {
      if (HOLDABLE.includes(name) && heldURL(value)) {
        to.setAttribute(`data-rte-${name}`, value);
        held.add(value);
      } else {
        to.setAttribute(name, value);
      }
    } else {
      removed.add(URL_ATTRIBUTES.has(name) ? `${name}="${value.slice(0, 40)}"` : name);
    }
  }
}

function copyChildren(from, to, removed, held) {
  const walker = document.createTreeWalker(from);
  for (let node = walker.firstChild(); node; node = walker.nextSibling()) {
    if (node instanceof Text) {
      to.append(node.data);
    } else if (node instanceof HTMLFormElement) {
      removed.add('form');
      copyChildren(node, to, removed, held);
    } else if (node instanceof HTMLElement && ELEMENTS.has(node.localName)) {
      const el = document.createElement(node.localName);
      copyAttributes(node, el, removed, held);
      to.append(el);
      copyChildren(node, el, removed, held);
    } else if (node instanceof HTMLElement && !DROPPED.has(node.localName)) {
      removed.add(node.localName);
      copyChildren(node, to, removed, held);
    } else if (node instanceof Element) {
      removed.add(node.localName);
    }
  }
}

// The live-document fragment, the names of what did not come across, and the addresses held back.
export function sanitizeHTML(html) {
  const { head, body } = new DOMParser().parseFromString(html || '', 'text/html');
  const fragment = document.createDocumentFragment();
  const removed = new Set();
  const held = new Set();
  for (const element of head.children) {
    removed.add(element.localName);
  }
  copyChildren(body, fragment, removed, held);
  return { fragment, removed, held };
}

// An element for reading authored HTML. innerHTML on an element of the page runs image handlers,
// even detached; this one's document has no browsing context.
export function inertElement(html) {
  const div = new DOMParser().parseFromString('', 'text/html').createElement('div');
  div.innerHTML = html || '';
  return div;
}
