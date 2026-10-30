// The preview dialog of the template and campaign screens, adapted from previewMixin in listmonk
// static/admin/assets/js/views/templates.js at 6fcd95f. Upstream posts a form into the frame. A
// cookie POST here needs its CSRF header, so the page fetches the HTML and writes it to the frame's
// srcdoc. The sandbox attribute gives that document no script and no origin; a srcdoc has no
// response headers, so the API's preview CSP goes in as the first thing in it.
import { csrfToken } from '@/assets/admin/js/main.js';
import * as u from '@/assets/admin/js/utils.js';

const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
const policyTag = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;

function frameDocument(text, type) {
  const html = type.startsWith('text/plain') ? `<pre>${u.escapeHTML(text)}</pre>` : text;
  return html.replace(/^\s*(?:<!doctype[^>]*>)?/i, (doctype) => `${doctype}${policyTag}`);
}

export function previewMixin() {
  return {
    preview: { title: '', loading: true },

    _openPreview(title) {
      this.preview = { title, loading: true };
      this.$refs.previewDialog.showModal();
    },

    // A saved one: GET into the frame, where the response has the API's sandbox CSP.
    previewSaved(title, url) {
      this._openPreview(title);
      this.$refs.previewFrame.src = url;
    },

    // Unsaved content, or the archive preview, which only has a POST.
    async previewPosted(title, url, fields) {
      this._openPreview(title);
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-CSRF-Token': csrfToken(),
          },
          body: new URLSearchParams(fields),
        });
        const type = resp.headers.get('content-type') ?? '';
        if (!resp.ok && type.includes('json')) {
          throw new Error((await resp.json()).message || resp.statusText);
        }
        const text = await resp.text();
        if (this.$refs.previewDialog.open) {
          this.$refs.previewFrame.srcdoc = frameDocument(text, type);
        }
      } catch (e) {
        this.$refs.previewDialog.close();
        u.toast(e.message, 'danger');
      }
    },

    onPreviewClose() {
      this.$refs.previewFrame.removeAttribute('src');
      this.$refs.previewFrame.removeAttribute('srcdoc');
      this.preview.loading = true;
    },
  };
}
