// Admin notifications adapted from listmonk internal/notifs/notifs.go,
// internal/manager/manager.go and internal/subimporter/importer.go at 6fcd95f.
// Admin mails are durable transactional sends enqueued without a subscriber,
// rendered from the built-in campaign-status and import-status templates.
import { createHash } from "node:crypto";
import type { Sends } from "@/messaging/sends";
import { safeLogo } from "@/messaging/test";
import { systemTemplates } from "@/templates/builtins";
import type { TemplateRenderer } from "@/templates/renderer";

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
}): AdminNotifier {
  const enqueue = (
    subject: string,
    html: string,
    idempotencyKey: string,
    fingerprintPayload: unknown,
  ) => {
    const current = deps.settings();
    const emails = [
      ...new Set(
        (current.notifyEmails || [])
          .map((e) => (typeof e === "string" ? e.trim() : ""))
          .filter(Boolean),
      ),
    ];
    if (!emails.length) return;

    const fromEmail = current.fromEmail || "noreply@localhost";
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(fingerprintPayload))
      .digest("hex");

    deps.sends.enqueueRequest({
      sends: emails.map((to) => ({
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
      idempotency: {
        key: idempotencyKey,
        fingerprint,
      },
    });
  };

  return {
    campaignStatus(campaign, reason = "") {
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

      const gen = campaign.runner_generation !== undefined ? `:${campaign.runner_generation}` : "";
      const idempotencyKey = `admin-notif:campaign:${campaign.id}:${campaign.status}${gen}:${campaign.sent}`;

      enqueue(subject, html, idempotencyKey, {
        campaignId: String(campaign.id),
        status: campaign.status,
        sent: campaign.sent,
        to_send: campaign.to_send,
        reason,
        emails,
      });
    },

    importStatus(importData) {
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

      const idempotencyKey = `admin-notif:import:${importData.name}:${importData.status}:${importData.imported}:${importData.total}`;

      enqueue(subject, html, idempotencyKey, {
        name: importData.name,
        status: importData.status,
        imported: importData.imported,
        total: importData.total,
        emails,
      });
    },
  };
}
