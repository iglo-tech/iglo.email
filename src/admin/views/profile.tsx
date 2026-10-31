// Adapted from listmonk static/admin/views/profile.html at 6fcd95f.
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
  const { user, role } = identity;
  const passwordLogin = user.password_login !== 0n;
  return {
    title: t.T("globals.terms.profile"),
    pageId: "profile",
    script: "profile",
    config: { user_id: String(user.id), user_name: user.name, user_email: user.email },
    translationKeys: [
      "users.twoFAEnabled",
      "users.passwordMismatch",
      "globals.messages.done",
      "globals.messages.invalidValue",
      "globals.messages.invalidFields",
      "globals.messages.updated",
      "globals.fields.password",
    ],
    body: (
      <section class="user-profile" x-data="profileView">
        <header class="page-header">
          <div class="hstack gap-1">
            <h1 class="page-title">{t.T("globals.terms.profile")}</h1>
            {role.name ? <span class="badge">{role.name}</span> : null}
          </div>
        </header>
        <div class="card page-content content">
          <form method="post" {...{ "x-on:submit.prevent": "onSubmit" }}>
            <section class="dialog-body">
              <h4 class="mb-6">@{user.username}</h4>
              {user.type !== "api" ? (
                <label data-field="">
                  {t.T("globals.fields.email")}
                  <input
                    name="email"
                    type="email"
                    maxlength="200"
                    required
                    disabled={!passwordLogin}
                    x-model="form.email"
                    autofocus
                  />
                </label>
              ) : null}
              <label data-field="">
                {t.T("globals.fields.name")}
                <input name="name" maxlength="200" x-model="form.name" />
              </label>
              {passwordLogin ? (
                <>
                  <div class="row">
                    <label data-field="" class="col-6">
                      {t.T("globals.fields.password")}
                      <input
                        type="password"
                        name="password"
                        minlength="8"
                        maxlength="200"
                        autocomplete="new-password"
                        x-model="form.password"
                      />
                    </label>
                    <label data-field="" class="col-6">
                      {t.T("globals.fields.passwordRepeat")}
                      <input
                        type="password"
                        name="password2"
                        minlength="8"
                        maxlength="200"
                        autocomplete="new-password"
                        x-model="form.password2"
                      />
                    </label>
                  </div>
                  <small data-hint="">{t.T("users.passwordSessions")}</small>
                </>
              ) : null}
            </section>
            <footer class="dialog-foot hstack justify-end mt-6">
              <button
                type="submit"
                data-variant="primary"
                x-bind:disabled="isLoading('profile.save')"
                x-bind:aria-busy="isLoading('profile.save')"
              >
                {t.T("globals.buttons.save")}
              </button>
            </footer>
          </form>
        </div>
        {passwordLogin && identity.transport === "session" ? (
          <section class="twofa-app-section mt-6">
            {user.twofa_type === "totp" ? <Enabled t={t} /> : <Setup t={t} />}
          </section>
        ) : null}
      </section>
    ),
  };
};
