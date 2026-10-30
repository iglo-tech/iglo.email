// The settings public pages read for each request, as listmonk cmd/init.go collects them.
import type { ShellSite } from "@/public/layout";

export interface PublicSettings extends ShellSite {
  siteName: string;
  fromEmail: string;
  sendOptin: boolean;
  showOptinPage: boolean;
  recordOptinIp: boolean;
  rssContent: boolean;
  unsubscribeHeader: boolean;
  allowBlocklist: boolean;
  allowExport: boolean;
  allowWipe: boolean;
  allowPreferences: boolean;
  exportable: string[];
  domainAllowlist: string[];
  domainBlocklist: string[];
  trustedUrls: string[];
  trustedProxies: string[];
  rateLimits: { subscribe: number; optin: number; unsubscribe: number; privacy: number };
  captcha: boolean;
  customCss: string;
  customJs: string;
}

export function publicSettings(current: Record<string, any>): PublicSettings {
  const captcha = current["security.captcha"];
  return {
    rootUrl: current["app.root_url"].replace(/\/+$/, ""),
    logoUrl: current["app.logo_url"],
    faviconUrl: current["app.favicon_url"],
    subscriptionPage: current["app.enable_public_subscription_page"],
    archive: current["app.enable_public_archive"],
    siteName: current["app.site_name"],
    // listmonk getDefaultFromEmail: the first configured address.
    fromEmail: current["app.from_email"][0] ?? "",
    sendOptin: current["app.send_optin_confirmation"],
    showOptinPage: current["app.show_optin_page"],
    recordOptinIp: current["privacy.record_optin_ip"],
    rssContent: current["app.enable_public_archive_rss_content"],
    unsubscribeHeader: current["privacy.unsubscribe_header"],
    allowBlocklist: current["privacy.allow_blocklist"],
    allowExport: current["privacy.allow_export"],
    allowWipe: current["privacy.allow_wipe"],
    allowPreferences: current["privacy.allow_preferences"],
    exportable: current["privacy.exportable"],
    domainAllowlist: current["privacy.domain_allowlist"],
    domainBlocklist: current["privacy.domain_blocklist"],
    trustedUrls: current["security.trusted_urls"],
    trustedProxies: current["security.trusted_proxies"],
    rateLimits: current["security.public_rate_limit"],
    captcha: captcha.altcha.enabled || captcha.hcaptcha.enabled,
    customCss: current["appearance.public.custom_css"],
    customJs: current["appearance.public.custom_js"],
  };
}
