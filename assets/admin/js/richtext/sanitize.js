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

const allowed = (element, name) => (name === 'name' ? element === 'a'
  : ATTRIBUTES.has(name) || /^aria-[a-z]+$/.test(name));

function copyAttributes(from, to, removed) {
  const element = to.localName;
  for (const { name, value } of from.attributes) {
    if (URL_ATTRIBUTES.has(name)
      ? (name !== 'src' || element === 'img') && safeURL(value, name === 'src')
      : allowed(element, name)) {
      to.setAttribute(name, value);
    } else {
      removed.add(URL_ATTRIBUTES.has(name) ? `${name}="${value.slice(0, 40)}"` : name);
    }
  }
}

function copyChildren(from, to, removed) {
  const walker = document.createTreeWalker(from);
  for (let node = walker.firstChild(); node; node = walker.nextSibling()) {
    if (node instanceof Text) {
      to.append(node.data);
    } else if (node instanceof HTMLFormElement) {
      removed.add('form');
      copyChildren(node, to, removed);
    } else if (node instanceof HTMLElement && ELEMENTS.has(node.localName)) {
      const el = document.createElement(node.localName);
      copyAttributes(node, el, removed);
      to.append(el);
      copyChildren(node, el, removed);
    } else if (node instanceof HTMLElement && !DROPPED.has(node.localName)) {
      removed.add(node.localName);
      copyChildren(node, to, removed);
    } else if (node instanceof Element) {
      removed.add(node.localName);
    }
  }
}

// The live-document fragment, and the names of what did not come across.
export function sanitizeHTML(html) {
  const { body } = new DOMParser().parseFromString(html || '', 'text/html');
  const fragment = document.createDocumentFragment();
  const removed = new Set();
  copyChildren(body, fragment, removed);
  return { fragment, removed };
}

// An element for reading authored HTML. innerHTML on an element of the page runs image handlers,
// even detached; this one's document has no browsing context.
export function inertElement(html) {
  const div = new DOMParser().parseFromString('', 'text/html').createElement('div');
  div.innerHTML = html || '';
  return div;
}
