// The export and wipe answers of a subscriber's own privacy actions (B123, D126). Each public route
// module finds the subscriber its path pairs (a send or a campaign) and hands them here, with a
// `current` that re-reads the pairing; `null` means the path pairs nobody and nothing is written.
// Adapted from listmonk cmd/public.go (SelfExportSubscriberData, WipeSubscriberData) at 6fcd95f.
import type { Database } from "bun:sqlite";
import { writeTransaction } from "@/db/transaction";
import type { Translation } from "@/i18n/i18n";
import { publicMessage } from "@/public/message";
import { wipeConfirmation, type PageOptions } from "@/public/preferences";
import type { SubscriberMail } from "@/public/mail";
import type { RequestContext } from "@/server/context";
import { sendingHeld } from "@/settings/hold";
import type { SubscriberStore } from "@/subscribers/store";

type Subscriber = NonNullable<ReturnType<SubscriberStore["get"]>>;

export interface Privacy {
  /** Mails the subscriber their data. `null`: the path pairs nobody. */
  export(context: RequestContext, current: () => Subscriber | null): Response | null;
  /** Removes the subscriber and their data in one write. `null`: the path pairs nobody. */
  wipe(context: RequestContext, current: () => Subscriber | null): Response | null;
}

export function createPrivacy(deps: {
  db: Database;
  subscribers: SubscriberStore;
  mail: () => Pick<SubscriberMail, "exportData">;
  /** The site's branding and the privacy options, read for each answer. */
  page: () => PageOptions;
}): Privacy {
  const message = (t: Translation, status: number, title: string, text: string, back = false) =>
    publicMessage(t, { status, title, message: text, site: deps.page(), back });
  const failed = (t: Translation, status: number, text: string) =>
    message(t, status, t.T("globals.terms.error"), text);
  return {
    export(context, current) {
      const t = context.app.i18n;
      const sub = current();
      if (!sub) return null;
      if (!deps.page().allowExport) return failed(t, 400, t.T("public.invalidFeature"));
      if (sendingHeld(context.app.db)) return failed(t, 503, t.T("public.errorProcessingRequest"));
      try {
        deps.mail().exportData(sub);
      } catch (error) {
        context.app.logger.error(error);
        return failed(t, 500, t.T("public.errorProcessingRequest"));
      }
      return message(t, 200, t.T("public.dataSentTitle"), t.T("public.dataSent"));
    },
    wipe(context, current) {
      const t = context.app.i18n;
      if (!current()) return null;
      if (!deps.page().allowWipe) return failed(t, 400, t.T("public.invalidFeature"));
      // B126 (D123): the first POST asks on its own page. Only the confirmed POST deletes anything.
      if (context.url.searchParams.get("confirm") !== "true")
        return wipeConfirmation(t, context.url.pathname, deps.page());
      // The pairing is read again inside the write, so a change since the check writes nothing.
      const removed = writeTransaction(deps.db, () => {
        const sub = current();
        if (!sub) return false;
        deps.subscribers.remove([sub.id], { wipe: true });
        return true;
      });
      if (!removed) return null;
      return message(t, 200, t.T("public.dataRemovedTitle"), t.T("public.dataRemoved"), true);
    },
  };
}
