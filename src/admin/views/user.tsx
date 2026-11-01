// Adapted from listmonk static/admin/views/user.html and cmd/users.go (ViewUser) at 6fcd95f. The
// role selects arrive with the page, as upstream's do, because users:manage alone cannot read
// /api/roles/*. On your own record they are read-only, and so is password login, which the API
// would let the last administrator switch off: the screen offers no way to raise your own
// permissions or lock yourself out. The API keeps its contract.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import { userKeys } from "@/admin/views/users";
import { Alert, Breadcrumbs } from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";
import type { Roles } from "@/roles/roles";
import { getID } from "@/server/validation";

function TokenDialog({ t }: { t: Translation }) {
  return (
    <dialog x-ref="tokenDialog" x-on:close="onTokenDialogClose">
      <div class="dialog-card content">
        <header class="dialog-head">
          <h4 class="dialog-title">{t.T("users.type.api")}</h4>
        </header>
        <section class="dialog-body">
          <p class="text-light">{t.T("users.apiOneTimeToken")}</p>
          <button
            type="button"
            class="w-100"
            data-variant="secondary"
            data-testid="api-token"
            title={t.T("globals.messages.clickToCopy")}
            x-on:click="copyToClipboard(apiToken)"
          >
            <span x-text="apiToken"></span> <Icon name="copy" />
          </button>
        </section>
        <footer class="dialog-foot align-right">
          <button type="button" data-variant="primary" x-on:click="$refs.tokenDialog.close()">
            {t.T("globals.buttons.close")}
          </button>
        </footer>
      </div>
    </dialog>
  );
}

export const userView =
  (roles: Roles, isNew: boolean): AdminView =>
  ({ context, identity, can }) => {
    const t = context.app.i18n;
    const canSave = can("users:manage");
    const id = isNew ? null : getID(context);
    const self = id !== null && BigInt(id) === identity.user.id;
    const userRoles = roles.all("user", "", "", "");
    const listRoles = roles.all("list", "", "", "");
    const required = isNew ? { required: true } : {};
    return {
      title: t.T(isNew ? "users.newUser" : "globals.terms.users"),
      pageId: "users.users",
      script: "users",
      translationKeys: userKeys,
      config: {
        is_new: isNew,
        can_save: canSave,
        self,
        ...(id === null ? {} : { user_id: String(id) }),
        default_role: userRoles[0]?.id ?? null,
      },
      body: (
        <>
          <Breadcrumbs
            parent={t.T("globals.terms.users")}
            href={can("users:get") ? "/admin/users" : null}
            current={t.T(isNew ? "users.newUser" : "globals.buttons.edit")}
          />
          <section class="users" x-data="userForm">
            <header class="page-header">
              <div class="hstack gap-1">
                {isNew ? (
                  <h1 class="page-title">{t.T("users.newUser")}</h1>
                ) : (
                  <h1 class="page-title" x-text="form.name || form.username"></h1>
                )}
              </div>
            </header>
            <Alert name="error" />
            <form
              method="post"
              x-show="ready"
              style="display: none"
              {...{ "x-on:submit.prevent": "onSubmit" }}
            >
              <div class="page-content content">
                <section>
                  <fieldset class="card">
                    <legend>{t.T("globals.terms.profile")}</legend>
                    <div data-field="">
                      <label for="user-type">{t.T("globals.fields.type")}</label>
                      <select
                        name="type"
                        id="user-type"
                        x-model="form.type"
                        x-bind:disabled="!isNew"
                      >
                        <option value="user">{t.T("users.type.user")}</option>
                        <option value="api">{t.T("users.type.api")}</option>
                      </select>
                    </div>
                    <label data-field="">
                      {t.T("globals.fields.username")}
                      <input
                        name="username"
                        maxlength="200"
                        required
                        autocomplete="off"
                        pattern="[a-zA-Z0-9_\-\.@]+$"
                        autofocus
                        x-model="form.username"
                      />
                      <small data-hint="">{t.T("users.usernameHelp")}</small>
                    </label>
                    <label data-field="">
                      {t.T("globals.fields.name")}
                      <input name="name" maxlength="200" x-model="form.name" />
                    </label>
                    <template x-if="form.type !== 'api'">
                      <label data-field="">
                        {t.T("globals.fields.email")}
                        <input
                          name="email"
                          type="email"
                          maxlength="200"
                          required
                          x-model="form.email"
                        />
                      </label>
                    </template>
                    <div data-field="">
                      <label for="user-status">{t.T("globals.fields.status")}</label>
                      <select name="status" id="user-status" required x-model="form.status">
                        <option value="enabled">{t.T("globals.terms.enabled")}</option>
                        <option value="disabled">{t.T("globals.terms.disabled")}</option>
                      </select>
                    </div>
                  </fieldset>
                  <template x-if="form.type !== 'api'">
                    <fieldset class="card">
                      <legend>{t.T("globals.fields.password")}</legend>
                      <label data-field="">
                        <input
                          type="checkbox"
                          x-model="form.password_login"
                          data-testid="password-login"
                          disabled={self}
                        />{" "}
                        {t.T("users.passwordEnable")}
                        {self ? <small data-hint="">{t.T("users.ownAccount")}</small> : null}
                      </label>
                      <label data-field="">
                        {t.T("globals.fields.password")}
                        <input
                          type="password"
                          name="password"
                          minlength="8"
                          maxlength="200"
                          autocomplete="new-password"
                          x-bind:disabled="!form.password_login"
                          x-bind:required="form.password_login && isNew"
                          x-model="form.password"
                        />
                      </label>
                      <label data-field="">
                        {t.T("globals.fields.passwordRepeat")}
                        <input
                          type="password"
                          name="password2"
                          minlength="8"
                          maxlength="200"
                          autocomplete="new-password"
                          x-bind:disabled="!form.password_login"
                          x-bind:required="form.password_login && isNew && form.password"
                          x-model="form.password2"
                        />
                      </label>
                    </fieldset>
                  </template>
                  <fieldset class="card" data-testid="user-roles" disabled={self}>
                    <legend>{t.Tc("globals.terms.role", 2)}</legend>
                    <div data-field="">
                      <label for="user-role">{t.Tc("users.userRole", 1)}</label>
                      <select
                        name="user_role"
                        id="user-role"
                        {...required}
                        {...{ "x-model.number": "form.user_role_id" }}
                      >
                        {userRoles.map((role) => (
                          <option value={String(role.id)}>{role.name}</option>
                        ))}
                      </select>
                    </div>
                    <div data-field="">
                      <label for="list-role">{t.Tc("users.listRole", 2)}</label>
                      <select name="list_role" id="list-role" x-model="form.list_role_id">
                        <option value="">— {t.T("globals.terms.none")} —</option>
                        {listRoles.map((role) => (
                          <option value={String(role.id)}>{role.name}</option>
                        ))}
                      </select>
                    </div>
                    {self ? <small data-hint="">{t.T("users.ownRole")}</small> : null}
                  </fieldset>
                </section>
                <footer class="hstack justify-between mt-6">
                  <div class="hstack gap-1">
                    {isNew ? null : (
                      <button
                        type="button"
                        class="small"
                        data-variant="secondary"
                        title={t.T("globals.messages.clickToCopy")}
                        aria-label={t.T("globals.fields.id")}
                        x-on:click="copyToClipboard('' + form.id)"
                      >
                        <strong>{t.T("globals.fields.id")}</strong> <span x-text="form.id"></span>
                      </button>
                    )}
                  </div>
                  <div class="hstack gap-3 justify-end">
                    {canSave ? (
                      <button
                        type="submit"
                        data-variant="primary"
                        data-testid="btn-save"
                        x-bind:disabled="isLoading('users.save')"
                        x-bind:aria-busy="isLoading('users.save')"
                      >
                        {t.T("globals.buttons.save")}
                      </button>
                    ) : null}
                  </div>
                </footer>
              </div>
            </form>
            {canSave ? <TokenDialog t={t} /> : null}
          </section>
        </>
      ),
    };
  };
