// Route registration adapted from listmonk cmd/handlers.go at 6fcd95f.
//
// To add a view: write src/admin/views/<name>.tsx exporting an AdminView, then give it one
// `page` line below with upstream's path and permissions (any one of them is enough). A module in
// assets/admin/js/views/<name>.js is built by itself and loaded by returning `script: "<name>"`
// from the view.
import { createAdminPages, type AdminSite, type AdminView } from "@/admin/page";
import { createPasswordReset, type ResetDeps } from "@/admin/password-reset";
import { adminPolicyHeader } from "@/admin/policy";
import { analyticsView } from "@/admin/views/analytics";
import { bouncesView } from "@/admin/views/bounces";
import { campaignView, newCampaignView } from "@/admin/views/campaign";
import { campaignsView } from "@/admin/views/campaigns";
import { dashboardView } from "@/admin/views/dashboard";
import { enrollmentsView, enrollmentView } from "@/admin/views/enrollments";
import { formsView } from "@/admin/views/forms";
import { importView } from "@/admin/views/import";
import { listView, newListView } from "@/admin/views/list";
import { listsView } from "@/admin/views/lists";
import { logsView } from "@/admin/views/logs";
import { maintenanceView } from "@/admin/views/maintenance";
import { mediaFragmentView, mediaView } from "@/admin/views/media";
import { profileView } from "@/admin/views/profile";
import { listRoleView, userRoleView } from "@/admin/views/role";
import { rolesView } from "@/admin/views/roles";
import { editSequenceView, newSequenceView } from "@/admin/views/sequence";
import { sequencesView } from "@/admin/views/sequences";
import { settingsView } from "@/admin/views/settings";
import { newSubscriberView, subscriberView } from "@/admin/views/subscriber";
import { subscribersView } from "@/admin/views/subscribers";
import { editTemplateView, newTemplateView } from "@/admin/views/template";
import { templatesView } from "@/admin/views/templates";
import { userView } from "@/admin/views/user";
import { usersView } from "@/admin/views/users";
import type { Roles } from "@/roles/roles";
import { HttpError } from "@/server/response";
import type { Router } from "@/server/router";
import { hasID } from "@/server/validation";

export interface AdminDeps extends ResetDeps {
  roles: Roles;
  site: () => AdminSite;
}

/** The hasID middleware inside adminPage, so its 400 is the admin error page. */
const checkedID =
  (view: AdminView): AdminView =>
  async (request) => {
    await hasID(request.context, async () => new Response());
    return view(request);
  };

export function registerAdminRoutes(router: Router, deps: AdminDeps): void {
  const { auth, roles, site } = deps;
  const { adminPage } = createAdminPages({ auth, roles, site });
  router.use(adminPolicyHeader(site));
  const page = (path: string, view: AdminView, ...permissions: string[]) =>
    router.route("GET", path, adminPage(view, ...permissions));
  const withID = (path: string, view: AdminView, ...permissions: string[]) =>
    page(path, checkedID(view), ...permissions);

  // Appearance settings as authored: only pages behind this session check load them.
  const custom =
    (type: string, value: (site: AdminSite) => string): AdminView =>
    ({ site: current }) =>
      new Response(value(current), {
        headers: { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" },
      });
  page(
    "/admin/custom.css",
    custom("text/css", (current) => current.customCss),
  );
  page(
    "/admin/custom.js",
    custom("application/javascript", (current) => current.customJs),
  );
  page("/admin", dashboardView);
  page("/admin/user/profile", profileView);

  page("/admin/lists", listsView);
  page("/admin/lists/new", newListView, "lists:manage_all");
  withID("/admin/lists/:id", listView("list"));
  withID("/admin/lists/:id/edit", listView("edit"));

  page("/admin/lists/analytics", analyticsView("lists"));
  page("/admin/lists/forms", formsView);
  const anySubscribers = ["subscribers:get_all", "subscribers:get"];
  page("/admin/subscribers", subscribersView, ...anySubscribers);
  page("/admin/subscribers/new", newSubscriberView, "subscribers:manage");
  withID("/admin/subscribers/lists/:id", subscribersView, ...anySubscribers);
  withID("/admin/subscribers/:id", subscriberView("activity"), ...anySubscribers);
  withID("/admin/subscribers/:id/edit", subscriberView("edit"), ...anySubscribers);
  withID("/admin/subscribers/:id/lists", subscriberView("lists"), ...anySubscribers);
  withID("/admin/subscribers/:id/bounces", subscriberView("bounces"), ...anySubscribers);
  withID("/admin/subscribers/:id/events", subscriberView("events"), ...anySubscribers);
  withID("/admin/subscribers/:id/enrollments", subscriberView("enrollments"), ...anySubscribers);
  withID("/admin/subscribers/:id/sends", subscriberView("sends"), ...anySubscribers);
  page("/admin/subscribers/import", importView, "subscribers:import");
  page("/admin/subscribers/bounces", bouncesView, "bounces:get");
  const anyCampaigns = ["campaigns:get_all", "campaigns:get"];
  page("/admin/campaigns", campaignsView, ...anyCampaigns);
  page("/admin/campaigns/new", newCampaignView, "campaigns:manage_all", "campaigns:manage");
  withID("/admin/campaigns/:id", campaignView, ...anyCampaigns);
  withID("/admin/campaigns/:id/:tab", campaignView, ...anyCampaigns);
  page("/admin/campaigns/media", mediaView, "media:get");
  page("/admin/campaigns/media/fragment", mediaFragmentView, "media:get");
  page("/admin/campaigns/analytics", analyticsView("campaigns"), "campaigns:get_analytics");
  page("/admin/templates", templatesView, "templates:get");
  page("/admin/templates/new", newTemplateView, "templates:manage");
  withID("/admin/templates/:id", editTemplateView, "templates:get");
  page("/admin/sequences", sequencesView, "sequences:get");
  page("/admin/sequences/new", newSequenceView, "sequences:manage");
  page("/admin/sequences/enrollments", enrollmentsView, "sequences:get");
  withID("/admin/sequences/enrollments/:id", enrollmentView, "sequences:get");
  withID("/admin/sequences/:id", editSequenceView, "sequences:get");
  page("/admin/users", usersView(roles), "users:get");
  page("/admin/users/new", userView(roles, true), "users:manage");
  page("/admin/users/roles", rolesView("user"), "roles:get");
  page("/admin/users/roles/new", userRoleView(roles, true), "roles:manage");
  page("/admin/users/roles/lists", rolesView("list"), "roles:get");
  page("/admin/users/roles/lists/new", listRoleView(roles, true), "roles:manage");
  withID("/admin/users/roles/lists/:id", listRoleView(roles, false), "roles:get");
  withID("/admin/users/roles/:id", userRoleView(roles, false), "roles:get");
  withID("/admin/users/:id", userView(roles, false), "users:get");
  page("/admin/settings", settingsView, "settings:get");
  page("/admin/settings/logs", logsView, "settings:get");
  page("/admin/settings/maintenance", maintenanceView, "settings:maintain");

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
