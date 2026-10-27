// Compiled test-only admin shell. This fixture is never installed in production.
import { renderAdminShell, type AdminShellProps } from "@/admin/layout/shell";
import { createTranslation } from "@/i18n/i18n";
import { assetVersion } from "@/server/asset-manifest";
import { assetResponse } from "@/server/assets";

const payload = "</script><script>globalThis.fixtureInjected=true</script>&\u2028\u2029";
const translation = createTranslation().Load({ "fixture.hostile": payload });
const props: AdminShellProps = {
  title: 'Fixture <&" title',
  siteName: 'Synthetic <&" site',
  assetVersion,
  i18n: translation,
  translationKeys: ["fixture.hostile"],
  config: { hostile: payload },
  navigation: [{ label: 'Nav <&"', href: "/fixture-link" }],
  profile: { name: 'User <&"' },
  children: <h1>Fixture &lt;content&gt;</h1>,
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const asset = assetResponse(path, request.method);
    if (asset) return asset;
    try {
      if (path === "/invalid-navigation")
        renderAdminShell({ ...props, navigation: [{ label: "bad", href: "//example.invalid" }] });
      else if (path === "/invalid-config")
        renderAdminShell({ ...props, config: { bad: (() => {}) as never } });
      else if (path === "/")
        return new Response(renderAdminShell(props), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      else return new Response("missing", { status: 404 });
    } catch {
      return new Response("rejected", { status: 400 });
    }
    return new Response("not rejected", { status: 500 });
  },
});
process.stdout.write(`http://127.0.0.1:${server.port}\n`);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void server.stop(true);
  });
