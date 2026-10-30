// Adapted from listmonk static/admin/partials/sidebar.html at 6fcd95f.
import type { NavigationGroup, NavigationLink } from "@/admin/layout/shell";
import type { Translation } from "@/i18n/i18n";

type Can = (...permissions: string[]) => boolean;

/** Upstream's navigation for this user. A link to an unported view still has its route. */
export function sidebar(
  pageId: string,
  t: Translation,
  can: Can,
  now: Date,
): (NavigationLink | NavigationGroup)[] {
  const link = (id: string, label: string, href: string): NavigationLink => ({
    label,
    href,
    ...(pageId === id ? { current: true } : {}),
  });
  const group = (
    id: string,
    icon: string,
    label: string,
    links: (NavigationLink | false)[],
  ): NavigationGroup => ({
    label,
    icon,
    open: pageId === id || pageId.startsWith(`${id}.`),
    links: links.filter((item) => item !== false),
  });
  const threeMonthsAgo = new Date(now);
  threeMonthsAgo.setUTCMonth(threeMonthsAgo.getUTCMonth() - 3);
  const items: (NavigationLink | NavigationGroup)[] = [
    link("dashboard", t.T("globals.terms.dashboard"), "/admin"),
    group("lists", "list", t.T("globals.terms.lists"), [
      link("lists.all", t.T("menu.allLists"), "/admin/lists"),
      link("lists.archived", t.T("globals.terms.archived"), "/admin/lists?status=archived"),
      link(
        "lists.analytics",
        t.T("globals.terms.analytics"),
        `/admin/lists/analytics?from=${threeMonthsAgo.toISOString().slice(0, 10)}`,
      ),
      link("lists.forms", t.T("globals.terms.forms"), "/admin/lists/forms"),
    ]),
  ];
  if (
    can(
      "subscribers:get",
      "subscribers:get_all",
      "subscribers:manage",
      "subscribers:import",
      "bounces:get",
    )
  )
    items.push(
      group("subscribers", "at-sign", t.T("globals.terms.subscribers"), [
        can("subscribers:get", "subscribers:get_all") &&
          link("subscribers.all", t.T("menu.allSubscribers"), "/admin/subscribers"),
        can("subscribers:import") &&
          link("subscribers.import", t.T("globals.terms.import"), "/admin/subscribers/import"),
        can("bounces:get") &&
          link("subscribers.bounces", t.T("globals.terms.bounces"), "/admin/subscribers/bounces"),
      ]),
    );
  if (
    can(
      "campaigns:get",
      "campaigns:get_all",
      "campaigns:manage",
      "campaigns:manage_all",
      "campaigns:get_analytics",
      "media:get",
      "templates:get",
    )
  )
    items.push(
      group("campaigns", "send", t.T("globals.terms.campaigns"), [
        can("campaigns:get", "campaigns:get_all") &&
          link("campaigns.all", t.T("menu.allCampaigns"), "/admin/campaigns"),
        can("campaigns:manage", "campaigns:manage_all") &&
          link("campaigns.new", t.T("globals.buttons.createNew"), "/admin/campaigns/new"),
        can("media:get", "media:manage") &&
          link("campaigns.media", t.T("globals.terms.media"), "/admin/campaigns/media"),
        can("templates:get") &&
          link("campaigns.templates", t.T("globals.terms.templates"), "/admin/templates"),
        can("campaigns:get_analytics") &&
          link("campaigns.analytics", t.T("globals.terms.analytics"), "/admin/campaigns/analytics"),
      ]),
    );
  if (can("users:get", "users:manage", "roles:get", "roles:manage"))
    items.push(
      group("users", "users", t.T("globals.terms.users"), [
        can("users:get") && link("users.users", t.T("globals.terms.users"), "/admin/users"),
        can("roles:get") && link("users.user-roles", t.T("users.userRoles"), "/admin/users/roles"),
        can("roles:get") &&
          link("users.list-roles", t.T("users.listRoles"), "/admin/users/roles/lists"),
      ]),
    );
  if (can("settings:get", "settings:manage", "settings:maintain"))
    items.push(
      group("settings", "settings", t.T("globals.terms.settings"), [
        can("settings:get") &&
          link("settings.all", t.T("globals.terms.settings"), "/admin/settings"),
        can("settings:get") &&
          link("settings.logs", t.T("globals.terms.logs"), "/admin/settings/logs"),
        can("settings:maintain") &&
          link(
            "settings.maintenance",
            t.T("globals.terms.maintenance"),
            "/admin/settings/maintenance",
          ),
      ]),
    );
  return items;
}
