// Adapted from listmonk static/admin/assets/js/views/logs.js at 6fcd95f. A refused read shows its
// message, and the page keeps polling.
import Alpine from '@alpinejs/csp';
import { read } from '@/assets/admin/js/listing.js';

// [timestamp] *: [message]. Lines have no source file here.
// 2021/05/01 00:00:00.000000 *: error sending
const reLine = /^([0-9\s:/]+\.[0-9]{6}) \*:\s(.+)$/;

const POLL_INTERVAL = 10000;

function splitLine(l) {
  const parts = l.split(reLine);
  if (parts.length !== 4) {
    return { timestamp: '', message: l };
  }
  return { timestamp: parts[1], message: parts[2] };
}

function component() {
  return {
    lines: [],
    ready: false,
    error: '',
    pollID: null,

    init() {
      this.getLogs();

      // Refresh the logs every 10 seconds.
      this.pollID = setInterval(() => this.getLogs(), POLL_INTERVAL);
    },

    destroy() {
      clearInterval(this.pollID);
    },

    async getLogs() {
      try {
        this.lines = ((await read('/logs')) || []).filter((l) => l).map(splitLine);
        this.error = '';
        this.$nextTick(() => this.scrollToBottom());
      } catch (e) {
        this.error = e.message;
      } finally {
        this.ready = true;
      }
    },

    scrollToBottom() {
      if (this.$refs.lines) {
        this.$refs.lines.scrollTop = this.$refs.lines.scrollHeight;
      }
    },
  };
}

document.addEventListener('alpine:init', () => {
  Alpine.data('logsView', component);
}, { once: true });
