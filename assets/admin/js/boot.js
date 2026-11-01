// Runs in <head>, before anything paints or any module loads. The Content-Security-Policy of admin
// pages (D69) allows no inline script, so the server's translations and configuration arrive as a
// JSON data block and the stored theme is applied here. Upstream has both inline in base.html.
const { i18n, config } = JSON.parse(document.getElementById('admin-bootstrap').textContent);
window._LM_I18N = i18n;
window._LM_CONFIG = config;
try {
  const theme = localStorage.getItem('theme');
  if (theme) {
    document.documentElement.style.colorScheme = theme;
  }
} catch {
  // Storage can be denied; the page keeps the system theme.
}
