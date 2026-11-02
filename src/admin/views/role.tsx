// Adapted from listmonk static/admin/views/user-role.html, list-role.html and cmd/roles.go
// (ViewUserRole, ViewListRole, parsePermGroups) at 6fcd95f. A role has no read endpoint of its own,
// so the record arrives with the page through the escaped bootstrap, as upstream's `_role` does.
// The role you hold is read-only here: this screen does not raise your own permissions.
import { Icon } from "@/admin/layout/icon";
import type { AdminRequest, AdminView } from "@/admin/page";
import { Breadcrumbs, EmptyState } from "@/admin/views/parts";
import { roleKeys } from "@/admin/views/roles";
import type { Translation } from "@/i18n/i18n";
import type { Child } from "@/jsx/render";
import { permissions, type Roles } from "@/roles/roles";
import { validPermissions } from "@/roles/routes";
import { HttpError } from "@/server/response";
import { getID } from "@/server/validation";

const docs = "https://listmonk.app/docs/roles-and-permissions";
const risky: Record<string, string> = {
  "subscribers:sql_query": `${docs}/#subscriberssql_query`,
  "users:manage": `${docs}/#:~:text=users:manage`,
};
/** The groups of upstream's permissions.json, by prefix; a native permission brings its own. */
const groupOf: Record<string, string> = {
  tx: "subscribers",
  subscriber_events: "subscribers",
  roles: "users",
};
function permissionGroups(): { group: string; permissions: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const permission of validPermissions) {
    const prefix = permission.split(":", 1)[0]!;
    const group = permission === "webhooks:post_bounce" ? "bounces" : (groupOf[prefix] ?? prefix);
    groups.set(group, [...(groups.get(group) ?? []), permission]);
  }
  return [...groups].map(([group, permissions]) => ({ group, permissions }));
}
/** A new role starts with upstream's defaults. A native permission is a choice to make. */
const defaultPermissions = permissions.filter(
  (p) => p !== "subscribers:sql_query" && !/^(lists|settings|users|roles):/.test(p),
);

function Permission({ value }: { value: string }) {
  const href = risky[value];
  return (
    <label>
      <input type="checkbox" value={value} x-model="form.permissions" x-bind:disabled="disabled" />{" "}
      {href ? (
        <>
          <span class="text-danger">{value}</span>{" "}
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            class="text-danger"
            aria-label="Warning: high risk permission"
          >
            <Icon name="alert-triangle" />
          </a>
        </>
      ) : (
        value
      )}
    </label>
  );
}

function Footer(props: { t: Translation; isNew: boolean }) {
  const { t, isNew } = props;
  return (
    <footer class="hstack justify-between mt-6">
      <div class="hstack gap-3">
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
        <a href={docs} target="_blank" rel="noopener noreferrer" class="text-light text-8">
          <Icon name="link-2" /> {t.T("globals.buttons.learnMore")}
        </a>
      </div>
      <div class="hstack gap-3 justify-end">
        <button
          type="submit"
          data-variant="primary"
          data-testid="btn-save"
          x-show="!disabled"
          x-bind:disabled="isLoading('roles.save')"
          x-bind:aria-busy="isLoading('roles.save')"
        >
          {t.T("globals.buttons.save")}
        </button>
      </div>
    </footer>
  );
}

function Shell(props: {
  request: AdminRequest;
  listsHref: string;
  listsLabel: string;
  name: string | null;
  fallback: string;
  own: boolean;
  isNew: boolean;
  children: Child;
}) {
  const { request, listsHref, listsLabel, name, fallback, own, isNew, children } = props;
  const t = request.context.app.i18n;
  return (
    <>
      <Breadcrumbs
        root={{
          label: t.T("globals.terms.users"),
          href: request.can("users:get") ? "/admin/users" : null,
        }}
        parent={listsLabel}
        href={listsHref}
        current={name ?? fallback}
      />
      <section class="roles" x-data="roleForm">
        <header class="page-header">
          <div class="hstack gap-1">
            <h1 class="page-title">{name ?? fallback}</h1>
          </div>
        </header>
        {own ? (
          <div role="alert" data-testid="own-role">
            {t.T("users.ownRole")}
          </div>
        ) : null}
        <form method="post" {...{ "x-on:submit.prevent": "onSubmit" }}>
          <div class="page-content content">
            {children}
            <Footer t={t} isNew={isNew} />
          </div>
        </form>
      </section>
    </>
  );
}

const name = (t: Translation) => (
  <label data-field="">
    {t.T("globals.fields.name")}
    <input
      name="name"
      maxlength="200"
      autofocus
      required
      x-bind:disabled="disabled"
      x-model="form.name"
    />
  </label>
);

export const userRoleView =
  (roles: Roles, isNew: boolean): AdminView =>
  (request) => {
    const t = request.context.app.i18n;
    const id = isNew ? null : BigInt(getID(request.context));
    const role = id === null ? null : roles.userRole(id);
    if (id !== null && !role)
      throw new HttpError(404, t.Ts("globals.messages.notFound", "name", "{users.userRole}"));
    const own = role !== null && role.id !== 1n && role.id === request.identity.role.id;
    const groups = permissionGroups();
    const title = role?.name ?? t.T("users.newUserRole");
    return {
      title: `${title} / ${t.T("users.userRoles")}`,
      pageId: "users.user-roles",
      script: "roles",
      translationKeys: roleKeys,
      config: {
        role_form: "user",
        is_new: isNew,
        read_only: !request.can("roles:manage") || id === 1n || own,
        role: role ? { id: Number(role.id), name: role.name, permissions: role.permissions } : null,
        default_permissions: defaultPermissions,
        all_permissions: [...validPermissions],
      },
      body: (
        <Shell
          request={request}
          listsHref="/admin/users/roles"
          listsLabel={t.T("users.userRoles")}
          name={role?.name ?? null}
          fallback={t.T("users.newUserRole")}
          own={own}
          isNew={isNew}
        >
          <section class="card">
            {name(t)}
            <div class="row">
              <div class="col-9">
                <label>{t.T("globals.terms.permissions")}</label>
              </div>
              <div class="col-3 align-right">
                <button
                  type="button"
                  class="small outline"
                  x-bind:disabled="disabled"
                  {...{ "x-on:click.prevent": "onToggleSelect" }}
                >
                  {t.T("globals.buttons.toggleSelect")}
                </button>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>{t.T("globals.fields.group")}</th>
                  <th>{t.T("globals.terms.permissions")}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr>
                    <td>{t.T(`globals.terms.${group.group}`)}</td>
                    <td>
                      <div class="vstack gap-1">
                        {group.permissions.map((value) => (
                          <Permission value={value} />
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </Shell>
      ),
    };
  };

export const listRoleView =
  (roles: Roles, isNew: boolean): AdminView =>
  (request) => {
    const t = request.context.app.i18n;
    const id = isNew ? null : BigInt(getID(request.context));
    const role = id === null ? null : roles.listRole(id);
    if (id !== null && !role)
      throw new HttpError(404, t.Ts("globals.messages.notFound", "name", "{users.listRole}"));
    const own = role !== null && role.id === request.identity.user.list_role_id;
    const title = role?.name ?? t.T("users.newListRole");
    return {
      title: `${title} / ${t.T("users.listRoles")}`,
      pageId: "users.list-roles",
      script: "roles",
      translationKeys: roleKeys,
      config: {
        role_form: "list",
        is_new: isNew,
        read_only: !request.can("roles:manage") || own,
        role: role
          ? {
              id: Number(role.id),
              name: role.name,
              lists: (role.lists ?? []).map((list) => ({
                id: Number(list.id),
                name: list.name,
                permissions: list.permissions,
              })),
            }
          : null,
      },
      body: (
        <Shell
          request={request}
          listsHref="/admin/users/roles/lists"
          listsLabel={t.T("users.listRoles")}
          name={role?.name ?? null}
          fallback={t.T("users.newListRole")}
          own={own}
          isNew={isNew}
        >
          <fieldset class="card">
            <legend>{t.Tc("users.listRole", 1)}</legend>
            {name(t)}
          </fieldset>
          <fieldset class="card">
            <legend>{t.T("globals.terms.lists")}</legend>
            <div data-field="">
              <label>{t.T("globals.terms.list")}</label>
              <fieldset class="group">
                <select
                  aria-label={t.Tc("globals.terms.list", 1)}
                  x-bind:disabled="disabled || filteredLists.length < 1"
                  {...{ "x-model.number": "form.curList" }}
                >
                  <template x-for="l in filteredLists" x-bind:key="l.id">
                    <option x-bind:value="l.id" x-text="l.name"></option>
                  </template>
                </select>
                <button
                  type="button"
                  class="outline"
                  data-testid="btn-add-list"
                  x-on:click="onAddListPerm"
                  x-bind:disabled="disabled || !form.curList"
                >
                  {t.T("globals.buttons.add")}
                </button>
              </fieldset>
            </div>
            <table>
              <thead>
                <tr>
                  <th width="50%">{t.Tc("globals.terms.list", 1)}</th>
                  <th width="20%">{t.T("globals.terms.permissions")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <template x-for="l in form.lists" x-bind:key="l.id">
                  <tr>
                    <td>
                      <a x-bind:href="'/admin/lists/' + l.id" class="unstyled" x-text="l.name"></a>
                    </td>
                    <td>
                      <div class="hstack gap-3">
                        <label>
                          <input
                            type="checkbox"
                            value="list:get"
                            x-model="l.permissions"
                            x-bind:disabled="disabled"
                          />{" "}
                          {t.T("globals.buttons.view")}
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            value="list:manage"
                            x-model="l.permissions"
                            x-bind:disabled="disabled"
                          />{" "}
                          {t.T("globals.buttons.manage")}
                        </label>
                      </div>
                    </td>
                    <td class="actions align-right">
                      <button
                        type="button"
                        class="ghost icon"
                        data-variant="danger"
                        x-bind:disabled="disabled"
                        x-on:click="onDeleteListPerm(l.id)"
                        aria-label={t.T("globals.buttons.delete")}
                      >
                        <Icon name="trash-2" />
                      </button>
                    </td>
                  </tr>
                </template>
                <tr x-show="form.lists.length === 0" style="display: none">
                  <td colspan={3}>
                    <EmptyState text={t.T("globals.messages.emptyState")} />
                  </td>
                </tr>
              </tbody>
            </table>
          </fieldset>
        </Shell>
      ),
    };
  };
