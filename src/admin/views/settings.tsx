// Adapted from listmonk static/admin/views/settings.html and static/admin/partials/settings/*.html
// at 6fcd95f. settings.js reads the masked settings from the API and keeps every key, shown or not,
// in the object it sends back. A setting with no effect here stays in that object and shows as
// unavailable; OIDC stays hidden until it is built. The form has `novalidate`, so the API alone
// decides what is valid: an input rule stricter than the API would refuse a stored value, from a
// tab that is not even showing.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import { Alert } from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";
import type { Child } from "@/jsx/render";
import { assetVersion } from "@/server/asset-manifest";

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
/** Settings that are stored but do nothing in this build: shown, and not editable. */
function Unavailable(props: {
  t: Translation;
  legend: string;
  keywords: string;
  note?: string;
  children: Child;
}) {
  return (
    <fieldset class="card" disabled data-unavailable="" data-keywords={props.keywords}>
      <legend>{props.legend}</legend>
      <p class="text-light">{props.note ?? props.t.T("settings.unavailable")}</p>
      {props.children}
    </fieldset>
  );
}

function General({ t }: { t: Translation }) {
  return (
    <div class="settings-items">
      <fieldset
        class="card"
        data-keywords="site name root url logo favicon language locale branding domain title"
      >
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
        <TextField
          model="form['app.favicon_url']"
          name="app.favicon_url"
          type="url"
          label={t.T("settings.general.faviconURL")}
          hint={t.T("settings.general.faviconURLHelp")}
          maxlength="300"
          placeholder="https://mail.yoursite.com/favicon.png"
        />
      </fieldset>
      <fieldset class="card" data-keywords="from email address sender">
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
      <Unavailable
        t={t}
        legend={t.T("settings.unavailableTitle")}
        keywords="language locale admin notification emails check updates version"
      >
        <label data-field="">
          {t.T("globals.fields.language")}
          <input x-model="form['app.lang']" />
        </label>
        <label data-field="">
          {t.T("settings.general.adminNotifEmails")}
          <input x-bind:value="(form['app.notify_emails'] || []).join(', ')" />
        </label>
        <Switch model="form['app.check_updates']" label={t.T("settings.general.checkUpdates")} />
      </Unavailable>
    </div>
  );
}

function Performance({ t }: { t: Translation }) {
  const windowOff = "!form['app.message_sliding_window']";
  const cacheOff = "!form['app.cache_slow_queries']";
  return (
    <div class="settings-items">
      <fieldset
        class="card"
        data-keywords="performance concurrency message rate batch size errors threshold throughput sending speed workers"
      >
        <legend>{t.T("globals.terms.performance")}</legend>
        <NumberField
          model="form['app.concurrency']"
          name="app.concurrency"
          label={t.T("globals.fields.concurrency")}
          hint={t.T("settings.performance.concurrencyHelp")}
          min="1"
          max="10000"
          placeholder="5"
        />
        <NumberField
          model="form['app.message_rate']"
          name="app.message_rate"
          label={t.T("settings.performance.messageRate")}
          hint={t.T("settings.performance.messageRateHelp")}
          min="1"
          max="100000"
          placeholder="5"
        />
        <NumberField
          model="form['app.batch_size']"
          name="app.batch_size"
          label={t.T("globals.fields.batchSize")}
          hint={t.T("settings.performance.batchSizeHelp")}
          min="1"
          max="100000"
          placeholder="1000"
        />
        <NumberField
          model="form['app.max_send_errors']"
          name="app.max_send_errors"
          label={t.T("settings.performance.maxErrThreshold")}
          hint={t.T("settings.performance.maxErrThresholdHelp")}
          min="0"
          max="100000"
          placeholder="1999"
        />
      </fieldset>
      <fieldset
        class="card"
        data-keywords="sliding window rate limit throttle duration cap sending"
      >
        <legend>{t.T("settings.performance.slidingWindow")}</legend>
        <Switch
          model="form['app.message_sliding_window']"
          label={t.T("globals.buttons.enable")}
          hint={t.T("settings.performance.slidingWindowHelp")}
        />
        <NumberField
          model="form['app.message_sliding_window_rate']"
          label={t.T("settings.performance.slidingWindowRate")}
          hint={t.T("settings.performance.slidingWindowRateHelp")}
          min="1"
          max="10000000"
          placeholder="25"
          disabled={windowOff}
        />
        <TextField
          model="form['app.message_sliding_window_duration']"
          label={t.T("globals.fields.duration")}
          hint={t.T("settings.performance.slidingWindowDurationHelp")}
          maxlength="10"
          placeholder="1h"
          disabled={windowOff}
        />
      </fieldset>
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
    </div>
  );
}

function Security({ t }: { t: Translation }) {
  const budget = (key: string, label: string) => (
    <NumberField
      model={`form['security.public_rate_limit'].${key}`}
      label={label}
      min="1"
      max="1000000"
    />
  );
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
      <hr />
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
        data-keywords="public rate limit subscribe opt-in unsubscribe privacy budget"
      >
        <legend>{t.T("settings.security.publicRateLimit")}</legend>
        <p class="text-light">{t.T("settings.security.publicRateLimitHelp")}</p>
        {budget("subscribe", t.T("globals.buttons.subscribe"))}
        {budget("optin", t.T("lists.optin"))}
        {budget("unsubscribe", t.T("globals.buttons.unsubscribe"))}
        {budget("privacy", t.T("globals.terms.privacy"))}
      </fieldset>
      <fieldset class="card" data-keywords="webhook private addresses block ssrf internal network">
        <legend>{t.T("settings.security.webhooks")}</legend>
        <Switch
          model="form['webhooks.block_private_addresses']"
          label={t.T("settings.security.blockPrivateAddresses")}
          hint={t.T("settings.security.blockPrivateAddressesHelp")}
        />
      </fieldset>
      <Unavailable
        t={t}
        legend={t.T("settings.security.enableCaptcha")}
        keywords="captcha altcha hcaptcha spam bot protection public form verification"
        note={t.T("settings.security.captchaUnavailable")}
      >
        <Switch model="form['security.captcha'].altcha.enabled" label="ALTCHA" />
        <Switch model="form['security.captcha'].hcaptcha.enabled" label="hCaptcha" />
      </Unavailable>
    </div>
  );
}

function Media({ t }: { t: Translation }) {
  const s3 = (key: string, label: string) => (
    <TextField model={`form['upload.s3.${key}']`} label={label} />
  );
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
      <fieldset class="card" data-keywords="filesystem local upload path uri directory disk">
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
      <Unavailable
        t={t}
        legend="S3"
        keywords="media upload provider storage s3 aws bucket region access key secret cloud object storage endpoint"
      >
        <TextField model="form['upload.provider']" label={t.T("globals.fields.provider")} />
        {s3("url", t.T("settings.media.s3.url"))}
        {s3("aws_default_region", t.T("globals.fields.region"))}
        {s3("aws_access_key_id", t.T("settings.media.s3.key"))}
        <TextField
          model="form['upload.s3.aws_secret_access_key']"
          type="password"
          label={t.T("settings.media.s3.secret")}
        />
        {s3("bucket", t.T("settings.media.s3.bucket"))}
        {s3("bucket_path", t.T("settings.media.s3.bucketPath"))}
        {s3("bucket_type", t.T("settings.media.s3.bucketType"))}
        {s3("expiry", t.T("settings.media.s3.uploadExpiry"))}
        {s3("public_url", t.T("settings.media.s3.publicURL"))}
      </Unavailable>
    </div>
  );
}

function SmtpTest({ t }: { t: Translation }) {
  return (
    <template x-if="smtpTestItem === n">
      <fieldset class="card mb-8 mt-8">
        <p>
          <strong>{t.T("settings.general.fromEmail")}</strong>:{" "}
          <span x-text="form['app.from_email'].split('\n')[0]"></span>
        </p>
        <fieldset class="group">
          <legend>{t.T("settings.smtp.toEmail")}</legend>
          <input
            type="email"
            required
            placeholder="email@site.com"
            x-bind:class="`test-email-${n}`"
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
        data-keywords="smtp mail server outgoing email sending host port tls authentication login relay gmail ses sendgrid mailgun postmark from headers retries"
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
                    <span class="text-light" x-text="`#${n + 1}`"></span>
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
              <div x-bind:aria-disabled={off}>
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
                <fieldset class="card" x-bind:disabled={off}>
                  <legend>{t.T("globals.fields.authProtocol")}</legend>
                  <div data-field="">
                    <label>{t.T("globals.fields.authProtocol")}</label>
                    <select x-model="item.auth_protocol">
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
                    class="`smtp-username-${n}`"
                    disabled={none}
                  />
                  <TextField
                    model="item.password"
                    type="password"
                    label={t.T("globals.fields.password")}
                    hint={t.T("globals.messages.passwordChange")}
                    maxlength="200"
                    class="`smtp-password-${n}`"
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
                  <div class="row" data-field="">
                    <div class="col-6">
                      <NumberField
                        model="item.max_msg_retries"
                        label={t.T("globals.fields.retries")}
                        hint={t.T("settings.mailserver.retriesHelp")}
                        min="1"
                        max="1000"
                        placeholder="2"
                      />
                    </div>
                    <div class="col-6">
                      <TextField
                        model="item.msg_retry_delay"
                        label={t.T("globals.fields.retryDelay")}
                        hint={t.T("settings.smtp.retryDelayHelp")}
                        maxlength="10"
                        placeholder="0s"
                      />
                    </div>
                  </div>
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
                      x-effect="if (!item.name) item.exclude_from_default = false"
                    />{" "}
                    {t.T("settings.smtp.excludeFromDefault")}
                    <Hint>{t.T("settings.smtp.excludeFromDefaultHelp")}</Hint>
                  </label>
                </fieldset>
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
          </details>
        </template>
      </div>
      <button type="button" data-variant="primary" class="btn-new" x-on:click="addSMTP">
        <Icon name="plus" /> {t.T("globals.buttons.addNew")}
      </button>
    </>
  );
}

function Bounces({ t }: { t: Translation }) {
  const provider = (model: string, label: string) => <Switch model={model} label={label} />;
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
          {(["soft", "hard", "complaint"] as const).map((type) => (
            <template x-if={`form['bounce.actions']?.${type}`}>
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
          <hr />
          <label data-field="" data-keywords="bounce webhook notifications endpoint enable">
            <input type="checkbox" role="switch" x-model="form['bounce.webhooks_enabled']" />{" "}
            {t.T("settings.bounces.enableWebhooks")}
          </label>
          <template x-if="form['bounce.webhooks_enabled']">
            <fieldset class="card" data-keywords="bounce mailgun webhook signing key">
              <legend>{t.T("settings.bounces.enableMailgun")}</legend>
              <label data-field="">
                <input type="checkbox" role="switch" x-model="form['bounce.mailgun'].enabled" />{" "}
                {t.T("globals.buttons.enable")}
              </label>
              <template x-if="form['bounce.mailgun'].enabled">
                <TextField
                  model="form['bounce.mailgun'].key"
                  type="password"
                  label={t.T("settings.bounces.mailgunKey")}
                  hint={t.T("globals.messages.passwordChange")}
                />
              </template>
            </fieldset>
          </template>
          <Unavailable
            t={t}
            legend={t.T("settings.bounces.otherProviders")}
            keywords="bounce ses amazon azure sendgrid postmark forwardemail lettermint webhook"
          >
            {provider("form['bounce.ses_enabled']", t.T("settings.bounces.enableSES"))}
            {provider("form['bounce.azure'].enabled", t.T("settings.bounces.enableAzure"))}
            {provider("form['bounce.sendgrid_enabled']", t.T("settings.bounces.enableSendgrid"))}
            {provider("form['bounce.postmark'].enabled", t.T("settings.bounces.enablePostmark"))}
            {provider(
              "form['bounce.forwardemail'].enabled",
              t.T("settings.bounces.enableForwardemail"),
            )}
            {provider(
              "form['bounce.lettermint'].enabled",
              t.T("settings.bounces.enableLettermint"),
            )}
          </Unavailable>
          <Unavailable
            t={t}
            legend={t.T("settings.bounces.enableMailbox")}
            keywords="bounce mailbox pop imap scan inbox host poll"
          >
            <template x-for="(item, n) in form['bounce.mailboxes']" x-bind:key="n">
              <div>
                <Switch model="item.enabled" label={t.T("globals.terms.enabled")} />
                <TextField model="item.host" label={t.T("globals.fields.host")} />
                <TextField model="item.username" label={t.T("globals.fields.username")} />
              </div>
            </template>
          </Unavailable>
        </div>
      </template>
    </div>
  );
}

function Messengers({ t }: { t: Translation }) {
  return (
    <div class="settings-items messengers">
      <Unavailable
        t={t}
        legend={t.T("settings.messengers.name")}
        keywords="messenger sms push notification webhook postback external channel"
      >
        <template x-for="(item, n) in form.messengers" x-bind:key="n">
          <div data-testid="messenger">
            <Switch model="item.enabled" label={t.T("globals.terms.enabled")} />
            <TextField model="item.name" label={t.T("globals.fields.name")} />
            <TextField model="item.root_url" label={t.T("globals.terms.url")} />
          </div>
        </template>
      </Unavailable>
    </div>
  );
}

function Appearance({ t }: { t: Translation }) {
  const editor = (key: string, lang: string, legend: string, keywords: string) => (
    <fieldset class="card" data-keywords={keywords}>
      <legend>{legend}</legend>
      <code-editor
        lang={lang}
        x-init={`$el.value = form['appearance.${key}']`}
        x-on:input={`form['appearance.${key}'] = $event.target.value`}
      ></code-editor>
    </fieldset>
  );
  const css = t.T("settings.appearance.customCSS");
  const js = t.T("settings.appearance.customJS");
  return (
    <div class="settings-items">
      <div role="alert" data-testid="appearance-warning">
        {t.T("settings.appearance.warning")}
      </div>
      <ot-tabs class="settings-subtabs">
        <div role="tablist">
          <button type="button" role="tab">
            {t.T("globals.terms.admin")}
          </button>
          <button type="button" role="tab">
            {t.T("globals.terms.public")}
          </button>
        </div>
        <div role="tabpanel">
          <p class="text-light">{t.T("settings.appearance.adminHelp")}</p>
          {editor("admin.custom_css", "css", css, "appearance admin custom css style theme ui")}
          {editor(
            "admin.custom_js",
            "javascript",
            js,
            "appearance admin custom javascript js script ui",
          )}
        </div>
        <div role="tabpanel">
          <p class="text-light">{t.T("settings.appearance.publicHelp")}</p>
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
        </div>
      </ot-tabs>
    </div>
  );
}

export const settingsView: AdminView = ({ context, can }) => {
  const t = context.app.i18n;
  const canManage = can("settings:manage");
  const tabs = [
    ["general", t.T("globals.terms.general"), <General t={t} />],
    ["performance", t.T("globals.terms.performance"), <Performance t={t} />],
    ["privacy", t.T("globals.terms.privacy"), <Privacy t={t} />],
    ["security", t.T("globals.terms.security"), <Security t={t} />],
    ["media", t.T("settings.media.title"), <Media t={t} />],
    ["smtp", t.T("settings.smtp.name"), <Smtp t={t} canManage={canManage} />],
    ["bounces", t.T("globals.terms.bounces"), <Bounces t={t} />],
    ["messengers", t.T("settings.messengers.name"), <Messengers t={t} />],
    ["appearance", t.T("globals.terms.appearance"), <Appearance t={t} />],
  ] as const;
  return {
    title: t.T("globals.terms.settings"),
    pageId: "settings.all",
    script: "settings",
    config: { can_manage: canManage },
    translationKeys: [
      "campaigns.testSent",
      "globals.fields.customHeaders",
      "globals.messages.invalidFields",
      "globals.messages.passwordChangeFull",
      "globals.messages.updated",
      "globals.terms.settings",
      "settings.smtp.testEnterEmail",
    ],
    body: (
      <>
        <form
          class="settings"
          novalidate
          x-data="settingsView"
          {...{ "x-on:submit.prevent": "onSubmit" }}
        >
          <header class="row page-header">
            <div class="col-4">
              <h1 class="page-title">{t.T("globals.terms.settings")}</h1>
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
};
