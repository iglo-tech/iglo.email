// Adapted from listmonk cmd/campaign_analytics.go (getAnalytics), cmd/dashboard.go
// (getDashboardCampaigns) and cmd/admin.go (GetDashboardCharts, GetDashboardCounts) at 6fcd95f.
// GET /api/sends/analytics is native. Reads run in the reader child; see src/analytics/reader.ts.
import { parseBound } from "@/analytics/dates";
import { ReaderError, type AnalyticsReader } from "@/analytics/reader";
import type { CountType, Interval, Range } from "@/analytics/store";
import type { Summaries, SummaryName } from "@/analytics/summaries";
import type { CampaignStore, Scope } from "@/campaigns/store";
import type { Roles } from "@/roles/roles";
import type { Handler, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import { strHasLen } from "@/server/validation";
import type { Authentication } from "@/users/auth";

const intervals = ["hour", "day", "week", "month"];
const campaignTypes = ["views", "clicks", "total_views", "total_clicks", "bounces"];
const listTypes = [...campaignTypes, "subscriptions", "unsubscriptions"];
/** A page of the sequence list. */
const MAX_SEQUENCE_IDS = 100;

export interface AnalyticsSettings {
  individualTracking: boolean;
  cacheSlowQueries: boolean;
}
export interface AnalyticsDeps {
  reader: AnalyticsReader;
  summaries: Summaries;
  campaigns: CampaignStore;
  roles: Roles;
  auth: Authentication;
  settings: () => AnalyticsSettings;
}

export function registerAnalyticsRoutes(router: Router, deps: AnalyticsDeps) {
  const { reader, summaries, campaigns, roles, auth, settings } = deps;
  const identity = (context: RequestContext) => {
    if (!context.identity) throw new Error("Authenticated identity required");
    return context.identity;
  };
  const can = (context: RequestContext, permission: string) =>
    roles.can(identity(context).role, permission);
  /** User.GetPermittedLists(PermTypeGet | PermTypeManage). */
  const permitted = (context: RequestContext): Scope => {
    const { role, user } = identity(context);
    const manage = roles.listScope(role, user.list_role_id, "list:manage");
    const get = roles.listScope(role, user.list_role_id, "list:get");
    if (get.all || manage.all) return { all: true, ids: [] };
    return get.ids.length ? get : manage;
  };
  const scope = (context: RequestContext): Scope =>
    can(context, "campaigns:get_all") ? { all: true, ids: [] } : permitted(context);

  const t = (context: RequestContext) => context.app.i18n;
  const invalidData = (context: RequestContext) =>
    new HttpError(400, t(context).T("globals.messages.invalidData"));
  const invalidDates = (context: RequestContext) =>
    new HttpError(400, t(context).T("analytics.invalidDates"));
  /** A body the child already serialized, with the headers of ok(). */
  const body = (bytes: Uint8Array<ArrayBuffer> | string) =>
    new Response(bytes, { headers: { "Content-Type": "application/json" } });
  const refused: Partial<Record<ReaderError["kind"], [number, string]>> = {
    busy: [429, "Too many analytics reads in progress."],
    limit: [422, "Analytics result too large. Narrow the range, the IDs or the interval."],
    cancelled: [499, "Client closed the request."],
    closed: [503, "The server is shutting down."],
  };
  const served = async (
    context: RequestContext,
    read: (signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer> | string>,
  ) => {
    try {
      return body(await read(context.request.signal));
    } catch (error) {
      const answer = error instanceof ReaderError ? refused[error.kind] : undefined;
      if (answer) throw new HttpError(...answer);
      context.app.logger.error(error);
      throw new HttpError(
        500,
        t(context).Ts(
          "globals.messages.errorFetching",
          "name",
          "{globals.terms.analytics}",
          "error",
          error instanceof Error ? error.message : "",
        ),
      );
    }
  };
  /** parseStringIDs, as canonical decimal text. */
  const parseIDs = (context: RequestContext) => {
    const invalid = (error: string) =>
      new HttpError(400, t(context).Ts("globals.messages.errorInvalidIDs", "error", error));
    const ids = context.url.searchParams.getAll("id").map((value) => {
      const quoted = JSON.stringify(value);
      if (!/^[+-]?\d+$/.test(value))
        throw invalid(`strconv.Atoi: parsing ${quoted}: invalid syntax`);
      const id = BigInt(value);
      if (id < -9223372036854775808n || id > 9223372036854775807n)
        throw invalid(`strconv.Atoi: parsing ${quoted}: value out of range`);
      if (id < 1n) throw invalid(`${id} is not a valid ID`);
      return id;
    });
    if (!ids.length)
      throw new HttpError(400, t(context).Ts("globals.messages.missingFields", "name", "`id`"));
    return ids;
  };
  /** The from and to query values: 10 to 30 bytes, in a form src/analytics/dates.ts accepts. */
  const parseRange = (context: RequestContext): Range => {
    const params = context.url.searchParams;
    const from = params.get("from") ?? "";
    const to = params.get("to") ?? "";
    if (!strHasLen(from, 10, 30) || !strHasLen(to, 10, 30)) throw invalidDates(context);
    const range = { from: parseBound(from, "up"), to: parseBound(to, "down") };
    if (range.from === null || range.to === null) throw invalidDates(context);
    return range as Range;
  };

  /** getAnalytics. */
  const analytics =
    (resource: "campaign" | "list"): Handler =>
    async (context) => {
      const ids = parseIDs(context);
      const type = context.params.type ?? "";
      if (resource === "list") {
        const { role, user } = identity(context);
        if (!roles.canList(role, user.list_role_id, "list:get", ids))
          throw new HttpError(403, "permission denied");
        // Match the list page: campaign metrics require campaign analytics access.
        if (
          type !== "subscriptions" &&
          type !== "unsubscriptions" &&
          (!(can(context, "campaigns:get") || can(context, "campaigns:get_all")) ||
            !can(context, "campaigns:get_analytics"))
        )
          throw new HttpError(403, "permission denied");
      } else if (!can(context, "campaigns:get_all")) {
        // checkCampaignPerm: access through the campaign's lists.
        const allowed = permitted(context);
        for (const id of ids)
          if (!allowed.all && !campaigns.hasLists(id, allowed.ids))
            throw new HttpError(
              403,
              t(context).Ts("globals.messages.permissionDenied", "name", "campaigns:get"),
            );
      }
      const range = parseRange(context);
      const { individualTracking } = settings();
      const text = ids.map(String);
      if (type === "links")
        return served(context, (signal) =>
          reader.read("links", [resource, text, range, individualTracking], signal),
        );

      const params = context.url.searchParams;
      const interval = params.get("interval") || "day";
      // Views and clicks default to totals; unique counts need individual tracking.
      let counted = type;
      if (params.get("unique") !== "true" || !individualTracking) {
        if (type === "views") counted = "total_views";
        if (type === "clicks") counted = "total_clicks";
      }
      if (!(resource === "list" ? listTypes : campaignTypes).includes(counted))
        throw invalidData(context);
      if (!intervals.includes(interval)) throw invalidData(context);
      return served(context, (signal) =>
        reader.read(
          resource === "list" ? "listCounts" : "campaignCounts",
          [counted as CountType, text, range, interval as Interval],
          signal,
        ),
      );
    };

  const dashboard =
    (name: SummaryName, live: "dashboardCounts" | "dashboardCharts"): Handler =>
    (context) =>
      served(context, async (signal) =>
        // A cached read may start the shared refresh, which outlives one client.
        settings().cacheSlowQueries
          ? ok(await summaries.read(name)).text()
          : reader.read(live, [], signal),
      );

  /** getDashboardCampaigns. */
  const dashboardCampaigns: Handler = (context) => {
    const { all, ids } = scope(context);
    return served(context, (signal) =>
      reader.read("dashboardCampaigns", [all, ids.map(String)], signal),
    );
  };

  /** Native: sends by template or by sequence step; 07-api-and-ui.md. */
  const sendAnalytics: Handler = (context) => {
    const range = parseRange(context);
    const group = context.url.searchParams.get("group_by") ?? "template";
    if (group !== "template" && group !== "step") throw invalidData(context);
    return served(context, (signal) => reader.read("sends", [group, range], signal));
  };

  /** Native: the counts of a page of sequences; 07-api-and-ui.md. */
  const sequenceCounts: Handler = (context) => {
    const ids = parseIDs(context);
    if (ids.length > MAX_SEQUENCE_IDS) throw invalidData(context);
    return served(context, (signal) => reader.read("sequenceCounts", [ids.map(String)], signal));
  };

  router.route(
    "GET",
    "/api/dashboard/counts",
    dashboard("dashboard_counts", "dashboardCounts"),
    auth.middleware(),
  );
  router.route(
    "GET",
    "/api/dashboard/charts",
    dashboard("dashboard_charts", "dashboardCharts"),
    auth.middleware(),
  );
  router.route("GET", "/api/dashboard/campaigns", dashboardCampaigns, auth.middleware());
  router.route(
    "GET",
    "/api/campaigns/analytics/:type",
    analytics("campaign"),
    auth.middleware("campaigns:get_analytics"),
  );
  router.route("GET", "/api/lists/analytics/:type", analytics("list"), auth.middleware());
  router.route("GET", "/api/sends/analytics", sendAnalytics, auth.middleware("sends:get"));
  router.route("GET", "/api/sequences/counts", sequenceCounts, auth.middleware("sequences:get"));
}
