// Admin notifications adapted from listmonk internal/notifs/notifs.go,
// internal/manager/manager.go and internal/subimporter/importer.go at 6fcd95f.
// Admin mails are durable transactional sends enqueued without a subscriber,
// rendered from the built-in campaign-status and import-status templates.
import type { ErrorLogger } from "@/app";
import type { Sends } from "@/messaging/sends";
import { safeLogo } from "@/messaging/test";
import { parseAddress } from "@/settings/mail";
import { systemTemplates } from "@/templates/builtins";
import type { TemplateRenderer } from "@/templates/renderer";

export interface AdminNotifierSettings {
  notifyEmails: string[];
  fromEmail: string;
  rootUrl: string;
  logoUrl?: string;
  siteName?: string;
}

export interface CampaignNotificationData {
  id: bigint | number;
  name: string;
  status: string;
  sent: number;
  to_send: number;
  runner_generation?: bigint;
}

export interface ImportNotificationData {
  name: string;
  status: string;
  imported: number;
  total: number;
}

export interface AdminNotifier {
  campaignStatus(campaign: CampaignNotificationData, reason?: string): void;
  importStatus(importData: ImportNotificationData): void;
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

export function createAdminNotifier(deps: {
  sends: Pick<Sends, "enqueueRequest">;
  renderer: TemplateRenderer;
  settings: () => AdminNotifierSettings;
  logger?: ErrorLogger;
}): AdminNotifier {
  const logError = (error: unknown) => {
    (deps.logger ?? console).error(error);
  };

  const enqueue = (subject: string, html: string) => {
    const current = deps.settings();
    const rawEmails = [
      ...new Set(
        (current.notifyEmails || [])
          .map((e) => (typeof e === "string" ? e.trim() : ""))
          .filter(Boolean),
      ),
    ];
    if (!rawEmails.length) return;

    const validEmails: string[] = [];
    for (const email of rawEmails) {
      if (
        Buffer.byteLength(email) <= 2048 &&
        !/[\r\n\0]/.test(email) &&
        parseAddress(email) !== undefined
      ) {
        validEmails.push(email);
      } else {
        logError(new Error(`Skipping invalid admin notification email address: ${email}`));
      }
    }
    if (!validEmails.length) return;

    const fromCandidate = (current.fromEmail || "").trim();
    const fromEmail =
      Buffer.byteLength(fromCandidate) <= 2048 &&
      !/[\r\n\0]/.test(fromCandidate) &&
      parseAddress(fromCandidate) !== undefined
        ? fromCandidate
        : "noreply@localhost";

    deps.sends.enqueueRequest({
      sends: validEmails.map((to) => ({
        subscriberUuid: null,
        send: {
          source: "tx",
          kind: "transactional",
          subscriberId: null,
          message: {
            from: fromEmail,
            to: [to],
            subject,
            contentType: "html",
            body: Buffer.from(html),
          },
        },
      })),
    });
  };

  return {
    campaignStatus(campaign, reason = "") {
      try {
        const current = deps.settings();
        const emails = current.notifyEmails || [];
        if (!emails.length) return;

        const subject = `${capitalize(campaign.status)}: ${campaign.name}`;
        const data = {
          logo_url: safeLogo(current.logoUrl ?? ""),
          root_url: current.rootUrl.replace(/\/+$/, ""),
          id: String(campaign.id),
          name: campaign.name,
          status: campaign.status,
          sent: campaign.sent,
          to_send: campaign.to_send,
          reason,
        };

        const html = deps.renderer.renderSync({
          body: systemTemplates.campaignStatus,
          mode: "html",
          data: JSON.stringify(data),
        }).body;

        enqueue(subject, html);
      } catch (error) {
        logError(error);
      }
    },

    importStatus(importData) {
      try {
        const current = deps.settings();
        const emails = current.notifyEmails || [];
        if (!emails.length) return;

        const subject = `${capitalize(importData.status)}: ${importData.name} import`;
        const data = {
          logo_url: safeLogo(current.logoUrl ?? ""),
          root_url: current.rootUrl.replace(/\/+$/, ""),
          name: importData.name,
          status: importData.status,
          imported: importData.imported,
          total: importData.total,
        };

        const html = deps.renderer.renderSync({
          body: systemTemplates.importStatus,
          mode: "html",
          data: JSON.stringify(data),
        }).body;

        enqueue(subject, html);
      } catch (error) {
        logError(error);
      }
    },
  };
}
