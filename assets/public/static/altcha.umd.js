// iglo.email ALTCHA widget, original to this project (AGPL-3.0). It replaces the altcha npm
// widget listmonk v7.0.0-beta.1 serves at this path (D72) and keeps its observable contract for
// the listmonk form and the snippets it generates: an <altcha-widget challenge="URL"> element in
// a form, a checkbox that solves the challenge, and a hidden `altcha` field with
// base64(JSON {challenge: {parameters, signature}, solution: {counter, derivedKey, time}}).
// It solves the SHA-256 challenges of altcha-lib v2 (uint32 counter) in blob workers through Web
// Crypto, and loads as a classic script or a module; nothing in it evaluates text as code.
(() => {
  if (typeof window === 'undefined' || !window.customElements || customElements.get('altcha-widget')) {
    return;
  }

  const defaults = {
    label: "I'm not a robot",
    verifying: 'Verifying...',
    verified: 'Verified',
    error: 'Verification failed. Try again later.',
    expired: 'Verification expired. Try again.',
  };
  const timeoutMs = 90000;

  // Runs in a worker, or on the page when workers are unavailable. Self-contained: a worker
  // receives its source text.
  async function solve(parameters, start, step, deadline) {
    const bytes = (hex) => {
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i += 1) {
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
      }
      return out;
    };
    const toHex = (buf) => Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    const salt = bytes(parameters.salt);
    const nonce = bytes(parameters.nonce);
    const prefix = parameters.keyPrefix.toLowerCase();
    const prefixBytes = prefix.length % 2 === 0 ? bytes(prefix) : null;
    const keyLength = parameters.keyLength || 32;
    const cost = Math.max(1, parameters.cost || 1);
    const input = new Uint8Array(salt.length + nonce.length + 4);
    input.set(salt, 0);
    input.set(nonce, salt.length);
    const view = new DataView(input.buffer);
    const begin = performance.now();
    for (let n = start, i = 0; n <= 0xffffffff; n += step, i += 1) {
      if (i % 64 === 0 && Date.now() > deadline) {
        return null;
      }
      view.setUint32(salt.length + nonce.length, n, false);
      let key = new Uint8Array(await crypto.subtle.digest(parameters.algorithm, input));
      for (let c = 1; c < cost; c += 1) {
        key = new Uint8Array(await crypto.subtle.digest(parameters.algorithm, key));
      }
      key = key.slice(0, keyLength);
      let match = true;
      if (prefixBytes) {
        for (let j = 0; j < prefixBytes.length; j += 1) {
          if (key[j] !== prefixBytes[j]) {
            match = false;
            break;
          }
        }
      } else {
        match = toHex(key).startsWith(prefix);
      }
      if (match) {
        return { counter: n, derivedKey: toHex(key), time: Math.floor((performance.now() - begin) * 10) / 10 };
      }
    }
    return null;
  }

  const workerSource = `${solve.toString()}
self.onmessage = async (e) => {
  const d = e.data;
  try {
    self.postMessage({ solution: await solve(d.parameters, d.start, d.step, d.deadline) });
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};`;

  // The first worker to find the counter wins; each tries every concurrency-th counter.
  function solveInWorkers(parameters, deadline) {
    const count = Math.min(8, Math.max(1, navigator.hardwareConcurrency || 2));
    let url;
    const workers = [];
    try {
      url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
      for (let i = 0; i < count; i += 1) {
        workers.push(new Worker(url));
      }
    } catch (e) {
      workers.forEach((w) => w.terminate());
      if (url) {
        URL.revokeObjectURL(url);
      }
      return solve(parameters, 0, 1, deadline);
    }
    return new Promise((resolve, reject) => {
      let pending = workers.length;
      const done = (fn, value) => {
        workers.forEach((w) => w.terminate());
        URL.revokeObjectURL(url);
        fn(value);
      };
      workers.forEach((w, i) => {
        w.onmessage = (e) => {
          if (e.data.error) {
            done(reject, new Error(e.data.error));
          } else if (e.data.solution) {
            done(resolve, e.data.solution);
          } else {
            pending -= 1;
            if (pending === 0) {
              done(resolve, null);
            }
          }
        };
        w.onerror = (e) => {
          e.preventDefault();
          done(reject, new Error(e.message || 'worker failed'));
        };
        w.postMessage({ parameters, start: i, step: workers.length, deadline });
      });
    });
  }

  const validChallenge = (c) => c && typeof c === 'object' && typeof c.signature === 'string'
    && c.parameters && typeof c.parameters === 'object'
    && ['SHA-256', 'SHA-384', 'SHA-512'].includes(c.parameters.algorithm)
    && /^(?:[0-9a-fA-F]{2})*$/.test(c.parameters.salt || '')
    && /^(?:[0-9a-fA-F]{2})*$/.test(c.parameters.nonce || '')
    && /^[0-9a-fA-F]+$/.test(c.parameters.keyPrefix || '');

  class AltchaWidget extends HTMLElement {
    connectedCallback() {
      if (!this.box) {
        this.build();
      }
      this.form = this.closest('form');
      this.onSubmit = this.onSubmit || ((e) => this.submitted(e));
      if (this.form) {
        this.form.addEventListener('submit', this.onSubmit, { capture: true });
      }
    }

    disconnectedCallback() {
      if (this.form) {
        this.form.removeEventListener('submit', this.onSubmit, { capture: true });
      }
      this.reset('unverified');
    }

    strings() {
      try {
        return { ...defaults, ...JSON.parse(this.getAttribute('strings') || '{}') };
      } catch (e) {
        return defaults;
      }
    }

    build() {
      const wrap = document.createElement('div');
      wrap.className = 'altcha';
      const label = document.createElement('label');
      this.box = document.createElement('input');
      this.box.type = 'checkbox';
      this.box.addEventListener('change', () => {
        if (this.state === 'verified' || this.state === 'verifying') {
          this.box.checked = this.state === 'verified';
          return;
        }
        if (this.box.checked) {
          this.verify();
        }
      });
      this.text = document.createElement('span');
      label.append(this.box, ' ', this.text);
      this.message = document.createElement('small');
      this.message.className = 'altcha-error';
      this.message.setAttribute('role', 'alert');
      this.field = document.createElement('input');
      this.field.type = 'hidden';
      this.field.name = this.getAttribute('name') || 'altcha';
      wrap.append(label, this.message, this.field);
      this.append(wrap);
      this.reset('unverified');
    }

    reset(state, note = '') {
      clearTimeout(this.expiry);
      this.run = (this.run || 0) + 1;
      this.state = state;
      if (!this.box) {
        return;
      }
      const s = this.strings();
      this.setAttribute('data-state', state);
      this.box.checked = false;
      this.box.disabled = false;
      this.text.textContent = s.label;
      this.message.textContent = note;
      this.field.value = '';
    }

    // Upstream's widget solves on submit only with auto="onsubmit"; here a submit before the box
    // is ticked always solves first, then submits again with the same submitter.
    submitted(e) {
      if (this.state === 'verified') {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const { submitter } = e;
      this.verify().then((ok) => {
        if (ok && this.form) {
          if (this.form.requestSubmit) {
            this.form.requestSubmit(submitter && submitter.form === this.form ? submitter : undefined);
          } else {
            this.form.submit();
          }
        }
      });
    }

    async verify() {
      if (this.state === 'verifying') {
        return this.pending;
      }
      this.pending = this.work();
      return this.pending;
    }

    async work() {
      const s = this.strings();
      const run = this.run + 1;
      this.reset('verifying');
      this.box.checked = true;
      this.box.disabled = true;
      this.text.textContent = s.verifying;
      try {
        const response = await fetch(this.getAttribute('challenge') || '', { headers: { accept: 'application/json' } });
        if (!response.ok) {
          throw new Error(`challenge ${response.status}`);
        }
        const challenge = await response.json();
        if (!validChallenge(challenge)) {
          throw new Error('invalid challenge');
        }
        const solution = await solveInWorkers(challenge.parameters, Date.now() + timeoutMs);
        if (run !== this.run) {
          return false;
        }
        if (!solution) {
          throw new Error('no solution');
        }
        this.state = 'verified';
        this.setAttribute('data-state', 'verified');
        this.box.checked = true;
        this.text.textContent = s.verified;
        this.field.value = btoa(JSON.stringify({
          challenge: { parameters: challenge.parameters, signature: challenge.signature },
          solution,
        }));
        const expires = Number(challenge.parameters.expiresAt) * 1000;
        if (expires > 0) {
          this.expiry = setTimeout(() => this.reset('expired', s.expired), Math.max(0, expires - Date.now()));
        }
        this.dispatchEvent(new CustomEvent('verified', { detail: { payload: this.field.value } }));
        return true;
      } catch (e) {
        if (run === this.run) {
          this.reset('error', s.error);
        }
        return false;
      }
    }
  }

  customElements.define('altcha-widget', AltchaWidget);
})();
