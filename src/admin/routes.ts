// Route registration adapted from listmonk cmd/handlers.go at 6fcd95f.
//
// To add a view: write src/admin/views/<name>.tsx exporting an AdminView, then give it one
// `page` line below with upstream's path and permissions (any one of them is enough). Replace
// its `notYet` line if it has one. A module in assets/admin/js/views/<name>.js is built by itself
// and loaded by returning `script: "<name>"` from the view.
import { createAdminPages, type AdminSite, type AdminView } from "@/admin/page";
import { createPasswordReset, type ResetDeps } from "@/admin/password-reset";
import { dashboardView } from "@/admin/views/dashboard";
import { notYet } from "@/admin/views/not-yet";
import { profileView } from "@/admin/views/profile";
import type { Roles } from "@/roles/roles";
import { HttpError } from "@/server/response";
import type { Router } from "@/server/router";

export interface AdminDeps extends ResetDeps {
  roles: Roles;
  site: () => AdminSite;
}

export function registerAdminRoutes(router: Router, deps: AdminDeps): void {
  const { auth, roles, site } = deps;
  const { adminPage } = createAdminPages({ auth, roles, site });
  const page = (path: string, view: AdminView, ...permissions: string[]) =>
    router.route("GET", path, adminPage(view, ...permissions));

  page("/admin", dashboardView);
  page("/admin/user/profile", profileView);

  // Navigation targets that later M4 tasks port.
  page("/admin/lists", notYet("lists.all", "globals.terms.lists"));
  page("/admin/lists/analytics", notYet("lists.analytics", "globals.terms.analytics"));
  page("/admin/lists/forms", notYet("lists.forms", "globals.terms.forms"));
  const anySubscribers = ["subscribers:get_all", "subscribers:get"];
  page(
    "/admin/subscribers",
    notYet("subscribers.all", "globals.terms.subscribers"),
    ...anySubscribers,
  );
  page(
    "/admin/subscribers/import",
    notYet("subscribers.import", "globals.terms.import"),
    "subscribers:import",
  );
  page(
    "/admin/subscribers/bounces",
    notYet("subscribers.bounces", "globals.terms.bounces"),
    "bounces:get",
  );
  const anyCampaigns = ["campaigns:get_all", "campaigns:get"];
  page("/admin/campaigns", notYet("campaigns.all", "globals.terms.campaigns"), ...anyCampaigns);
  page(
    "/admin/campaigns/new",
    notYet("campaigns.new", "globals.terms.campaigns"),
    "campaigns:manage_all",
    "campaigns:manage",
  );
  page("/admin/campaigns/media", notYet("campaigns.media", "globals.terms.media"), "media:get");
  page(
    "/admin/campaigns/analytics",
    notYet("campaigns.analytics", "globals.terms.analytics"),
    "campaigns:get_analytics",
  );
  page(
    "/admin/templates",
    notYet("campaigns.templates", "globals.terms.templates"),
    "templates:get",
  );
  page("/admin/users", notYet("users.users", "globals.terms.users"), "users:get");
  page("/admin/users/roles", notYet("users.user-roles", "users.userRoles"), "roles:get");
  page("/admin/users/roles/lists", notYet("users.list-roles", "users.listRoles"), "roles:get");
  page("/admin/settings", notYet("settings.all", "globals.terms.settings"), "settings:get");
  page("/admin/settings/logs", notYet("settings.logs", "globals.terms.logs"), "settings:get");
  page(
    "/admin/settings/maintenance",
    notYet("settings.maintenance", "globals.terms.maintenance"),
    "settings:maintain",
  );

  const reset = createPasswordReset(deps);
  router.route("GET", "/admin/forgot", reset.getForgot);
  router.route("POST", "/admin/forgot", reset.postForgot);
  router.route("GET", "/admin/reset", reset.getReset);
  router.route("POST", "/admin/reset", reset.postReset);

  router.notFound(
    "/admin/",
    adminPage(() => {
      throw new HttpError(404, "404 page not found");
    }),
  );
}
