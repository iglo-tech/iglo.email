// The answer of a navigation link whose view a later M4 task ports; it replaces the route line.
import type { AdminView } from "@/admin/page";

export function notYet(pageId: string, titleKey: string): AdminView {
  return ({ context }) => {
    const t = context.app.i18n;
    return {
      title: t.T(titleKey),
      pageId,
      status: 501,
      body: (
        <section data-testid="not-yet">
          <header class="page-header">
            <h3 class="page-title">{t.T(titleKey)}</h3>
          </header>
          <p>{t.T("admin.notYet")}</p>
        </section>
      ),
    };
  };
}
