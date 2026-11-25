// Adapted from listmonk static/admin/views/settings.html and static/admin/partials/settings/*.html
// at 6fcd95f. settings.js reads the masked settings from the API and keeps every key, shown or not,
// in the object it sends back. A setting with no effect here stays in that object and shows as
// unavailable; OIDC stays hidden until it is built. The form has `novalidate`, so the API alone
// decides what is valid: an input rule stricter than the API would refuse a stored value, from a
// tab that is not even showing.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import type { JSONValue } from "@/admin/layout/shell";
import { Alert } from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";
import type { Child } from "@/jsx/render";
import { assetVersion } from "@/server/asset-manifest";
import type { SettingsSide } from "@/settings/keys";

const smtpPresets = [
  ["gmail", "Gmail"],
  ["gmailrelay", "Gmail Relay"],
  ["ses", "Amazon SES"],
  ["azure", "Azure ACS"],
  ["mailgun", "Mailgun"],
  ["mailjet", "Mailjet"],
  ["sendgrid", "Sendgrid"],
  ["postmark", "Postmark"],
  ["forwardemail", "Forward Email"],
  ["lettermint", "Lettermint"],
] as const;

function Hint({ children }: { children?: Child }) {
  return <small data-hint="">{children}</small>;
}
/** A switch bound to `model`. `disabled` is an Alpine expression. */
function Switch(props: { model: string; label: Child; hint?: string; disabled?: string }) {
  const { model, label, hint, disabled } = props;
  return (
    <label data-field="">
      <input
        type="checkbox"
        role="switch"
        x-model={model}
        {...(disabled ? { "x-bind:disabled": disabled } : {})}
      />{" "}
      {label}
      {hint ? <Hint>{hint}</Hint> : null}
    </label>
  );
}
function NumberField(props: {
  model: string;
  label: string;
  hint?: string;
  name?: string;
  min?: string;
  max?: string;
  placeholder?: string;
  disabled?: string;
}) {
  const { model, label, hint, name, min, max, placeholder, disabled } = props;
  return (
    <label data-field="" {...(disabled ? { "x-bind:aria-disabled": disabled } : {})}>
      {label}
      <input
        type="number"
        {...(name ? { name } : {})}
        {...(min ? { min } : {})}
        {...(max ? { max } : {})}
        {...(placeholder ? { placeholder } : {})}
        {...(disabled ? { "x-bind:disabled": disabled } : {})}
        {...{ "x-model.number": model }}
      />
      {hint ? <Hint>{hint}</Hint> : null}
    </label>
  );
}
function TextField(props: {
  model: string;
  label: string;
  hint?: string;
  name?: string;
  type?: string;
  maxlength?: string;
  placeholder?: string;
  disabled?: string;
  class?: string;
}) {
  const { model, label, hint, name, type, maxlength, placeholder, disabled } = props;
  return (
    <label data-field="" {...(disabled ? { "x-bind:aria-disabled": disabled } : {})}>
      {label}
      <input
        {...(type ? { type } : {})}
        {...(name ? { name } : {})}
        {...(maxlength ? { maxlength } : {})}
        {...(placeholder ? { placeholder } : {})}
        {...(disabled ? { "x-bind:disabled": disabled } : {})}
        {...(props.class ? { "x-bind:class": props.class } : {})}
        x-model={model}
      />
      {hint ? <Hint>{hint}</Hint> : null}
    </label>
  );
}
/**
 * Upload or remove a logo or favicon (B129, D127). The file goes to media, and its URL is set in the
 * form; Save stores it. Needs media:manage, so it is shown only to a user who has it.
 */
function ImageUpload({ name, t, canUpload }: { name: string; t: Translation; canUpload: boolean }) {
  if (!canUpload) {
    return null;
  }
  return (
    <div class="hstack gap-3 mb-4">
      <input
        type="file"
        accept="image/*"
        aria-label={t.T("settings.general.uploadImage")}
        name={`${name}.upload`}
        x-on:change={`uploadImage('${name}', $event)`}
      />
      <button type="button" class="small" x-on:click={`clearImage('${name}')`}>
        {t.T("globals.buttons.remove")}
      </button>
    </div>
  );
}
function General({ t, canUpload }: { t: Translation; canUpload: boolean }) {
  return (
    <div class="settings-items">
      <fieldset class="card" data-keywords="site name root url logo favicon branding domain title">
        <legend>{t.T("globals.terms.general")}</legend>
        <TextField
          model="form['app.site_name']"
          name="app.site_name"
          label={t.T("settings.general.siteName")}
          maxlength="300"
        />
        <label data-field="">
          {t.T("settings.general.rootURL")}
          <input name="app.root_url" readonly x-model="form['app.root_url']" />
          <Hint>{t.T("settings.general.rootURLRestart")}</Hint>
        </label>
        <TextField
          model="form['app.logo_url']"
          name="app.logo_url"
          type="url"
          label={t.T("settings.general.logoURL")}
          hint={t.T("settings.general.logoURLHelp")}
          maxlength="300"
          placeholder="https://mail.yoursite.com/logo.png"
        />
        <ImageUpload name="app.logo_url" t={t} canUpload={canUpload} />
        <TextField
          model="form['app.favicon_url']"
          name="app.favicon_url"
          type="url"
          label={t.T("settings.general.faviconURL")}
          hint={t.T("settings.general.faviconURLHelp")}
          maxlength="300"
          placeholder="https://mail.yoursite.com/favicon.png"
        />
        <ImageUpload name="app.favicon_url" t={t} canUpload={canUpload} />
        <TextField
          model="form['app.site_url']"
          name="app.site_url"
          type="url"
          label={t.T("settings.general.siteURL")}
          hint={t.T("settings.general.siteURLHelp")}
          maxlength="300"
          placeholder="https://www.yoursite.com"
        />
      </fieldset>
      <fieldset class="card" data-keywords="from email address sender admin notification emails">
        <legend>{t.T("globals.fields.email")}</legend>
        <label data-field="">
          {t.T("settings.general.fromEmail")}
          <textarea
            name="app.from_email"
            rows="4"
            placeholder="Mailing list <noreply@mail.yoursite.com>"
            x-model="form['app.from_email']"
          ></textarea>
          <Hint>{t.T("settings.general.fromEmailHelp")}</Hint>
        </label>
        <TextField
          model="form['app.notify_emails']"
          name="app.notify_emails"
          label={t.T("settings.general.adminNotifEmails")}
          hint={t.T("settings.general.adminNotifEmailsHelp")}
          placeholder="you@yoursite.com"
        />
      </fieldset>
      <fieldset
        class="card"
        data-keywords="subscription public page opt-in optin confirmation double signup"
      >
        <legend>{t.T("globals.terms.subscriptions")}</legend>
        <Switch
          model="form['app.enable_public_subscription_page']"
          label={t.T("settings.general.enablePublicSubPage")}
          hint={t.T("settings.general.enablePublicSubPageHelp")}
        />
        <Switch
          model="form['app.send_optin_confirmation']"
          label={t.T("subscribers.sendOptinConfirm")}
          hint={t.T("settings.general.sendOptinConfirmHelp")}
        />
        <Switch
          model="form['app.show_optin_page']"
          label={t.T("settings.general.showOptinPage")}
          hint={t.T("settings.general.showOptinPageHelp")}
        />
      </fieldset>
      <fieldset class="card" data-keywords="public archive rss feed campaigns">
        <legend>{t.T("globals.terms.archive")}</legend>
        <Switch
          model="form['app.enable_public_archive']"
          label={t.T("settings.general.enablePublicArchive")}
          hint={t.T("settings.general.enablePublicArchiveHelp")}
        />
        <Switch
          model="form['app.enable_public_archive_rss_content']"
          label={t.T("settings.general.enablePublicArchiveRSSContent")}
          hint={t.T("settings.general.enablePublicArchiveRSSContentHelp")}
        />
      </fieldset>
    </div>
  );
}

/**
 * The instance's SES account as the Settings page shows it beside the send rate (B145b): whether
 * the API keys are saved, and SES's `MaxSendRate` from the latest snapshot (null before a read).
 */
export interface SesRateLine {
  readonly configured: boolean;
  readonly maxSendRate: number | null;
  /** The saved `messaging.max_send_rate`, so the page renders the right line before Alpine starts. */
  readonly setting: number;
}

/**
 * The line beside `messaging.max_send_rate` (14-projects section 7, "Rate"): SES's rate, and a
 * warning while the setting is higher, which then caps nothing. The warning follows the field as
 * it is edited; SES's rate is the snapshot's when the page was rendered.
 */
function SesRate({ ses }: { ses: SesRateLine }) {
  if (!ses.configured) {
    return (
      <p class="text-light" data-testid="ses-rate">
        No SES API credentials are saved: the setting alone applies, with no capacity forecast and
        no quota guard.
      </p>
    );
  }
  if (ses.maxSendRate === null) {
    return (
      <p class="text-light" data-testid="ses-rate">
        The rate SES allows is not read yet: the setting alone applies until it is.
      </p>
    );
  }
  const rate = String(ses.maxSendRate);
  // `0` is no cap, not a rate above SES's (B149a, D164): it has its own wording. Both follow the
  // field; the server renders the saved value's state so the page is right before Alpine starts.
  // `x-model.number` keeps it a number, and an emptied field is `""`, which is above nothing: only
  // a number above SES's rate warns. Alpine's CSP build has no `Number()` to call.
  const field = "form['messaging.max_send_rate']";
  const unpaced = `${field} === 0`;
  const higher = `${field} > ${rate}`;
  const saved = ses.setting;
  const hidden = { style: "display: none" };
  return (
    <div data-testid="ses-rate">
      <p class="text-light">SES allows {rate}/s. Sending runs at the lower of the two.</p>
      <p
        data-testid="ses-rate-warning"
        x-show={higher}
        role="alert"
        {...(saved > ses.maxSendRate ? {} : hidden)}
      >
        The setting is higher than the rate SES allows: sending runs at {rate}/s.
      </p>
      <p
        data-testid="ses-rate-unpaced"
        x-show={unpaced}
        role="alert"
        {...(saved === 0 ? {} : hidden)}
      >
        The setting is 0, no cap of its own: sending runs at the rate SES allows, {rate}/s.
      </p>
    </div>
  );
}

function Performance({
  t,
  side,
  ses,
}: {
  t: Translation;
  side: SettingsSide;
  ses?: SesRateLine | undefined;
}) {
  const instance = side === "instance";
  const cacheOff = "!form['app.cache_slow_queries']";
  return (
    <div class="settings-items">
      <fieldset
        class="card"
        data-keywords="performance send rate errors threshold throughput sending speed"
      >
        <legend>{t.T("globals.terms.performance")}</legend>
        {instance ? (
          <NumberField
            model="form['messaging.max_send_rate']"
            name="messaging.max_send_rate"
            label={t.T("settings.performance.maxSendRate")}
            hint={t.T("settings.performance.maxSendRateHelp")}
            min="0"
            max="10000"
            placeholder="14"
          />
        ) : null}
        {instance && ses ? <SesRate ses={ses} /> : null}
        {instance ? null : (
          <NumberField
            model="form['app.max_send_errors']"
            name="app.max_send_errors"
            label={t.T("settings.performance.maxErrThreshold")}
            hint={t.T("settings.performance.maxErrThresholdHelp")}
            min="0"
            max="100000"
            placeholder="1999"
          />
        )}
      </fieldset>
      {instance ? null : (
        <fieldset
          class="card"
          data-keywords="marketing frequency cap minimum interval sends subscriber"
        >
          <legend>{t.T("settings.marketing.title")}</legend>
          <TextField
            model="form['marketing.min_interval']"
            name="marketing.min_interval"
            label={t.T("settings.marketing.minInterval")}
            hint={t.T("settings.marketing.minIntervalHelp")}
            placeholder="P7D"
          />
        </fieldset>
      )}
      {instance ? (
        <fieldset
          class="card"
          data-keywords="cache slow queries dashboard cron interval materialized stats"
        >
          <legend>{t.T("settings.performance.cacheSlowQueries")}</legend>
          <Switch
            model="form['app.cache_slow_queries']"
            label={t.T("globals.buttons.enable")}
            hint={t.T("settings.performance.cacheSlowQueriesHelp")}
          />
          <TextField
            model="form['app.cache_slow_queries_interval']"
            label={t.T("settings.maintenance.cron")}
            placeholder="0 3 * * *"
            disabled={cacheOff}
          />
        </fieldset>
      ) : null}
    </div>
  );
}

function Privacy({ t }: { t: Translation }) {
  return (
    <div class="settings-items">
      <fieldset
        class="card"
        data-keywords="privacy tracking open click individual subscriber opt-in ip analytics one-click unsubscribe header"
      >
        <legend>{t.T("globals.terms.privacy")}</legend>
        <Switch
          model="form['privacy.disable_tracking']"
          label={t.T("settings.privacy.disableTracking")}
          hint={t.T("settings.privacy.disableTrackingHelp")}
        />
        <Switch
          model="form['privacy.individual_tracking']"
          label={t.T("settings.privacy.individualSubTracking")}
          hint={t.T("settings.privacy.individualSubTrackingHelp")}
          disabled="form['privacy.disable_tracking']"
        />
        <Switch
          model="form['privacy.record_optin_ip']"
          label={t.T("settings.privacy.recordOptinIP")}
          hint={t.T("settings.privacy.recordOptinIPHelp")}
        />
        <Switch
          model="form['privacy.unsubscribe_header']"
          label={t.T("settings.privacy.listUnsubHeader")}
          hint={t.T("settings.privacy.listUnsubHeaderHelp")}
        />
      </fieldset>
      <fieldset
        class="card"
        data-keywords="privacy permissions blocklist preferences export wipe gdpr data subscriber rights"
      >
        <legend>{t.T("globals.terms.permissions")}</legend>
        <Switch
          model="form['privacy.allow_blocklist']"
          label={t.T("settings.privacy.allowBlocklist")}
          hint={t.T("settings.privacy.allowBlocklistHelp")}
        />
        <Switch
          model="form['privacy.allow_preferences']"
          label={t.T("settings.privacy.allowPrefs")}
          hint={t.T("settings.privacy.allowPrefsHelp")}
        />
        <Switch
          model="form['privacy.allow_export']"
          label={t.T("settings.privacy.allowExport")}
          hint={t.T("settings.privacy.allowExportHelp")}
        />
        <Switch
          model="form['privacy.allow_wipe']"
          label={t.T("settings.privacy.allowWipe")}
          hint={t.T("settings.privacy.allowWipeHelp")}
        />
      </fieldset>
      <PreferenceFields t={t} />
      <DomainLists t={t} />
    </div>
  );
}

/**
 * B147 (D160): the preference center's profile fields, `privacy.preference_fields`. Each field names a
 * subscriber attribute, its label and type, whether subscribers may edit it, and its rules.
 */
function PreferenceFields({ t }: { t: Translation }) {
  const notBounded = "item.type !== 'text' && item.type !== 'number'";
  return (
    <fieldset
      class="card preference-fields"
      data-keywords="preference center profile fields attributes manage page subscriber details consent"
    >
      <legend>{t.T("settings.privacy.preferenceFields")}</legend>
      <Hint>{t.T("settings.privacy.preferenceFieldsHelp")}</Hint>
      <template x-for="(item, n) in form['privacy.preference_fields']" x-bind:key="n">
        <div class="repeat-block preference-field">
          <div class="row">
            <div class="col-4">
              <TextField
                model="item.key"
                label={t.T("settings.privacy.fieldKey")}
                maxlength="64"
                placeholder="city"
              />
            </div>
            <div class="col-4">
              <TextField
                model="item.label"
                label={t.T("settings.privacy.fieldLabel")}
                maxlength="200"
              />
            </div>
            <div class="col-4">
              <label data-field="">
                {t.T("settings.privacy.fieldType")}
                <select x-model="item.type">
                  <option value="text">text</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                  <option value="date">date</option>
                  <option value="select">select</option>
                </select>
              </label>
            </div>
          </div>
          <div class="hstack gap-6">
            <Switch model="item.editable" label={t.T("settings.privacy.fieldEditable")} />
            <Switch
              model="item.required"
              label={t.T("settings.privacy.fieldRequired")}
              disabled="item.type === 'boolean'"
            />
          </div>
          <div class="row">
            <div class="col-6">
              <NumberField
                model="item.min"
                label={t.T("settings.privacy.fieldMin")}
                hint={t.T("settings.privacy.fieldMinMaxHelp")}
                disabled={notBounded}
              />
            </div>
            <div class="col-6">
              <NumberField
                model="item.max"
                label={t.T("settings.privacy.fieldMax")}
                disabled={notBounded}
              />
            </div>
          </div>
          <label data-field="" x-show="item.type === 'select'">
            {t.T("settings.privacy.fieldOptions")}
            <textarea rows="4" x-model="item.strOptions"></textarea>
            <Hint>{t.T("settings.privacy.fieldOptionsHelp")}</Hint>
          </label>
          <button
            type="button"
            class="outline small"
            data-variant="danger"
            x-on:click="removePreferenceField(n)"
          >
            <Icon name="trash-2" /> {t.T("globals.buttons.delete")}
          </button>
        </div>
      </template>
      <p>
        <button type="button" class="outline small" x-on:click="addPreferenceField">
          <Icon name="plus" /> {t.T("globals.buttons.addNew")}
        </button>
      </p>
    </fieldset>
  );
}

function DomainLists({ t }: { t: Translation }) {
  return (
    <>
      <hr />
      <fieldset
        class="card"
        data-keywords="domain blocklist allowlist email address filter block allow deny"
      >
        <legend>{t.T("settings.privacy.domainBlocklist")}</legend>
        <ot-tabs class="settings-subtabs">
          <div role="tablist">
            <button type="button" role="tab">
              <span>
                {t.T("settings.privacy.domainBlocklist")} (
                <span x-text="countLines(form['privacy.domain_blocklist'])"></span>)
              </span>
            </button>
            <button type="button" role="tab">
              <span>
                {t.T("settings.privacy.domainAllowlist")} (
                <span x-text="countLines(form['privacy.domain_allowlist'])"></span>)
              </span>
            </button>
          </div>
          <div role="tabpanel">
            <label data-field="">
              <textarea rows="8" x-model="form['privacy.domain_blocklist']"></textarea>
              <Hint>{t.T("settings.privacy.domainBlocklistHelp")}</Hint>
            </label>
          </div>
          <div role="tabpanel">
            <label data-field="">
              <textarea rows="8" x-model="form['privacy.domain_allowlist']"></textarea>
              <Hint>{t.T("settings.privacy.domainAllowlistHelp")}</Hint>
            </label>
          </div>
        </ot-tabs>
      </fieldset>
    </>
  );
}

const budget = (key: string, label: string) => (
  <NumberField
    model={`form['security.public_rate_limit'].${key}`}
    label={label}
    min="1"
    max="1000000"
  />
);
function Security({ t, side }: { t: Translation; side: SettingsSide }) {
  if (side === "instance") {
    return (
      <div class="settings-items">
        <fieldset class="card" data-keywords="login session duration expiry timeout">
          <legend>{t.T("globals.buttons.login")}</legend>
          <TextField
            model="form['security.session_duration']"
            label={t.T("globals.fields.sessionDuration")}
            placeholder="7d"
          />
        </fieldset>
        <fieldset
          class="card"
          data-keywords="trusted proxies proxy forwarded x-forwarded-for client ip"
        >
          <legend>{t.T("settings.security.trustedProxies")}</legend>
          <label data-field="">
            <textarea
              rows="3"
              name="security.trusted_proxies"
              placeholder="127.0.0.1"
              x-model="form['security.trusted_proxies']"
            ></textarea>
            <Hint>{t.T("settings.security.trustedProxiesHelp")}</Hint>
          </label>
        </fieldset>
        <fieldset
          class="card"
          data-keywords="webhook private addresses block ssrf internal network"
        >
          <legend>{t.T("settings.security.webhooks")}</legend>
          <Switch
            model="form['webhooks.block_private_addresses']"
            label={t.T("settings.security.blockPrivateAddresses")}
            hint={t.T("settings.security.blockPrivateAddressesHelp")}
          />
        </fieldset>
      </div>
    );
  }
  return (
    <div class="settings-items">
      <fieldset
        class="card"
        data-keywords="trusted urls cors cross-origin api access allowed hosts"
      >
        <legend>{t.T("settings.security.trustedURLs")} / CORS</legend>
        <label data-field="">
          <textarea
            rows="5"
            placeholder="https://example.com"
            x-model="form['security.trusted_urls']"
          ></textarea>
          <Hint>{t.T("settings.security.trustedURLsHelp")}</Hint>
        </label>
      </fieldset>
      <fieldset
        class="card"
        data-keywords="public rate limit subscribe opt-in unsubscribe privacy budget"
      >
        <legend>{t.T("settings.security.publicRateLimit")}</legend>
        <p class="text-light">{t.T("settings.security.publicRateLimitHelp")}</p>
        {budget("subscribe", t.T("globals.buttons.subscribe"))}
        {budget("optin", t.T("lists.optin"))}
        {budget("unsubscribe", t.T("globals.buttons.unsubscribe"))}
        {budget("privacy", t.T("globals.terms.privacy"))}
      </fieldset>
      <fieldset
        class="card"
        data-keywords="captcha altcha hcaptcha spam bot protection public form verification"
      >
        <legend>{t.T("settings.security.enableCaptcha")}</legend>
        <Switch
          model="captchaEnabled"
          label={t.T("globals.buttons.enable")}
          hint={t.T("settings.security.enableCaptchaHelp")}
        />
        <template x-if="captchaEnabled">
          <div class="mt-4">
            <div data-field="" class="hstack" data-testid="captcha-provider">
              <label>
                <input
                  type="radio"
                  value="altcha"
                  name="captcha_provider"
                  x-model="captchaProvider"
                />{" "}
                ALTCHA
              </label>
              <label>
                <input
                  type="radio"
                  value="hcaptcha"
                  name="captcha_provider"
                  x-model="captchaProvider"
                />{" "}
                hCaptcha (deprecated)
              </label>
            </div>
            <div x-show="captchaProvider === 'altcha'">
              <NumberField
                model="form['security.captcha'].altcha.complexity"
                label={t.T("settings.security.altchaComplexity")}
                hint={t.T("settings.security.altchaComplexityHelp")}
                min="1000"
                max="1000000"
              />
            </div>
            <div x-show="captchaProvider === 'hcaptcha'">
              <TextField
                model="form['security.captcha'].hcaptcha.key"
                label={t.T("settings.security.captchaKey")}
                hint={t.T("settings.security.captchaKeyHelp")}
                maxlength="200"
              />
              <TextField
                model="form['security.captcha'].hcaptcha.secret"
                label={t.T("settings.security.captchaSecret")}
                type="password"
                maxlength="200"
              />
            </div>
          </div>
        </template>
      </fieldset>
    </div>
  );
}

function Media({ t, side }: { t: Translation; side: SettingsSide }) {
  if (side === "instance") {
    return (
      <div class="settings-items">
        <fieldset class="card" data-keywords="upload media storage provider">
          <legend>{t.T("settings.media.title")}</legend>
          <label data-field="">
            {t.T("globals.fields.provider")}
            <input name="upload.provider" readonly x-model="form['upload.provider']" />
          </label>
        </fieldset>
      </div>
    );
  }
  return (
    <div class="settings-items">
      <fieldset
        class="card"
        data-keywords="upload file extensions media attachments allowed types images"
      >
        <legend>{t.T("settings.media.upload.extensions")}</legend>
        <ot-taginput x-model="form['upload.extensions']">
          <input placeholder="jpg, png, gif .." />
        </ot-taginput>
      </fieldset>
      <fieldset
        class="card"
        data-keywords="filesystem local upload path uri directory disk provider"
      >
        <legend>filesystem</legend>
        <TextField
          model="form['upload.filesystem.upload_path']"
          label={t.T("settings.media.upload.path")}
          hint={t.T("settings.media.upload.pathBoundary")}
          maxlength="200"
          placeholder="uploads"
        />
        <TextField
          model="form['upload.filesystem.upload_uri']"
          label={t.T("settings.media.upload.uri")}
          hint={t.T("settings.media.upload.uriHelp")}
          maxlength="200"
          placeholder="/uploads"
        />
      </fieldset>
    </div>
  );
}

function SmtpTest({ t }: { t: Translation }) {
  return (
    <template x-if="smtpTestItem === n">
      <fieldset class="card mb-8 mt-8">
        <p>
          <strong>{t.T("settings.general.fromEmail")}</strong>: the default address of the primary
          project
        </p>
        <fieldset class="group">
          <legend>{t.T("settings.smtp.toEmail")}</legend>
          <input
            type="email"
            required
            placeholder="email@site.com"
            x-bind:class="'test-email-' + n"
            x-model="testEmail"
          />
          <button
            type="button"
            data-variant="primary"
            x-bind:disabled="isLoading('settings.testSMTP')"
            {...{ "x-on:click.prevent": "doSMTPTest(item, n)" }}
          >
            {t.T("settings.smtp.sendTest")}
          </button>
        </fieldset>
        <template x-if="errMsg">
          <label data-field="">
            <textarea readonly rows="4" x-model="errMsg"></textarea>
          </label>
        </template>
      </fieldset>
    </template>
  );
}
function Smtp({ t, canManage }: { t: Translation; canManage: boolean }) {
  const off = "!item.enabled";
  const none = "item.auth_protocol === 'none'";
  return (
    <>
      <div
        class="mb-6 settings-items mail-servers"
        data-keywords="smtp mail server outgoing email sending host port tls authentication login relay gmail ses sendgrid mailgun postmark from headers"
      >
        <template x-for="(item, n) in form.smtp" x-bind:key="n">
          <details
            class="repeat-block"
            x-bind:open="item.open"
            x-on:toggle="setOpen('smtp', n, $event.target.open)"
          >
            <summary>
              <div class="row">
                <div class="col-5">
                  <div class="hstack">
                    <span class="text-light" x-text="'#' + (n + 1)"></span>
                    <span
                      class="text-light"
                      x-show="item.name || item.host"
                      x-text="item.name || item.host"
                    ></span>
                  </div>
                </div>
                <div class="col-7 col-end">
                  <div class="hstack gap-6 justify-end">
                    <label data-field="" {...{ "x-on:click.stop": "" }}>
                      <input type="checkbox" role="switch" x-model="item.enabled" />{" "}
                      {t.T("globals.terms.enabled")}
                    </label>
                    {canManage ? (
                      <button
                        type="button"
                        class="outline small"
                        x-bind:disabled="!item.enabled"
                        {...{ "x-on:click.stop.prevent": "showSMTPTest(n)" }}
                      >
                        <Icon name="send" /> {t.T("globals.buttons.testConnection")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      class="outline small"
                      x-show="form.smtp.length > 1"
                      data-variant="danger"
                      {...{ "x-on:click.stop.prevent": "removeSMTP(n)" }}
                    >
                      <Icon name="trash-2" /> {t.T("globals.buttons.delete")}
                    </button>
                  </div>
                </div>
              </div>
            </summary>
            <div class="accordion-body">
              <SmtpTest t={t} />
              <div>
                <fieldset class="card" x-bind:disabled={off}>
                  <legend>{t.T("globals.fields.host")}</legend>
                  <div class="row">
                    <div class="col-9">
                      <TextField
                        model="item.host"
                        label={t.T("globals.fields.host")}
                        hint={t.T("settings.mailserver.hostHelp")}
                        maxlength="200"
                        placeholder="smtp.yourmailserver.net"
                      />
                    </div>
                    <div class="col-3">
                      <NumberField
                        model="item.port"
                        label={t.T("globals.fields.port")}
                        hint={t.T("settings.mailserver.portHelp")}
                        min="1"
                        max="65535"
                        placeholder="25"
                      />
                    </div>
                  </div>
                  <div class="hstack text-8">
                    {smtpPresets.map(([key, label]) => (
                      <a href="#" {...{ "x-on:click.prevent": `fillSMTP(n, '${key}')` }}>
                        {label}
                      </a>
                    ))}
                  </div>
                </fieldset>
                {/* B56: not disabled as a whole, so the password can be typed while the server is off. */}
                <fieldset class="card">
                  <legend>{t.T("globals.fields.authProtocol")}</legend>
                  <div data-field="">
                    <label>{t.T("globals.fields.authProtocol")}</label>
                    <select x-model="item.auth_protocol" x-bind:disabled={off}>
                      <option value="login">LOGIN</option>
                      <option value="cram">CRAM</option>
                      <option value="plain">PLAIN</option>
                      <option value="none">None</option>
                    </select>
                  </div>
                  <TextField
                    model="item.username"
                    label={t.T("globals.fields.username")}
                    maxlength="200"
                    placeholder="mysmtp"
                    class="'smtp-username-' + n"
                    disabled={`${off} || ${none}`}
                  />
                  <TextField
                    model="item.password"
                    type="password"
                    label={t.T("globals.fields.password")}
                    hint={t.T("globals.messages.passwordChange")}
                    maxlength="200"
                    class="'smtp-password-' + n"
                    disabled={none}
                  />
                </fieldset>
                <fieldset class="card" x-bind:disabled={off}>
                  <legend>{t.T("settings.mailserver.tls")}</legend>
                  <TextField
                    model="item.hello_hostname"
                    label={t.T("settings.smtp.heloHost")}
                    hint={t.T("settings.smtp.heloHostHelp")}
                    maxlength="200"
                  />
                  <div class="row">
                    <div class="col-7">
                      <div data-field="">
                        <label>{t.T("settings.mailserver.tls")}</label>
                        <select x-model="item.tls_type">
                          <option value="none">{t.T("globals.states.off")}</option>
                          <option value="STARTTLS">STARTTLS</option>
                          <option value="TLS">SSL/TLS</option>
                        </select>
                        <Hint>{t.T("settings.mailserver.tlsHelp")}</Hint>
                      </div>
                    </div>
                    <div class="col-5" x-bind:aria-disabled="item.tls_type === 'none'">
                      <div data-field="">
                        <label class="mb-2">{t.T("settings.mailserver.skipTLS")}</label>
                        <input
                          type="checkbox"
                          role="switch"
                          x-bind:disabled="item.tls_type === 'none'"
                          x-model="item.tls_skip_verify"
                        />
                        <Hint>{t.T("settings.mailserver.skipTLSHelp")}</Hint>
                      </div>
                    </div>
                  </div>
                </fieldset>
                <fieldset class="card" x-bind:disabled={off}>
                  <legend>{t.T("globals.terms.connection")}</legend>
                  <NumberField
                    model="item.max_conns"
                    label={t.T("globals.fields.maxConns")}
                    hint={t.T("settings.mailserver.maxConnsHelp")}
                    min="1"
                    max="65535"
                    placeholder="25"
                  />
                  <TextField
                    model="item.idle_timeout"
                    label={t.T("globals.fields.idleTimeout")}
                    hint={t.T("settings.mailserver.idleTimeoutHelp")}
                    maxlength="10"
                    placeholder="15s"
                  />
                  <TextField
                    model="item.wait_timeout"
                    label={t.T("globals.fields.waitTimeout")}
                    hint={t.T("settings.mailserver.waitTimeoutHelp")}
                    maxlength="10"
                    placeholder="5s"
                  />
                </fieldset>
                <fieldset class="card" x-bind:disabled={off}>
                  <legend>{t.T("globals.fields.name")}</legend>
                  <TextField
                    model="item.name"
                    label={t.T("globals.fields.name")}
                    hint={t.T("settings.mailserver.nameHelp")}
                    maxlength="100"
                    placeholder="email-primary"
                  />
                  <label data-field="">
                    {t.T("settings.smtp.fromAddresses")}
                    <ot-taginput x-model="item.from_addresses">
                      <input placeholder="user@example.com, anothersite.com" />
                    </ot-taginput>
                    <Hint>{t.T("settings.smtp.fromAddressesHelp")}</Hint>
                  </label>
                  <label data-field="">
                    <input
                      type="checkbox"
                      role="switch"
                      x-model="item.exclude_from_default"
                      x-bind:disabled="!item.name"
                      x-effect="clearDefaultExclusion(item)"
                    />{" "}
                    {t.T("settings.smtp.excludeFromDefault")}
                    <Hint>{t.T("settings.smtp.excludeFromDefaultHelp")}</Hint>
                  </label>
                </fieldset>
                {/* B56: the cards above dim through their own disabled fieldsets. Only these lack one, and the
                  password of a disabled server must stay editable, so it is not under an aria-disabled wrapper. */}
                <div x-bind:aria-disabled={off}>
                  <template x-if="(item.strEmailHeaders === '[]') && !item.showHeaders">
                    <p>
                      <a href="#" {...{ "x-on:click.prevent": "item.showHeaders = true" }}>
                        <Icon name="plus" /> {t.T("settings.smtp.setCustomHeaders")}
                      </a>
                    </p>
                  </template>
                  <template x-if="(item.strEmailHeaders !== '[]') || item.showHeaders">
                    <label data-field="">
                      <textarea
                        rows="4"
                        x-model="item.strEmailHeaders"
                        placeholder='[{"X-Custom": "value"}]'
                      ></textarea>
                      <Hint>{t.T("settings.smtp.customHeadersHelp")}</Hint>
                    </label>
                  </template>
                </div>
              </div>
            </div>
          </details>
        </template>
      </div>
      <button type="button" data-variant="primary" class="btn-new" x-on:click="addSMTP">
        <Icon name="plus" /> {t.T("globals.buttons.addNew")}
      </button>
    </>
  );
}

const provider = (model: string, label: string) => <Switch model={model} label={label} />;
function Bounces({ t, side }: { t: Translation; side: SettingsSide }) {
  if (side === "project") {
    return (
      <div class="settings-items">
        <p class="text-light">
          Bounce processing is switched on in the instance settings; these actions apply to the
          subscribers of this project.
        </p>
        {(["soft", "hard", "complaint"] as const).map((type) => (
          <template x-if={`form['bounce.actions'] && form['bounce.actions'].${type}`}>
            <fieldset
              class="card"
              data-keywords={`bounce ${type} action count threshold unsubscribe blocklist delete`}
            >
              <legend>{t.T(`bounces.${type}`)}</legend>
              <div class="row">
                <div class="col-6">
                  <NumberField
                    model={`form['bounce.actions'].${type}.count`}
                    label={t.T("settings.bounces.count")}
                    hint={t.T("settings.bounces.countHelp")}
                    min="1"
                    max="1000"
                    placeholder="3"
                  />
                </div>
                <div class="col-6">
                  <div data-field="">
                    <label>{t.T("globals.fields.action")}</label>
                    <select x-model={`form['bounce.actions'].${type}.action`}>
                      <option value="none">{t.T("globals.terms.none")}</option>
                      <option value="unsubscribe">{t.T("globals.buttons.unsubscribe")}</option>
                      <option value="blocklist">{t.T("globals.terms.blocklist")}</option>
                      <option value="delete">{t.T("globals.buttons.delete")}</option>
                    </select>
                  </div>
                </div>
              </div>
            </fieldset>
          </template>
        ))}
      </div>
    );
  }
  return (
    <div class="settings-items">
      <label
        data-field=""
        data-keywords="bounce processing email delivery failures soft hard complaint enable"
      >
        <input type="checkbox" role="switch" x-model="form['bounce.enabled']" />{" "}
        {t.T("settings.bounces.enable")}
      </label>
      <template x-if="form['bounce.enabled']">
        <div class="settings-items">
          <label data-field="" data-keywords="bounce webhook notifications endpoint enable">
            <input type="checkbox" role="switch" x-model="form['bounce.webhooks_enabled']" />{" "}
            {t.T("settings.bounces.enableWebhooks")}
          </label>
          <template x-if="form['bounce.webhooks_enabled']">
            <fieldset class="card" data-keywords="bounce ses amazon sns webhook">
              <legend>{t.T("settings.bounces.enableSES")}</legend>
              {provider("form['bounce.ses_enabled']", t.T("globals.buttons.enable"))}
              <template x-if="form['bounce.ses_enabled']">
                <label data-field="">
                  {t.T("settings.bounces.sesTopics")}
                  <textarea
                    rows="3"
                    name="bounce.ses_topic_arns"
                    placeholder="arn:aws:sns:eu-west-1:123456789012:ses-bounces"
                    x-model="form['bounce.ses_topic_arns']"
                  ></textarea>
                  <Hint>{t.T("settings.bounces.sesTopicsHelp")}</Hint>
                </label>
              </template>
            </fieldset>
          </template>
        </div>
      </template>
    </div>
  );
}

/**
 * The SES account's API access (B139, D154): stored and masked. The capacity forecast reads the
 * account with it (B145a); "Check SES account" reads it now with the saved keys.
 */
function Ses() {
  return (
    <div class="settings-items">
      <fieldset class="card" data-keywords="ses amazon aws api access key secret region account">
        <legend>Amazon SES API</legend>
        <p class="text-light">
          API access to the SES account, for an IAM user allowed only ses:GetAccount. Set all three
          or none. A saved secret stays masked; leave it as it is to keep it. Without them there is
          no capacity forecast.
        </p>
        <TextField
          model="form['ses.api_region']"
          name="ses.api_region"
          label="Region"
          placeholder="eu-west-1"
          maxlength="40"
        />
        <TextField
          model="form['ses.api_access_key_id']"
          name="ses.api_access_key_id"
          label="Access key ID"
          placeholder="AKIA…"
          maxlength="128"
        />
        <TextField
          model="form['ses.api_secret_access_key']"
          name="ses.api_secret_access_key"
          label="Secret access key"
          type="password"
          maxlength="128"
        />
        <div class="hstack">
          <button
            type="button"
            data-testid="ses-check"
            x-bind:disabled="isLoading('settings.checkSES')"
            {...{ "x-on:click.prevent": "doSESCheck()" }}
          >
            Check SES account
          </button>
          <span class="text-light">Reads the account with the saved keys.</span>
        </div>
        <template x-if="sesCheck">
          <div data-testid="ses-check-result">
            <template x-if="sesCheckError">
              <p data-testid="ses-check-error" x-text="sesCheckError"></p>
            </template>
            <ul>
              <template x-for="line in sesCheckLines">
                <li x-text="line"></li>
              </template>
            </ul>
          </div>
        </template>
      </fieldset>
    </div>
  );
}

const editor = (key: string, lang: string, legend: string, keywords: string) => (
  <fieldset class="card" data-keywords={keywords}>
    <legend>{legend}</legend>
    <code-editor
      lang={lang}
      x-init={`setValue($el, form['appearance.${key}'])`}
      x-on:input={`form['appearance.${key}'] = $event.target.value`}
    ></code-editor>
  </fieldset>
);
/** The brand of the public pages and the subscriber mail (B129, D127), validated when saved. */
function Brand({ t }: { t: Translation }) {
  return (
    <fieldset
      class="card"
      data-keywords="brand accent colour color font header logo name public pages mail"
    >
      <legend>{t.T("settings.brand.title")}</legend>
      <TextField
        model="form['appearance.brand.accent']"
        name="appearance.brand.accent"
        label={t.T("settings.brand.accent")}
        hint={t.T("settings.brand.accentHelp")}
        maxlength="7"
        placeholder="#0055d4"
      />
      <TextField
        model="form['appearance.brand.font']"
        name="appearance.brand.font"
        label={t.T("settings.brand.font")}
        hint={t.T("settings.brand.fontHelp")}
        maxlength="60"
        placeholder="system-sans"
      />
      <label data-field="">
        {t.T("settings.brand.header")}
        <select name="appearance.brand.header" x-model="form['appearance.brand.header']">
          <option value="auto">{t.T("settings.brand.headerAuto")}</option>
          <option value="logo">{t.T("settings.brand.headerLogo")}</option>
          <option value="name">{t.T("settings.brand.headerName")}</option>
          <option value="logo_and_name">{t.T("settings.brand.headerLogoName")}</option>
        </select>
        <Hint>{t.T("settings.brand.headerHelp")}</Hint>
      </label>
    </fieldset>
  );
}
function Appearance({ t, side }: { t: Translation; side: SettingsSide }) {
  const css = t.T("settings.appearance.customCSS");
  const js = t.T("settings.appearance.customJS");
  return (
    <div class="settings-items">
      {side === "instance" ? (
        <>
          <div role="alert" data-testid="appearance-warning">
            {t.T("settings.appearance.warning")}
          </div>
          <p class="text-light">{t.T("settings.appearance.adminHelp")}</p>
          {editor("admin.custom_css", "css", css, "appearance admin custom css style theme ui")}
          {editor(
            "admin.custom_js",
            "javascript",
            js,
            "appearance admin custom javascript js script ui",
          )}
        </>
      ) : (
        <>
          <p class="text-light">{t.T("settings.appearance.publicHelp")}</p>
          <Brand t={t} />
          {editor(
            "public.custom_css",
            "css",
            css,
            "appearance public custom css style theme subscription page",
          )}
          {editor(
            "public.custom_js",
            "javascript",
            js,
            "appearance public custom javascript js script subscription page",
          )}
        </>
      )}
    </div>
  );
}

export interface SettingsPage {
  readonly title: string;
  readonly script: string;
  readonly config: Readonly<Record<string, JSONValue>>;
  readonly translationKeys: ReadonlyArray<string>;
  readonly body: Child;
}

/**
 * One side's Settings page (B139, D154): a project's shows its project keys with a link to the
 * instance settings; the instance's shows the instance keys. A tab with no key on a side is left out.
 */
export function settingsPage(
  t: Translation,
  side: SettingsSide,
  options: {
    canManage: boolean;
    canUpload: boolean;
    instanceSettingsUrl?: string;
    /** The instance side's SES rate line (B145b). */
    ses?: SesRateLine | undefined;
  },
): SettingsPage {
  const { canManage } = options;
  const project = side === "project";
  const tabs: Array<readonly [string, string, Child]> = project
    ? [
        // A logo or favicon upload is a media write and then a settings save, so both permissions
        // are needed; without the media one the file would land in the library and never be used.
        ["general", t.T("globals.terms.general"), <General t={t} canUpload={options.canUpload} />],
        ["performance", t.T("globals.terms.performance"), <Performance t={t} side={side} />],
        ["privacy", t.T("globals.terms.privacy"), <Privacy t={t} />],
        ["security", t.T("globals.terms.security"), <Security t={t} side={side} />],
        ["media", t.T("settings.media.title"), <Media t={t} side={side} />],
        ["bounces", t.T("globals.terms.bounces"), <Bounces t={t} side={side} />],
        ["appearance", t.T("globals.terms.appearance"), <Appearance t={t} side={side} />],
      ]
    : [
        [
          "performance",
          t.T("globals.terms.performance"),
          <Performance t={t} side={side} ses={options.ses} />,
        ],
        ["security", t.T("globals.terms.security"), <Security t={t} side={side} />],
        ["media", t.T("settings.media.title"), <Media t={t} side={side} />],
        ["smtp", t.T("settings.smtp.name"), <Smtp t={t} canManage={canManage} />],
        ["bounces", t.T("globals.terms.bounces"), <Bounces t={t} side={side} />],
        ["ses", "Amazon SES", <Ses />],
        ["appearance", t.T("globals.terms.appearance"), <Appearance t={t} side={side} />],
      ];
  const title = project ? t.T("globals.terms.settings") : "Instance settings";
  return {
    title,
    script: "settings",
    config: { can_manage: canManage, settings_side: side },
    translationKeys: [
      "campaigns.testSent",
      "globals.fields.customHeaders",
      "globals.messages.invalidFields",
      "globals.messages.passwordChangeFull",
      "globals.messages.updated",
      "globals.terms.settings",
      "settings.smtp.passwordRequired",
      "settings.smtp.testEnterEmail",
    ],
    body: (
      <>
        <form
          class="settings"
          novalidate
          x-data="settingsView"
          data-testid={`settings-${side}`}
          {...{ "x-on:submit.prevent": "onSubmit" }}
        >
          <header class="row page-header">
            <div class="col-4">
              <h1 class="page-title">{title}</h1>
              {options.instanceSettingsUrl ? (
                <a
                  href={options.instanceSettingsUrl}
                  class="text-light"
                  data-testid="instance-settings-link"
                >
                  Instance settings
                </a>
              ) : null}
            </div>
            <div class="col-8 hstack justify-end buttons">
              <div class="search-form settings-search">
                <fieldset class="group">
                  <input
                    type="search"
                    x-ref="search"
                    x-on:input="onSearch($event)"
                    aria-label={t.T("globals.buttons.search")}
                    placeholder={t.T("globals.buttons.search")}
                  />
                  <button
                    type="button"
                    class="outline external"
                    aria-label={t.T("globals.buttons.search")}
                    {...{ "x-on:click.prevent": "clearSearch" }}
                  >
                    <Icon name="search" />
                  </button>
                </fieldset>
              </div>
              {canManage ? (
                <button
                  type="submit"
                  data-variant="primary"
                  data-spinner="small"
                  x-bind:aria-busy="isLoading('settings')"
                  x-bind:disabled="isLoading('settings') || !form"
                >
                  <Icon name="save" /> {t.T("globals.buttons.save")}
                </button>
              ) : null}
            </div>
          </header>
          <Alert name="error" />
          <div class="page-content">
            <template x-if="form">
              <ot-tabs class="settings-tabs" x-ref="tabs" data-anchor="tab">
                <div
                  class="settings-sidebar"
                  role="tablist"
                  aria-orientation="vertical"
                  x-on:click="onTabClick($event)"
                  x-on:keydown="onTabKeydown($event)"
                >
                  {tabs.map(([id, label]) => (
                    <button type="button" role="tab" id={id}>
                      {label}
                    </button>
                  ))}
                </div>
                {tabs.map(([, , panel]) => (
                  <div role="tabpanel">{panel}</div>
                ))}
              </ot-tabs>
            </template>
          </div>
        </form>
        <script
          type="module"
          src={`/admin/static/js/code-editor.js?v=${assetVersion}`}
          defer
        ></script>
      </>
    ),
  };
}

export const settingsView: AdminView = ({ context, can, site }) => {
  const options: Parameters<typeof settingsPage>[2] = {
    canManage: can("settings:manage"),
    canUpload: can("settings:manage") && can("media:manage"),
  };
  if (site.instanceUrl) {
    options.instanceSettingsUrl = `${site.instanceUrl.replace(/\/+$/, "")}/admin/instance/settings`;
  }
  const page = settingsPage(context.app.i18n, "project", options);
  return { ...page, pageId: "settings.all", translationKeys: [...page.translationKeys] };
};
