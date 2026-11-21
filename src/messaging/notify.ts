// Admin notifications adapted from listmonk internal/notifs/notifs.go,
// internal/manager/manager.go and internal/subimporter/importer.go at 6fcd95f.
// Admin mails are durable transactional sends enqueued without a subscriber,
// rendered from the built-in campaign-status and import-status templates.
import type { ErrorLogger } from "@/app";
import type { SafeMessage } from "@/maintenance/log-buffer";
import type { Sends } from "@/messaging/sends";
import { safeLogo } from "@/messaging/test";
import { parseAddress } from "@/settings/mail";
import { systemTemplates } from "@/templates/builtins";
import {
  createMessageBudget,
  type MessageBudget,
  type TemplateRenderer,
} from "@/templates/renderer";
import { plainText } from "@/messaging/plain";

export interface AdminNotifierSettings {
  notifyEmails: string[];
  fromEmail: string;
  rootUrl: string;
  logoUrl?: string;
}

export interface CampaignNotificationData {
  id: bigint | number;
  name: string;
  status: string;
  sent: number;
  to_send: number;
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

/** A bare or display-name address that fits the sender and recipient limits. */
function usableAddress(value: string): boolean {
  return (
    Buffer.byteLength(value) <= 2048 && !/[\r\n\0]/.test(value) && parseAddress(value) !== undefined
  );
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
  // A misconfigured address needs a person, not a stack: one plain line, and a fixed buffer text.
  const logAttention = (message: string, safe: SafeMessage) => {
    if (deps.logger) deps.logger.attention(message, safe);
    else console.error(message);
  };
  /** Each unusable sender is reported once per notifier, not on every notification. */
  const reportedFrom = new Set<string>();

  const enqueue = async (subject: string, html: string, budget: MessageBudget) => {
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
      if (usableAddress(email)) {
        validEmails.push(email);
      } else {
        logAttention(
          `Skipping invalid admin notification email address: ${email}`,
          "Admin notification address is not valid: skipped",
        );
      }
    }
    if (!validEmails.length) return;

    // An unusable sender would only be rejected by SES, so nothing is sent: the notification is
    // skipped and the bad value is logged once.
    const fromEmail = (current.fromEmail || "").trim();
    if (!usableAddress(fromEmail)) {
      if (!reportedFrom.has(fromEmail)) {
        reportedFrom.add(fromEmail);
        logAttention(
          `Admin notifications not sent: app.from_email is not a valid address: ${fromEmail}`,
          "Admin notifications not sent: app.from_email is not valid",
        );
      }
      return;
    }

    // The generated text part of a notification (B120, D118); none when it has no text.
    const text = await plainText(html, budget);
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
            ...(text ? { altBody: Buffer.from(text) } : {}),
          },
        },
      })),
    });
  };

  return {
    async campaignStatus(campaign, reason = "") {
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

        // One budget for the render and the generated text part (D118).
        const budget = createMessageBudget();
        const html = deps.renderer.renderSync(
          {
            body: systemTemplates.campaignStatus,
            mode: "html",
            data: JSON.stringify(data),
          },
          budget,
        ).body;

        await enqueue(subject, html, budget);
      } catch (error) {
        logError(error);
      }
    },

    async importStatus(importData) {
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

        // One budget for the render and the generated text part (D118).
        const budget = createMessageBudget();
        const html = deps.renderer.renderSync(
          {
            body: systemTemplates.importStatus,
            mode: "html",
            data: JSON.stringify(data),
          },
          budget,
        ).body;

        await enqueue(subject, html, budget);
      } catch (error) {
        logError(error);
      }
    },
  };
}
