// Adapted from listmonk static/admin/views/users.html and cmd/users.go (ViewUsers) at 6fcd95f.
// users.js reads the rows from /api/users, so stored text reaches the page only through x-text and
// x-bind. The API takes no filters; the module applies upstream's four to what it read.
import { Icon } from "@/admin/layout/icon";
import type { AdminView } from "@/admin/page";
import { Alert, AvatarLink, EmptyRow, FilterBadge, filterURL, SortLink } from "@/admin/views/parts";
import type { Translation } from "@/i18n/i18n";
import type { Roles } from "@/roles/roles";

export const userKeys = [
  "globals.buttons.view",
  "globals.buttons.filter",
  "globals.messages.confirmDelete",
  "globals.messages.created",
  "globals.messages.deleted",
  "globals.messages.deletedCount",
  "globals.messages.notFound",
  "globals.messages.numSelected",
  "globals.messages.updated",
  "globals.terms.user",
  "users.passwordMismatch",
];

function Menu({ t }: { t: Translation }) {
  return (
    <ot-dropdown>
      <button
        popovertarget=""
        x-bind:popovertarget="'user-actions-' + r.id"
        type="button"
        class="ghost more icon"
        aria-label={t.T("globals.buttons.more")}
      >
        <Icon name="more-vertical" />
      </button>
      <menu popover="" x-bind:id="'user-actions-' + r.id">
        <a
          x-bind:href="'/admin/users/' + r.id"
          role="menuitem"
          class="button ghost"
          data-testid="btn-edit"
        >
          <Icon name="edit-2" /> {t.T("globals.buttons.edit")}
        </a>
        <button
          type="button"
          role="menuitem"
          class="ghost"
          data-variant="danger"
          data-testid="btn-delete"
          x-bind:disabled="isLoading('users')"
          {...{ "x-on:click.prevent": "onDeleteUser(r.id, r.name)" }}
        >
          <Icon name="trash-2" /> {t.T("globals.buttons.delete")}
        </button>
      </menu>
    </ot-dropdown>
  );
}

function Role(props: { kind: string; href: string; filter: string; name: string }) {
  const { kind, href, filter, name } = props;
  return (
    <div class="avatar small role-name">
      <AvatarLink kind={kind} name={name} href={href} title={`viewTitle(${name})`} />
      <a
        x-bind:href={filter}
        class="avatar-label unstyled"
        x-bind:title={`filterTitle(${name})`}
        x-text={name}
      ></a>
    </div>
  );
}

function Row({ t, manage }: { t: Translation; manage: boolean }) {
  const userRole = t.Tc("users.userRole", 1);
  const listRole = t.Tc("users.listRole", 2);
  return (
    <tr data-testid="user-row" x-bind:data-id="r.id">
      {manage ? (
        <td>
          <input
            name="id"
            type="checkbox"
            x-bind:value="r.id"
            aria-label={t.T("globals.buttons.toggleSelect")}
          />
        </td>
      ) : null}
      <td>
        <div class="avatar" x-bind:class="{ disabled: r.status === 'disabled' }">
          <AvatarLink
            kind="user"
            name="(r.name || r.username)"
            href="'/admin/users/' + r.id"
            title="viewTitle(r.name || r.username)"
          />
          <div class="avatar-label">
            <a
              x-bind:href="'/admin/users/' + r.id"
              class="unstyled"
              x-bind:class="{ 'text-light': r.status === 'disabled' }"
              x-text="r.username"
            ></a>
            <template x-if="r.type === 'api'">
              <a href="/admin/users?type=api" x-bind:title="filterTitle(apiLabel)">
                <span class="badge tag">
                  <Icon name="code" /> {t.T("users.type.api")}
                </span>
              </a>
            </template>
            <template x-if="r.status === 'disabled'">
              <a href="/admin/users?status=disabled" x-bind:title="filterTitle(disabledLabel)">
                <span class="badge enum status-disabled">
                  <span class="dot">●</span> {t.T("globals.terms.disabled")}
                </span>
              </a>
            </template>
            <template x-if="r.name && r.name !== r.username">
              <div class="text-light text-8" x-text="r.name"></div>
            </template>
          </div>
        </div>
      </td>
      <td data-label={t.T("globals.fields.email")} class="text-light" x-text="r.email || '—'"></td>
      <td data-label={userRole}>
        <Role
          kind="user-role"
          name="r.user_role.name"
          href="'/admin/users/roles/' + r.user_role.id"
          filter="'/admin/users?user_role_id=' + r.user_role.id"
        />
      </td>
      <td data-label={listRole}>
        <template x-if="r.list_role">
          <Role
            kind="list-role"
            name="r.list_role.name"
            href="'/admin/users/roles/lists/' + r.list_role.id"
            filter="'/admin/users?list_role_id=' + r.list_role.id"
          />
        </template>
        <template x-if="!r.list_role">
          <span class="text-light">—</span>
        </template>
      </td>
      <td
        class="date-stack"
        data-label={t.T("globals.fields.createdAt")}
        x-text="niceDate(r.created_at)"
      ></td>
      <td
        class="date-stack"
        data-label={t.T("globals.fields.lastLogin")}
        x-text="niceDate(r.loggedin_at) || '—'"
      ></td>
      <td class="actions align-right">{manage ? <Menu t={t} /> : null}</td>
    </tr>
  );
}

const numeric = (value: string | null) =>
  value && /^\d{1,18}$/.test(value) ? BigInt(value) : null;

export const usersView =
  (roles: Roles): AdminView =>
  ({ context, can }) => {
    const t = context.app.i18n;
    const params = context.url.searchParams;
    const base = "/admin/users";
    const manage = can("users:manage");
    const type = params.get("type");
    const status = params.get("status");
    const userRoleId = numeric(params.get("user_role_id"));
    const listRoleId = numeric(params.get("list_role_id"));
    const userRole = userRoleId === null ? null : roles.userRole(userRoleId);
    const listRole = listRoleId === null ? null : roles.listRole(listRoleId);
    const sort = (field: string, label: string) => (
      <SortLink base={base} params={params} field={field} label={label} />
    );
    return {
      title: t.T("globals.terms.users"),
      pageId: "users.users",
      script: "users",
      translationKeys: [...userKeys, "users.type.api", "globals.terms.disabled"],
      body: (
        <section class="users" x-data="usersView">
          <header class="row page-header">
            <div class="col-4">
              <div class="hstack">
                <h1 class="page-title">
                  {t.T("globals.terms.users")} <span x-text="'(' + users.length + ')'"></span>
                </h1>
                {type === "api" ? (
                  <FilterBadge
                    t={t}
                    class="tag"
                    label={
                      <>
                        <Icon name="code" /> {t.T("users.type.api")}
                      </>
                    }
                    url={filterURL(base, params, "type")}
                  />
                ) : type ? (
                  <FilterBadge t={t} label={type} url={filterURL(base, params, "type")} />
                ) : null}
                {status === "enabled" || status === "disabled" ? (
                  <FilterBadge
                    t={t}
                    class={`enum status-${status}`}
                    label={
                      <>
                        <span class="dot">●</span> {t.T(`globals.terms.${status}`)}
                      </>
                    }
                    url={filterURL(base, params, "status")}
                  />
                ) : null}
                {userRole ? (
                  <FilterBadge
                    t={t}
                    label={
                      <>
                        <Icon name={userRole.id === 1n ? "star" : "user"} /> {userRole.name}
                      </>
                    }
                    url={filterURL(base, params, "user_role_id")}
                  />
                ) : null}
                {listRole ? (
                  <FilterBadge
                    t={t}
                    label={
                      <>
                        <Icon name="list" /> {listRole.name}
                      </>
                    }
                    url={filterURL(base, params, "list_role_id")}
                  />
                ) : null}
              </div>
            </div>
            <div class="col-8 hstack justify-end buttons">
              {manage ? (
                <a href={`${base}/new`} class="button" data-variant="primary" data-testid="btn-new">
                  <Icon name="plus" /> {t.T("globals.buttons.new")}
                </a>
              ) : null}
            </div>
          </header>
          <Alert name="error" />
          <div class="card page-content has-table">
            <div
              class="table-wrapper"
              x-data="table()"
              x-effect="total = users.length"
              x-bind:aria-busy="loading"
              x-on:change="onChange($event)"
            >
              {manage ? (
                <template x-if="numSelected > 0">
                  <ot-dropdown class="bulk-actions" data-variant="primary">
                    <button
                      popovertarget="bulk-actions"
                      type="button"
                      class="small"
                      data-testid="btn-bulk-actions"
                    >
                      <span x-text="numSelectedLabel"></span> <Icon name="more-vertical" />
                    </button>
                    <menu popover="" id="bulk-actions">
                      <button
                        type="button"
                        role="menuitem"
                        class="ghost"
                        data-variant="danger"
                        data-testid="btn-delete-users"
                        x-bind:disabled="isLoading('users')"
                        {...{
                          "x-on:click.prevent":
                            "onDeleteSelected(numSelected, selectedQueryParams().toString())",
                        }}
                      >
                        <Icon name="trash-2" /> {t.T("globals.buttons.delete")}{" "}
                        <span x-text="numSelected"></span>
                      </button>
                    </menu>
                  </ot-dropdown>
                </template>
              ) : null}
              <table class={manage ? "has-select" : ""}>
                <thead>
                  <tr>
                    {manage ? (
                      <th width="5%">
                        <input type="checkbox" aria-label={t.T("globals.buttons.toggleSelect")} />
                      </th>
                    ) : null}
                    <th>{sort("username", t.T("globals.fields.username"))}</th>
                    <th>{sort("email", t.T("globals.fields.email"))}</th>
                    <th>{t.Tc("users.userRole", 1)}</th>
                    <th>{t.Tc("users.listRole", 2)}</th>
                    <th>{sort("created_at", t.T("globals.fields.createdAt"))}</th>
                    <th>{sort("loggedin_at", t.T("globals.fields.lastLogin"))}</th>
                    <th class="actions align-right"></th>
                  </tr>
                </thead>
                <tbody>
                  <template x-for="r in users" x-bind:key="r.id">
                    <Row t={t} manage={manage} />
                  </template>
                  <EmptyRow
                    when="!loading && !error && !users.length"
                    colspan={manage ? 8 : 7}
                    t={t}
                  />
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ),
    };
  };
