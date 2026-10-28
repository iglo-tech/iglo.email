# Browser asset provenance

The CSS, JavaScript, icons, Geist fonts and PNG favicons under this directory
are copied or adapted from listmonk v7.0.0-beta.1, commit
`6fcd95f32bb633d3a62a06c383c0b3322eecc898`, under its AGPL-3.0 license.
The Geist font files retain their SIL Open Font License in
`admin/static/fonts/LICENSE.txt`. The iglo.email SVG wordmark is original to
this project. Binary files cannot carry source headers; the paths map as follows:

| Upstream | Here |
| --- | --- |
| `static/admin/assets/js/{main,i18n,table,utils,content,code-editor,editor-theme,richtext-editor,charts}.js` and `richtext/{data,table}.js` | `admin/js/`, with local imports using the project alias |
| `static/admin/assets/css/{style,richtext}.css` | `admin/css/` |
| `static/admin/assets/static/{favicon.png,icons.svg,richtext-icons.svg,fonts/*}` | `admin/static/` |
| `static/public/static/{style.css,script.js,favicon.png}` | `public/static/` |
| `static/admin/build.mjs` | `../scripts/assets-build.ts` |

The i18n module owns its replacement regex; the upstream main module's separate
module scope cannot supply it. The dropped restart/reload action is removed
from the admin app. No permission-dependent event stream, custom asset, logout,
subscription, settings or domain screen is enabled by the shell.

Direct browser build dependencies match the pinned upstream lock: Alpine.js
3.15.12, Oat 1.0.0, CodeMirror commands 6.10.4, lang-css 6.3.1, lang-html
6.4.11, lang-javascript 6.2.5, lang-markdown 6.5.0, language 6.12.4, search
6.7.1, state 6.7.0 and view 6.43.4, Lezer highlight 1.2.3, Chart.js 4.5.1 and
Squire 2.4.8. The root `bun.lock` pins their resolved transitive dependencies.
The build embeds the license files of all browser dependencies next to the
assets. The Alpine npm package omits its license file, so
`licenses/alpinejs-LICENSE.txt` is the upstream Alpine v3.15.12 license from
`https://github.com/alpinejs/alpine/blob/v3.15.12/LICENSE.md`.

The vendored `admin/js/editor-theme.js` separately retains fsegurai's 2025
copyright. Its complete MIT notice is tracked in
`licenses/fsegurai-codemirror-themes-MIT.txt`, copied byte-for-byte from
[codemirror-themes LICENSE at 60a37d7](https://github.com/fsegurai/codemirror-themes/blob/60a37d73bfa803721baadc4a61401de6ba3c116e/LICENSE).
It is embedded and served at
`/admin/static/licenses/fsegurai-codemirror-themes-MIT.txt`, independently of
the npm license collection and the minified browser bundle's comments. A
compiled-executable HTTP test verifies the copyright, permission and disclaimer.

The Altcha/CAPTCHA package and public build step, visual drag-and-drop email
builder and its distribution, view-specific domain entrypoints, custom
appearance and update/restart UI are omitted: they are later, dropped, or owned
by later domain tasks. The bundled editor and chart modules are reusable inputs;
they do not imply those screens exist.
