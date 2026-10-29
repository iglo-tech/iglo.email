// Embedded conversions of listmonk static/email-templates at 6fcd95f.
import campaign from "@/templates/builtins/default.tpl.txt" with { type: "text" };
import archive from "@/templates/builtins/default-archive.tpl.txt" with { type: "text" };
import transactional from "@/templates/builtins/sample-tx.tpl.txt" with { type: "text" };
import campaignStatus from "@/templates/builtins/campaign-status.txt" with { type: "text" };
import importStatus from "@/templates/builtins/import-status.txt" with { type: "text" };
import forgotPassword from "@/templates/builtins/forgot-password.txt" with { type: "text" };
import subscriberData from "@/templates/builtins/subscriber-data.txt" with { type: "text" };
import subscriberOptin from "@/templates/builtins/subscriber-optin.txt" with { type: "text" };
import subscriberOptinCampaign from "@/templates/builtins/subscriber-optin-campaign.txt" with { type: "text" };
import smtpTest from "@/templates/builtins/smtp-test.txt" with { type: "text" };

export const initialTemplates = [
  {
    name: "Default campaign template",
    type: "campaign",
    subject: "",
    body: campaign,
    isDefault: true,
  },
  {
    name: "Default archive template",
    type: "campaign",
    subject: "",
    body: archive,
    isDefault: false,
  },
  {
    name: "Sample transactional template",
    type: "tx",
    subject: "Welcome {{ subscriber.name }}",
    body: transactional,
    isDefault: false,
  },
] as const;
export const systemTemplates = Object.freeze({
  campaignStatus,
  importStatus,
  forgotPassword,
  subscriberData,
  subscriberOptin,
  subscriberOptinCampaign,
  smtpTest,
});
