// Adapted from the 2FA section of listmonk static/admin/views/profile.html at 6fcd95f. M4.4 ports
// the rest of the profile page around it.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import type { Translation } from "@/i18n/i18n";

function Enabled({ t }: { t: Translation }) {
  return (
    <div class="card content" data-testid="twofa-enabled">
      <div class="row">
        <div class="col-10">
          <h3 class="hstack gap-1">
            <Icon name="check-circle" /> {t.T("users.twoFAEnabled")}
          </h3>
        </div>
        <div class="col-end align-right">
          <input
            type="checkbox"
            role="switch"
            aria-label={t.T("users.twoFA")}
            x-bind:checked="!showDisableTotp"
            x-on:change="$event.target.checked ? cancelDisableTotp() : (showDisableTotp = true)"
          />
        </div>
      </div>
      <p>{t.Ts("users.twoFAEnabledDesc", "type", "TOTP")}</p>
      <template x-if="showDisableTotp">
        <form class="disable-totp mt-5" {...{ "x-on:submit.prevent": "confirmDisableTotp" }}>
          <label data-field="">
            {t.T("globals.fields.password")}
            <input type="password" x-model="disablePassword" minlength="8" required />
          </label>
          <div class="hstack gap-3">
            <button type="submit" data-variant="danger">
              {t.T("globals.buttons.disable")}
            </button>
            <button type="button" class="outline" x-on:click="cancelDisableTotp">
              {t.T("globals.buttons.cancel")}
            </button>
          </div>
        </form>
      </template>
    </div>
  );
}
function Setup({ t }: { t: Translation }) {
  return (
    <div class="card content">
      <div class="row mb-4">
        <div class="col-10">
          <h3 class="mb-0">{t.T("users.twoFA")}</h3>
        </div>
        <div class="col-end align-right">
          <input
            type="checkbox"
            role="switch"
            aria-label={t.T("users.twoFA")}
            x-bind:checked="showTotpSetup"
            x-on:change="$event.target.checked ? onEnableTotp() : cancelTotp()"
          />
        </div>
      </div>
      <p>{t.T("users.twoFANotEnabled")}</p>
      <template x-if="totpQR">
        <div class="qr-app-section totp-setup mt-5">
          <figure class="mb-6">
            <img class="card" x-bind:src="'data:image/png;base64,' + totpQR" alt="QR Code" />
            <figcaption class="text-light text-8">{t.T("users.totpScanQR")}</figcaption>
          </figure>
          <fieldset>
            <legend>{t.T("globals.fields.secretKey")}</legend>
            <button
              type="button"
              class="small"
              data-variant="secondary"
              title={t.T("globals.messages.clickToCopy")}
              aria-label={t.T("globals.fields.secretKey")}
              x-on:click="copyToClipboard(totpSecret)"
            >
              <span data-testid="totp-secret" x-text="totpSecret"></span>
            </button>
          </fieldset>
          <form class="mt-5" {...{ "x-on:submit.prevent": "confirmTotp" }}>
            <fieldset>
              <legend>{t.T("users.totpCode")}</legend>
              <div data-field="">
                <input
                  x-ref="totpCode"
                  x-model="totpCode"
                  aria-label={t.T("users.totpCode")}
                  maxlength="6"
                  pattern="[0-9]{6}"
                  placeholder="000000"
                  required
                />
              </div>
              <div class="hstack gap-3">
                <button type="submit" data-variant="primary">
                  {t.T("globals.buttons.enable")}
                </button>
                <button type="button" class="outline" x-on:click="cancelTotp">
                  {t.T("globals.buttons.cancel")}
                </button>
              </div>
            </fieldset>
          </form>
        </div>
      </template>
    </div>
  );
}

export const profileView: AdminView = ({ context, identity }) => {
  const t = context.app.i18n;
  const { user } = identity;
  return {
    title: t.T("globals.terms.profile"),
    pageId: "profile",
    script: "profile",
    config: { user_id: String(user.id) },
    translationKeys: [
      "users.twoFAEnabled",
      "globals.messages.done",
      "globals.messages.invalidValue",
      "globals.messages.invalidFields",
      "globals.fields.password",
    ],
    body: (
      <section x-data="profileView">
        <header class="page-header">
          <h3 class="page-title">{t.T("globals.terms.profile")}</h3>
        </header>
        {user.password_login !== 0n && identity.transport === "session" ? (
          <section class="twofa-app-section mt-6">
            {user.twofa_type === "totp" ? <Enabled t={t} /> : <Setup t={t} />}
          </section>
        ) : null}
      </section>
    ),
  };
};
