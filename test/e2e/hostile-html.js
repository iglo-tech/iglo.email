// What the sanitizer (D66) is held to in a real browser. Each entry is a body; `run()` in one of them
// would mark the page. Grouped as the brief for B3 lists them. Mutation shapes come from public
// mXSS reports: each relies on a parser reading the same markup differently a second time.
const run = "window.__hostile=1";
const fire = `<img src=x onerror="${run}">`;

export const corpus = {
  "script forms": [
    `<script>${run}</script>`,
    `<script src="/admin/static/js/boot.js"></script>`,
    `<SCRIPT>${run}</SCRIPT>`,
    `<scr<script>ipt>${run}</scr</script>ipt>`,
    `<script/x>${run}</script>`,
    `<p><script type="module">${run}</script></p>`,
    `<template><script>${run}</script></template>`,
    `<noscript>${fire}</noscript>`,
    `<iframe srcdoc="<script>parent.${run}</script>"></iframe>`,
    `<object data="javascript:${run}"></object>`,
    `<embed src="javascript:${run}">`,
    `<link rel="stylesheet" href="javascript:${run}">`,
    `<style>@import "javascript:${run}";</style>`,
  ],
  "event handlers": [
    fire,
    `<p onclick="${run}">x</p>`,
    `<body onload="${run}">x`,
    `<details open ontoggle="${run}">x</details>`,
    `<div onmouseover="${run}" style="position:fixed;inset:0">x</div>`,
    `<img src=x ONERROR="${run}">`,
    `<img src=x onerror\n=\n"${run}">`,
    `<img/src=x/onerror="${run}">`,
    `<video src=x onerror="${run}"></video>`,
    `<audio src=x onerror="${run}"></audio>`,
    `<input autofocus onfocus="${run}">`,
    `<select autofocus onfocus="${run}"></select>`,
    `<marquee onstart="${run}">x</marquee>`,
    `<div x-init="${run}">x</div>`,
    `<div x-data="{}" @click="${run}" :class="${run}">x</div>`,
  ],
  "javascript and data URLs": [
    `<a href="javascript:${run}">x</a>`,
    `<a href="JaVaScRiPt:${run}">x</a>`,
    `<a href=" &#14; javascript:${run}">x</a>`,
    `<a href="java&#10;script:${run}">x</a>`,
    `<a href="java&#9;script:${run}">x</a>`,
    `<a href="&#106;avascript:${run}">x</a>`,
    `<a href="vbscript:${run}">x</a>`,
    `<a href="data:text/html,<script>opener.${run}</script>">x</a>`,
    `<a href="data:image/svg+xml,<svg onload='${run}'/>">x</a>`,
    `<img src="javascript:${run}">`,
    `<img src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' onload='${run}'/>">`,
    `<img src="data:text/html,x">`,
    `<table background="javascript:${run}"><tr><td>x</td></tr></table>`,
    `<a href="x" xlink:href="javascript:${run}">x</a>`,
    `<blockquote cite="javascript:${run}">x</blockquote>`,
    `<form action="javascript:${run}"><button>x</button></form>`,
    `<button formaction="javascript:${run}">x</button>`,
    `<img srcset="javascript:${run} 1x">`,
  ],
  "SVG and MathML namespace confusion": [
    `<svg onload="${run}"></svg>`,
    `<svg><script>${run}</script></svg>`,
    `<svg><a xlink:href="javascript:${run}"><text>x</text></a></svg>`,
    `<svg><use href="data:image/svg+xml,<svg id='x' xmlns='http://www.w3.org/2000/svg'><script>${run}</script></svg>#x"/></svg>`,
    `<svg><animate attributeName="href" to="javascript:${run}"/></svg>`,
    `<svg><style>${fire}</style></svg>`,
    `<svg><title>${fire}</title></svg>`,
    `<svg><foreignObject>${fire}</foreignObject></svg>`,
    `<svg><p>${fire}</p></svg>`,
    `<math><mi href="javascript:${run}">x</mi></math>`,
    `<math><annotation-xml encoding="text/html">${fire}</annotation-xml></math>`,
    `<math><mtext><img src=x onerror="${run}"></mtext></math>`,
    `<math><style>${fire}</style></math>`,
  ],
  "base and meta refresh": [
    `<base href="https://attacker.invalid/">`,
    `<base target="_blank">`,
    `<meta http-equiv="refresh" content="0;url=javascript:${run}">`,
    `<meta http-equiv="refresh" content="0;url=https://attacker.invalid/">`,
    `<meta http-equiv="Content-Security-Policy" content="default-src *">`,
    `<head><base href="https://attacker.invalid/"><title>t</title></head><body>x</body>`,
  ],
  "DOM clobbering": [
    `<form id="body"><input name="contains"></form>`,
    `<form><input name="attributes"><input name="nodeType"><input name="childNodes"></form>`,
    `<form><input name="parentNode">${fire}</form>`,
    `<img name="body"><img name="cookie"><img name="getElementById">`,
    `<a id="location" href="https://attacker.invalid/">x</a>`,
    `<a id="_LM_CONFIG" name="root_url" href="https://attacker.invalid/">x</a>`,
    `<div id="confirm-dialog-template">x</div>`,
    `<div id="admin-bootstrap">x</div>`,
    `<a name="__proto__">x</a>`,
    `<object name="body"></object><embed name="forms">`,
  ],
  "mutation XSS": [
    `<noscript><p title="</noscript>${fire.replaceAll('"', "&quot;")}">`,
    `<svg></p><style><a id="</style>${fire.replaceAll('"', "&quot;")}">`,
    `<svg><p><style><a id="</style>${fire.replaceAll('"', "&quot;")}"></p></svg>`,
    `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=${run}&gt;">`,
    `<form><math><mtext></form><form><mglyph><style></math>${fire}`,
    `<math><mtext><option><FAKEFAKE><option></option><mglyph><svg><mtext><style><a title="</style>${fire.replaceAll('"', "&quot;")}">`,
    `<select><template><style><!--</style><a rel="--></style></template></select>${fire}">`,
    `<table><caption><svg><title><table><caption><title><style>${fire}</style>`,
    `<textarea>${fire}</textarea>`,
    `<title>${fire}</title>`,
    `<xmp>${fire}</xmp>`,
    `<listing>${fire}</listing>`,
    `<plaintext>${fire}`,
    `<noembed>${fire}</noembed>`,
    `<noframes>${fire}</noframes>`,
    `<a title="<!--"><!--><img src=x onerror="${run}">-->`,
    `<!--><img src=x onerror="${run}">-->`,
    `<![CDATA[><img src=x onerror="${run}">]]>`,
    `<?xml version="1.0"?><img src=x onerror="${run}">`,
    `<div><a title="&lt;/div&gt;${fire.replaceAll('"', "&quot;")}">x</a></div>`,
  ],
};

// Elements and attributes nothing in a mounted body may have. A body is not the page's markup, so
// this runs in the browser against the editor's own subtree.
export function audit(root) {
  const bad = [];
  const banned =
    /^(script|style|iframe|object|embed|base|meta|link|form|input|button|select|textarea|svg|math|template|video|audio|noscript)$/;
  for (const el of root.querySelectorAll("*")) {
    if (banned.test(el.localName)) bad.push(el.localName);
    if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") bad.push(`foreign ${el.localName}`);
    for (const { name, value } of el.attributes) {
      if (/^(on|x-|@|:)/.test(name)) bad.push(`${el.localName} ${name}`);
      if (name === "name" && el.localName !== "a") bad.push(`${el.localName} name`);
      if (name === "srcset" || name === "srcdoc" || name === "formaction") bad.push(name);
      const url = value.replace(/[\u0000- ]/g, "");
      if (/^(href|src|background|cite)$/.test(name) && /^(javascript|vbscript):/i.test(url))
        bad.push(`${name} ${value}`);
      if (
        /^(href|src|background|cite)$/.test(name) &&
        /^data:(?!image\/(png|gif|jpe?g|webp))/i.test(url)
      )
        bad.push(`${name} ${value}`);
    }
  }
  return bad;
}
