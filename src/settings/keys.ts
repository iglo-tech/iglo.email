// The settings split (14-projects section 4, B139, D154). Native: listmonk has one settings table.
// An instance key describes the server, the SES account, sending capacity or the operator, and is
// stored once in instance.db; a project key describes an audience, a brand, consent, content or
// public pages, and is stored in each project's database. `app.root_url` is neither: it is derived
// from the project's hostname and read-only (D14), so it is served with the project keys.
import { defaults } from "@/settings/defaults";
import type { Settings } from "@/settings/validate";

export type SettingsSide = "instance" | "project";
export type SettingKey = keyof typeof defaults;

/** Every default key's side. A key added to `defaults` without a side here does not compile. */
export const settingSides: Readonly<Record<SettingKey, SettingsSide>> = {
  "app.site_name": "project",
  "app.site_url": "project",
  "app.favicon_url": "project",
  "app.from_email": "project",
  "app.logo_url": "project",
  "app.max_send_errors": "project",
  "app.cache_slow_queries": "instance",
  "app.cache_slow_queries_interval": "instance",
  "app.enable_public_archive": "project",
  "app.enable_public_subscription_page": "project",
  "app.show_optin_page": "project",
  "app.enable_public_archive_rss_content": "project",
  "app.send_optin_confirmation": "project",
  "app.check_updates": "instance",
  "app.notify_emails": "project",
  "app.lang": "project",
  "privacy.individual_tracking": "project",
  "privacy.disable_tracking": "project",
  "privacy.unsubscribe_header": "project",
  "privacy.allow_blocklist": "project",
  "privacy.allow_export": "project",
  "privacy.allow_wipe": "project",
  "privacy.allow_preferences": "project",
  "privacy.preference_fields": "project",
  "privacy.exportable": "project",
  "privacy.domain_blocklist": "project",
  "privacy.domain_allowlist": "project",
  "privacy.record_optin_ip": "project",
  "marketing.min_interval": "project",
  "messaging.max_send_rate": "instance",
  "ses.api_region": "instance",
  "ses.api_access_key_id": "instance",
  "ses.api_secret_access_key": "instance",
  "webhooks.block_private_addresses": "instance",
  "security.captcha": "project",
  "security.oidc": "instance",
  "security.trusted_urls": "project",
  "security.trusted_proxies": "instance",
  "security.public_rate_limit": "project",
  "security.session_duration": "instance",
  "upload.provider": "instance",
  "upload.extensions": "project",
  "upload.filesystem.upload_path": "project",
  "upload.filesystem.upload_uri": "project",
  "upload.s3.url": "instance",
  "upload.s3.public_url": "instance",
  "upload.s3.aws_access_key_id": "instance",
  "upload.s3.aws_secret_access_key": "instance",
  "upload.s3.aws_default_region": "instance",
  "upload.s3.bucket": "instance",
  "upload.s3.bucket_domain": "instance",
  "upload.s3.bucket_path": "instance",
  "upload.s3.bucket_type": "instance",
  "upload.s3.expiry": "instance",
  smtp: "instance",
  // Not in the section 4 table: inert sending channels beside SMTP, so the server's (D154).
  messengers: "instance",
  "bounce.enabled": "instance",
  "bounce.webhooks_enabled": "instance",
  "bounce.actions": "project",
  "bounce.ses_enabled": "instance",
  "bounce.ses_topic_arns": "instance",
  "bounce.azure": "instance",
  "bounce.sendgrid_enabled": "instance",
  "bounce.sendgrid_key": "instance",
  "bounce.postmark": "instance",
  "bounce.forwardemail": "instance",
  "bounce.lettermint": "instance",
  "bounce.mailboxes": "instance",
  "appearance.brand.accent": "project",
  "appearance.brand.font": "project",
  "appearance.brand.header": "project",
  "appearance.admin.custom_css": "instance",
  "appearance.admin.custom_js": "instance",
  "appearance.public.custom_css": "project",
  "appearance.public.custom_js": "project",
  "maintenance.db": "instance",
};

/** Whether `key` names a default setting. */
export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingSides, key);
}

/** The default keys of one side, in `defaults` order. */
export function sideKeys(side: SettingsSide): ReadonlyArray<SettingKey> {
  return Object.keys(defaults)
    .filter(isSettingKey)
    .filter((key) => settingSides[key] === side);
}

export const instanceKeys: ReadonlySet<string> = new Set(sideKeys("instance"));
export const projectKeys: ReadonlySet<string> = new Set(sideKeys("project"));

/** Picks one side's keys from a settings object. */
export function pickSide(value: Settings, side: SettingsSide): Settings {
  const out: Settings = {};
  for (const key of sideKeys(side)) {
    if (Object.hasOwn(value, key)) {
      const item: unknown = value[key];
      out[key] = item;
    }
  }
  return out;
}
