// Adapted from listmonk static/admin/views/roles.html and cmd/roles.go (ViewUserRoles, ViewListRoles)
// at 6fcd95f. roles.js reads the rows from /api/roles/*, so role names reach the page only through
// x-text and x-bind.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import {
  Alert,
  AvatarLink,
  Breadcrumbs,
  EmptyRow,
  HiddenFields,
  SortLink,
} from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";

export const roleKeys = [
  "globals.buttons.view",
  "globals.fields.name",
  "globals.messages.copyOf",
  "globals.messages.created",
  "globals.messages.deleted",
  "globals.messages.updated",
];

function Menu({ t }: { t: Translation }) {
  return (
    <ot-dropdown>
      <button
        popovertarget=""
        x-bind:popovertarget="'role-actions-' + r.id"
        type="button"
        class="ghost more icon"
        aria-label={t.T("globals.buttons.more")}
      >
        <Icon name="more-vertical" />
      </button>
      <menu popover="" x-bind:id="'role-actions-' + r.id">
        <a x-bind:href="link(r)" role="menuitem" class="button ghost" data-testid="btn-edit">
          <Icon name="edit-2" /> {t.T("globals.buttons.edit")}
        </a>
        <button
          type="button"
          role="menuitem"
          class="ghost"
          data-testid="btn-clone"
          x-bind:disabled="isLoading('roles')"
          {...{ "x-on:click.prevent": "onCloneRole(r)" }}
        >
          <Icon name="copy" /> {t.T("globals.buttons.clone")}
        </button>
        <template x-if="r.id !== 1">
          <button
            type="button"
            role="menuitem"
            class="ghost"
            data-variant="danger"
            data-testid="btn-delete"
            x-bind:disabled="isLoading('roles')"
            {...{ "x-on:click.prevent": "onDeleteRole(r)" }}
          >
            <Icon name="trash-2" /> {t.T("globals.buttons.delete")}
          </button>
        </template>
      </menu>
    </ot-dropdown>
  );
}

export function rolesView(type: "user" | "list"): AdminView {
  return ({ context, can }) => {
    const t = context.app.i18n;
    const params = context.url.searchParams;
    const base = type === "list" ? "/admin/users/roles/lists" : "/admin/users/roles";
    const title = t.T(type === "list" ? "users.listRoles" : "users.userRoles");
    const sort = (field: string, label: string) => (
      <SortLink base={base} params={params} field={field} label={label} />
    );
    return {
      title,
      pageId: type === "list" ? "users.list-roles" : "users.user-roles",
      script: "roles",
      translationKeys: roleKeys,
      config: { roles_view: type },
      body: (
        <>
          <Breadcrumbs
            parent={t.T("globals.terms.users")}
            href={can("users:get") ? "/admin/users" : null}
            current={title}
          />
          <section class="roles" x-data="rolesView">
            <header class="row page-header">
              <div class="col-4">
                <div class="hstack">
                  <h1 class="page-title">
                    {title} <span x-text="'(' + roles.length + ')'"></span>
                  </h1>
                </div>
              </div>
              <div class="col-8 hstack justify-end buttons">
                <form method="get" action={base} class="search-form">
                  <HiddenFields params={params} exclude={["query"]} />
                  <fieldset class="group">
                    <input
                      name="query"
                      aria-label="Search"
                      data-testid="query"
                      placeholder="Search"
                      value={params.get("query") ?? ""}
                      autofocus
                    />
                    <button
                      type="submit"
                      class="outline external"
                      data-testid="btn-query"
                      aria-label="Search"
                    >
                      <Icon name="search" />
                    </button>
                  </fieldset>
                </form>
                {can("roles:manage") ? (
                  <a
                    href={`${base}/new`}
                    class="button"
                    data-variant="primary"
                    data-testid="btn-new"
                  >
                    <Icon name="plus" /> {t.T("globals.buttons.new")}
                  </a>
                ) : null}
              </div>
            </header>
            <Alert name="error" />
            <div class="card page-content has-table">
              <div class="table-wrapper" x-bind:aria-busy="loading">
                <table>
                  <thead>
                    <tr>
                      <th>{sort("name", t.Tc("globals.terms.role", 1))}</th>
                      <th>{sort("created_at", t.T("globals.fields.createdAt"))}</th>
                      <th>{sort("updated_at", t.T("globals.fields.updatedAt"))}</th>
                      <th class="actions align-right"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <template x-for="r in roles" x-bind:key="r.id">
                      <tr data-testid="role-row" x-bind:data-id="r.id">
                        <td>
                          <div class="avatar">
                            <AvatarLink
                              kind={`${type}-role`}
                              name="r.name"
                              href="link(r)"
                              title="viewTitle(r.name)"
                            />
                            <a
                              x-bind:href="link(r)"
                              class="avatar-label unstyled"
                              x-bind:style="r.id === 1 ? 'font-weight: bold' : ''"
                              x-text="r.name"
                            ></a>
                          </div>
                        </td>
                        <td
                          class="date-stack"
                          data-label={t.T("globals.fields.createdAt")}
                          x-text="niceDate(r.created_at)"
                        ></td>
                        <td
                          class="date-stack"
                          data-label={t.T("globals.fields.updatedAt")}
                          x-text="niceDate(r.updated_at)"
                        ></td>
                        <td class="actions align-right">
                          {can("roles:manage") ? <Menu t={t} /> : null}
                        </td>
                      </tr>
                    </template>
                    <EmptyRow when="!loading && !error && !roles.length" colspan={4} t={t} />
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </>
      ),
    };
  };
}
