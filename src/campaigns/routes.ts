// Campaign HTTP endpoints adapted from listmonk cmd/campaigns.go and the /api/campaigns
// routes in cmd/handlers.go at 6fcd95f. Analytics and running stats are M3.3; sending to
// lists is the M3.2 runner: status changes here only record the state.
import type { EmbedImages, InlineImage } from "@/media/embed";
import type { Message } from "@/messaging/email";
import { publicMessage } from "@/public/message";
import type { ListReferences } from "@/lists/references";
import type { Roles } from "@/roles/roles";
import type { Handler, Middleware, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import { getID, hasID } from "@/server/validation";
import type { SubscriberStore } from "@/subscribers/store";
import type { TemplateRenderer } from "@/templates/renderer";
import { createMessageBudget, RenderCapacityError } from "@/templates/renderer";
import type { TemplateStore } from "@/templates/store";
import type { Tracking } from "@/unsubscribe/tracking";
import type { Authentication } from "@/users/auth";
import { convertContent } from "@/campaigns/content";
import {
  bindCampaign,
  emptyCampaign,
  mergeCampaign,
  readCampaignBody,
  slug,
  validateCampaign,
  type CampaignRequest,
} from "@/campaigns/input";
import { optinBody } from "@/campaigns/optin";
import {
  CampaignSourceError,
  archiveSubscriber,
  compileCampaign,
  dummySubscriber,
  dummyUUID,
  type CampaignSubscriber,
  type MessageCampaign,
} from "@/campaigns/render";
import {
  CampaignError,
  type CampaignFilter,
  type CampaignRow,
  type CampaignStore,
  type Scope,
  type WritableCampaign,
} from "@/campaigns/store";

export interface CampaignSettings {
  fromEmail: string;
  rootUrl: string;
  siteName: string;
  /** "email" and the names of enabled SMTP servers (listmonk's messengers). */
  messengers: string[];
  unsubscribeHeader: boolean;
  disableTracking: boolean;
  individualTracking: boolean;
}
export interface CampaignDeps {
  store: CampaignStore;
  templates: TemplateStore;
  renderer: TemplateRenderer;
  roles: Roles;
  auth: Authentication;
  lists: ListReferences;
  subscribers: SubscriberStore;
  tracking: Tracking;
  emailer: {
    push(message: Message, delivery?: { copies?: boolean }): { result: Promise<unknown> };
  };
  settings: () => CampaignSettings;
  /** Reads files, so a caller holds no transaction. */
  attachments(ids: bigint[], inline: InlineImage[]): Promise<NonNullable<Message["attachments"]>>;
  embedImages: EmbedImages;
}

const idValue = (id: bigint | null) =>
  id === null
    ? null
    : id <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(id)
      : (JSON as typeof JSON & { rawJSON(value: string): object }).rawJSON(id.toString());
/** models.Campaign JSON in field order. */
export function projectCampaign(row: CampaignRow, noBody = false) {
  return {
    id: idValue(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    views: Number(row.views),
    clicks: Number(row.clicks),
    bounces: Number(row.bounces),
    lists: JSON.parse(row.lists),
    media: JSON.parse(row.media),
    started_at: row.started_at,
    to_send: Number(row.to_send),
    sent: Number(row.sent),
    uuid: row.uuid,
    type: row.type,
    name: row.name,
    subject: row.subject,
    from_email: row.from_email,
    body: noBody ? "" : row.body,
    body_source: row.body_source,
    altbody: row.altbody,
    send_at: row.send_at,
    status: row.status,
    content_type: row.content_type,
    tags: row.tags ? JSON.parse(row.tags) : [],
    headers: JSON.parse(row.headers),
    attribs: JSON.parse(row.attribs),
    template_id: idValue(row.template_id),
    messenger: row.messenger,
    archive: row.archive === 1n,
    archive_slug: row.archive_slug,
    archive_template_id: idValue(row.archive_template_id),
    archive_meta: JSON.parse(row.archive_meta),
  };
}
export const writable = (row: CampaignRow): WritableCampaign => ({
  type: row.type,
  name: row.name,
  subject: row.subject,
  from_email: row.from_email,
  body: row.body,
  body_source: row.body_source,
  altbody: row.altbody,
  content_type: row.content_type,
  send_at: row.send_at,
  headers: JSON.parse(row.headers),
  attribs: JSON.parse(row.attribs),
  tags: row.tags ? JSON.parse(row.tags) : [],
  messenger: row.messenger,
  template_id: row.template_id,
  archive: row.archive === 1n,
  archive_slug: row.archive_slug,
  archive_template_id: row.archive_template_id,
  archive_meta: JSON.parse(row.archive_meta),
});
const truthy = (value: string | null) =>
  ["1", "t", "T", "TRUE", "true", "True"].includes(value ?? "");
/** Go strconv.Atoi with errors ignored. */
const atoi = (value: string | null | undefined) => {
  if (!value || !/^[+-]?\d+$/.test(value)) return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : 0;
};
const editable = (status: string) =>
  status === "draft" || status === "paused" || status === "scheduled";
const previewHeaders = {
  "Content-Type": "text/html; charset=UTF-8",
  // D54: email previews need no scripts, popups, forms or external fetches.
  "Content-Security-Policy":
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
};
const FORM_LIMIT = 2 * 1024 * 1024;
/** Echo FormValue: url-encoded or multipart body fields, then query parameters. */
async function formValues(context: RequestContext): Promise<(key: string) => string | null> {
  const query = context.url.searchParams;
  if (context.request.method === "GET") return (key) => query.get(key);
  const media = context.request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (Number(context.request.headers.get("content-length")) > FORM_LIMIT) throw new HttpError(413);
  const bytes = new Uint8Array(await context.request.arrayBuffer());
  if (bytes.length > FORM_LIMIT) throw new HttpError(413);
  let form: URLSearchParams | FormData | null = null;
  if (media === "application/x-www-form-urlencoded")
    form = new URLSearchParams(Buffer.from(bytes).toString("utf8"));
  else if (media === "multipart/form-data" && bytes.length)
    try {
      form = await new Request("http://form.invalid", {
        method: "POST",
        headers: { "content-type": context.request.headers.get("content-type")! },
        body: bytes,
      }).formData();
    } catch {
      throw new HttpError(400);
    }
  return (key) => {
    const value = form?.get(key);
    return typeof value === "string" ? value : query.get(key);
  };
}

export function registerCampaignRoutes(router: Router, deps: CampaignDeps) {
  const { store, roles, auth } = deps;
  const identity = (context: RequestContext) => {
    if (!context.identity) throw new Error("Authenticated identity required");
    return context.identity;
  };
  const can = (context: RequestContext, permission: string) =>
    roles.can(identity(context).role, permission);
  /** auth.Perm: any of the permissions; the message names the last one checked. */
  const any =
    (...permissions: string[]): Middleware =>
    (context, next) => {
      if (!permissions.some((p) => can(context, p)))
        throw new HttpError(403, `permission denied: ${permissions.at(-1)}`);
      return next();
    };
  const recheck = (context: RequestContext, ...permissions: string[]) => {
    auth.revalidate(context);
    if (!permissions.some((p) => can(context, p)))
      throw new HttpError(403, `permission denied: ${permissions.at(-1)}`);
  };
  /** User.GetPermittedLists: get|manage uses get grants when there are any. */
  const permitted = (context: RequestContext, manage: boolean): Scope => {
    const { role, user } = identity(context);
    const manageScope = roles.listScope(role, user.list_role_id, "list:manage");
    if (manage) return manageScope;
    const getScope = roles.listScope(role, user.list_role_id, "list:get");
    if (getScope.all || manageScope.all) return { all: true, ids: [] };
    return getScope.ids.length ? getScope : manageScope;
  };
  /** User.FilterListsByPerm for list:manage. */
  const manageable = (context: RequestContext, ids: bigint[]) => {
    const scope = permitted(context, true);
    return scope.all ? ids : ids.filter((id) => scope.ids.includes(id));
  };
  const t = (context: RequestContext) => context.app.i18n;
  const notFound = (context: RequestContext) =>
    new HttpError(
      400,
      t(context).Ts("globals.messages.notFound", "name", "{globals.terms.campaign}"),
    );
  /** checkCampaignPerm. */
  const checkCampaign = (context: RequestContext, manage: boolean, id: bigint) => {
    if (can(context, manage ? "campaigns:manage_all" : "campaigns:get_all")) return;
    const scope = permitted(context, manage);
    if (!scope.all && !store.hasLists(id, scope.ids))
      throw new HttpError(
        403,
        t(context).Ts(
          "globals.messages.permissionDenied",
          "name",
          manage ? "campaigns:manage" : "campaigns:get",
        ),
      );
  };
  const row = (context: RequestContext, id: bigint) =>
    store.get(id) ??
    (() => {
      throw notFound(context);
    })();
  const translate = (context: RequestContext, error: unknown): never => {
    if (error instanceof CampaignError) {
      if (error.reason === "missing") throw notFound(context);
      if (error.reason === "slug")
        // D-campaign-slug: a safe conflict instead of upstream's database error.
        throw new HttpError(409, "Archive slug already exists.");
      if (error.reason === "template")
        throw new HttpError(
          400,
          t(context).Ts("globals.messages.invalidFields", "name", "template_id"),
        );
      const key = error.reason.slice("status:".length);
      if (key === "invalid")
        throw new HttpError(400, t(context).Ts("globals.messages.invalidFields", "name", "status"));
      throw new HttpError(400, t(context).T(`campaigns.${key}`));
    }
    throw error;
  };
  const policy = (context: RequestContext) => {
    const current = deps.settings();
    return {
      t: t(context),
      defaultFrom: current.fromEmail,
      now: context.app.clock.now(),
      messengers: current.messengers,
      compile(value: WritableCampaign) {
        try {
          compileCampaign(deps.renderer, { ...value, uuid: dummyUUID, templateBody: "" });
          return null;
        } catch (error) {
          if (error instanceof CampaignSourceError) return `invalid ${error.field}`;
          throw error;
        }
      },
    };
  };
  /** The template body a campaign renders with: a chosen ID or the stored one, else none. */
  const templateBody = (id: bigint | null) =>
    id === null ? "" : (deps.templates.get(id)?.body ?? "");
  const renderFailure = (context: RequestContext, error: unknown, key: string): never => {
    if (error instanceof HttpError) throw error;
    if (error instanceof RenderCapacityError)
      throw new HttpError(429, "Too many template renders in progress.");
    throw new HttpError(
      400,
      t(context).Ts(
        key,
        "error",
        error instanceof CampaignSourceError ? `invalid ${error.field}` : "invalid template",
      ),
    );
  };
  const subscriberContext = (sub: {
    uuid: string;
    email: string;
    name: string;
    attribs: string;
    external_id: string | null;
  }): CampaignSubscriber => ({
    uuid: sub.uuid,
    email: sub.email,
    name: sub.name,
    attribs: JSON.parse(sub.attribs),
    external_id: sub.external_id ?? "",
  });

  const collection: Handler = (context) => {
    const params = context.url.searchParams;
    const scope = can(context, "campaigns:get_all")
      ? { all: true, ids: [] }
      : permitted(context, false);
    let page = atoi(params.get("page"));
    if (page < 1) page = 1;
    const rawPer = params.get("per_page");
    let perPage = rawPer === "all" ? 0 : atoi(rawPer);
    if (rawPer !== "all" && perPage < 1) perPage = 20;
    const query = (params.get("query") ?? "").trim().replace(/\s+/g, " ");
    const filter: CampaignFilter = {
      query,
      statuses: params.getAll("status"),
      tags: params.getAll("tag"),
      type: params.get("type") ?? "",
    };
    const offset = perPage ? Math.min((page - 1) * perPage, Number.MAX_SAFE_INTEGER) : 0;
    const result = store.query(
      filter,
      scope,
      params.get("order_by") ?? "",
      params.get("order") ?? "",
      offset,
      perPage,
    );
    if (!result.rows.length)
      return ok({ results: [], search: "", query: "", total: 0, per_page: 0, page: 0 });
    const noBody = truthy(params.get("no_body"));
    return ok({
      results: result.rows.map((r) => {
        const out = projectCampaign(r, noBody);
        if (noBody) out.body_source = null;
        return out;
      }),
      search: "",
      query,
      total: result.total,
      per_page: perPage,
      page: perPage ? page : 1,
    });
  };
  const one: Handler = (context) => {
    const id = BigInt(getID(context));
    checkCampaign(context, false, id);
    return ok(projectCampaign(row(context, id), truthy(context.url.searchParams.get("no_body"))));
  };
  const preview: Handler = async (context) => {
    const id = BigInt(getID(context));
    checkCampaign(context, false, id);
    const value = await formValues(context);
    auth.revalidate(context);
    checkCampaign(context, false, id);
    const contentType = value("content_type") ?? "";
    let templateId = atoi(value("template_id"));
    if (contentType === "visual" || templateId < 1) templateId = 0;
    const stored = row(context, id);
    const campaign: MessageCampaign = {
      ...writable(stored),
      uuid: dummyUUID,
      templateBody: templateBody(templateId ? BigInt(templateId) : stored.template_id),
    };
    if (context.request.method === "POST") {
      campaign.content_type = contentType as MessageCampaign["content_type"];
      campaign.body = value("body") ?? "";
      if (contentType === "visual") campaign.templateBody = "";
    }
    let compiled;
    try {
      compiled = compileCampaign(deps.renderer, campaign);
    } catch (error) {
      return renderFailure(context, error, "templates.errorCompiling");
    }
    let body: string;
    try {
      body = compiled.render(dummySubscriber, {
        rootUrl: deps.settings().rootUrl,
        unsubscribeUrl: `${deps.settings().rootUrl.replace(/\/+$/, "")}/subscription/${dummyUUID}/${dummyUUID}`,
      }).body;
    } catch (error) {
      return renderFailure(context, error, "templates.errorRendering");
    }
    if (campaign.content_type === "plain")
      return new Response(body, { headers: { "Content-Type": "text/plain; charset=UTF-8" } });
    return new Response(body, { headers: previewHeaders });
  };
  const archivePreview: Handler = async (context) => {
    const id = BigInt(getID(context));
    checkCampaign(context, false, id);
    const value = await formValues(context);
    auth.revalidate(context);
    checkCampaign(context, false, id);
    const stored = row(context, id);
    const templateId = atoi(value("template_id"));
    const failed = () =>
      publicMessage(t(context), {
        status: 500,
        title: t(context).T("globals.terms.error"),
        message: t(context).T("public.errorFetchingCampaign"),
        siteName: deps.settings().siteName,
      });
    // compileArchiveCampaigns: archive_meta is the sample subscriber.
    let meta: Record<string, unknown>;
    try {
      const parsed = JSON.parse(value("archive_meta") ?? "") as unknown;
      if (parsed === null) meta = {};
      else if (typeof parsed !== "object" || Array.isArray(parsed)) return failed();
      else meta = parsed as Record<string, unknown>;
    } catch {
      return failed();
    }
    const subscriber = archiveSubscriber(meta);
    try {
      const body = compileCampaign(deps.renderer, {
        ...writable(stored),
        uuid: stored.uuid,
        templateBody: templateBody(templateId > 0 ? BigInt(templateId) : stored.template_id),
      }).render(subscriber, { rootUrl: deps.settings().rootUrl, unsubscribeUrl: "" }).body;
      return new Response(body, { headers: previewHeaders });
    } catch (error) {
      if (error instanceof RenderCapacityError)
        throw new HttpError(429, "Too many template renders in progress.");
      return failed();
    }
  };
  const content: Handler = async (context) => {
    const input = bindCampaign(await readCampaignBody(context.request));
    recheck(context, "campaigns:manage_all", "campaigns:manage");
    let out: string | null;
    try {
      out = convertContent(input.body ?? "", input.from ?? "", input.to ?? "");
    } catch {
      throw new HttpError(
        400,
        t(context).Ts("templates.errorCompiling", "error", "invalid markdown"),
      );
    }
    if (out === null) throw new HttpError(400, "unknown formats to convert");
    return ok(out);
  };
  const create: Handler = async (context) => {
    const input = bindCampaign(await readCampaignBody(context.request));
    recheck(context, "campaigns:manage_all", "campaigns:manage");
    const listIds = manageable(context, input.lists ?? []);
    let value = mergeCampaign(emptyCampaign, input);
    if (input.type === "optin") {
      if (!listIds.length) throw new HttpError(400, t(context).T("campaigns.fieldInvalidListIDs"));
      const lists = listIds
        .map((id) => deps.lists.subscriberMetadata(id))
        .filter((l) => l !== null && l.optin === "double")
        .sort((a, b) => a!.id - b!.id);
      if (!lists.length) throw new HttpError(400, t(context).T("campaigns.noOptinLists"));
      value = {
        ...value,
        type: "optin",
        body: optinBody(t(context), lists as NonNullable<(typeof lists)[number]>[]),
      };
    } else if (!input.type || input.type === "regular") value.type = "regular";
    else throw new HttpError(400, t(context).Ts("globals.messages.invalidFields", "name", "type"));
    if (!value.messenger) value.messenger = "email";
    value = validateCampaign(value, listIds, policy(context));
    if (input.archive_template_id !== undefined && input.archive_template_id !== null) {
      value.archive_template_id =
        input.archive_template_id !== 0n ? (input.template_id ?? null) : null;
    }
    try {
      return ok(projectCampaign(store.create(value, listIds, input.media ?? [])));
    } catch (error) {
      return translate(context, error);
    }
  };
  const update: Handler = async (context) => {
    const id = BigInt(getID(context));
    checkCampaign(context, true, id);
    if (!editable(row(context, id).status))
      throw new HttpError(400, t(context).T("campaigns.cantUpdate"));
    const input = bindCampaign(await readCampaignBody(context.request));
    recheck(context, "campaigns:manage_all", "campaigns:manage");
    checkCampaign(context, true, id);
    const listIds = manageable(context, input.lists ?? []);
    const fields = policy(context);
    try {
      return ok(
        projectCampaign(
          store.update(id, (current) => {
            if (!editable(current.status))
              throw new HttpError(400, t(context).T("campaigns.cantUpdate"));
            const merged = mergeCampaign(writable(current), input);
            merged.type = current.type;
            return {
              value: validateCampaign(merged, listIds, fields),
              listIds,
              mediaIds: input.media ?? [],
            };
          }),
        ),
      );
    } catch (error) {
      return translate(context, error);
    }
  };
  const status: Handler = async (context) => {
    const id = BigInt(getID(context));
    checkCampaign(context, true, id);
    const input = bindCampaign(await readCampaignBody(context.request));
    recheck(context, "campaigns:send");
    checkCampaign(context, true, id);
    try {
      return ok(projectCampaign(store.updateStatus(id, input.status ?? "")));
    } catch (error) {
      return translate(context, error);
    }
  };
  const archive: Handler = async (context) => {
    const id = BigInt(getID(context));
    checkCampaign(context, true, id);
    const raw = await readCampaignBody(context.request);
    const input = bindCampaign(raw);
    if (
      raw.archive_template_id !== undefined &&
      raw.archive_template_id !== null &&
      input.archive_template_id! < 0n
    )
      throw new HttpError(400);
    recheck(context, "campaigns:manage_all", "campaigns:manage");
    checkCampaign(context, true, id);
    const archiveSlug = input.archive_slug ? slug(input.archive_slug) : "";
    const templateId = input.archive_template_id ?? 0n;
    const meta = input.archive_meta ?? null;
    if (meta && JSON.stringify(meta).length > 64 * 1024)
      throw new HttpError(
        400,
        t(context).Ts("globals.messages.invalidFields", "name", "archive_meta"),
      );
    try {
      store.updateArchive(id, input.archive ?? false, templateId, meta, archiveSlug);
    } catch (error) {
      return translate(context, error);
    }
    return ok({
      archive: input.archive ?? false,
      archive_template_id: idValue(templateId),
      archive_meta: meta,
      archive_slug: archiveSlug,
    });
  };
  const removeOne: Handler = (context) => {
    const id = BigInt(getID(context));
    checkCampaign(context, true, id);
    if (!store.remove(id)) throw notFound(context);
    return ok(true);
  };
  const removeMany: Handler = (context) => {
    const params = context.url.searchParams;
    const scope = can(context, "campaigns:manage_all")
      ? { all: true, ids: [] }
      : permitted(context, true);
    const ids: bigint[] = [];
    let query = "";
    let all = false;
    const raw = params.getAll("id");
    if (raw.length) {
      for (const value of raw) {
        let reason = "";
        if (!/^[+-]?\d+$/.test(value))
          reason = `strconv.Atoi: parsing ${JSON.stringify(value)}: invalid syntax`;
        else {
          const id = BigInt(value);
          if (id < -9223372036854775808n || id > 9223372036854775807n)
            reason = `strconv.Atoi: parsing ${JSON.stringify(value)}: value out of range`;
          else if (id < 1n) reason = `${id} is not a valid ID`;
          else ids.push(id);
        }
        if (reason)
          throw new HttpError(
            400,
            t(context).Ts("globals.messages.errorInvalidIDs", "error", reason),
          );
      }
    } else {
      query = (params.get("query") ?? "").trim();
      all = params.get("all") === "true";
    }
    if (!ids.length && !query && !all)
      throw new HttpError(
        400,
        t(context).Ts("globals.messages.errorInvalidIDs", "error", "id or query required"),
      );
    store.removeMany(
      ids,
      {
        query: query.replace(/\s+/g, " "),
        statuses: params.getAll("status"),
        tags: params.getAll("tag"),
        type: params.get("type") ?? "",
      },
      scope,
    );
    return ok(true);
  };
  let testing = 0;
  /** Aggregate bounds for one test-send request, checked before a message is retained. */
  const TEST_SEND_BYTES = 32 * 1024 * 1024;
  const TEST_SEND_WORK = 1_000_000;
  const test: Handler = async (context) => {
    const id = BigInt(getID(context));
    checkCampaign(context, true, id);
    const input: CampaignRequest = bindCampaign(await readCampaignBody(context.request));
    recheck(context, "campaigns:manage_all", "campaigns:manage");
    checkCampaign(context, true, id);
    const value = validateCampaign(
      mergeCampaign(emptyCampaign, input),
      input.lists ?? [],
      policy(context),
    );
    const emails = input.subscribers ?? [];
    if (!emails.length) throw new HttpError(400, t(context).T("campaigns.noSubsToTest"));
    const scope = permitted(context, false);
    const seen = new Set<bigint>();
    const recipients = [];
    for (const email of emails) {
      const sub = deps.subscribers.byEmail(email.trim().toLowerCase());
      // Blocklisted subscribers never receive mail (04-sending.md).
      if (!sub || seen.has(sub.id) || sub.status === "blocklisted") continue;
      if (
        !scope.all &&
        !deps.subscribers.memberships(sub.id).some((m) => scope.ids.includes(m.list_id))
      )
        continue;
      seen.add(sub.id);
      recipients.push(sub);
    }
    if (!recipients.length) throw new HttpError(400, t(context).T("campaigns.noKnownSubsToTest"));
    const stored = row(context, id);
    const templateId = atoi(context.url.searchParams.get("template_id"));
    if (testing >= 4) throw new HttpError(429, "Too many test sends in progress.");
    testing++;
    try {
      const settings = deps.settings();
      const root = settings.rootUrl.replace(/\/+$/, "");
      // LoadInlineImages comes first: what is compiled is the rewritten source.
      const { campaign, images, problem } = deps.embedImages<MessageCampaign>({
        ...value,
        name: value.name,
        uuid: stored.uuid,
        templateBody: templateBody(templateId > 0 ? BigInt(templateId) : stored.template_id),
      });
      const sendError = (error: unknown): never => {
        if (error instanceof RenderCapacityError)
          throw new HttpError(429, "Too many template renders in progress.");
        throw new HttpError(
          500,
          t(context).Ts(
            "campaigns.errorSendTest",
            "error",
            error instanceof CampaignSourceError ? `invalid ${error.field}` : "invalid template",
          ),
        );
      };
      let compiled;
      try {
        compiled = compileCampaign(deps.renderer, campaign);
      } catch (error) {
        return sendError(error);
      }
      if (problem)
        throw new HttpError(500, t(context).Ts("campaigns.errorSendTest", "error", problem));
      // As listmonk, the request names the media of a test send.
      const attachments = await deps.attachments(input.media ?? [], images).catch(() => {
        throw new HttpError(500, t(context).Ts("campaigns.errorSendTest", "error", "attachment"));
      });
      const attachmentBytes = attachments.reduce((sum, a) => sum + a.content.length, 0);
      const messages: Message[] = [];
      const links = new Map<string, string | null>();
      let totalBytes = 0;
      let totalWork = 0;
      for (const sub of recipients) {
        const budget = createMessageBudget();
        const unsubscribeUrl = `${root}/subscription/${stored.uuid}/${sub.uuid}`;
        const trackedUuid = settings.individualTracking ? sub.uuid : dummyUUID;
        let out;
        try {
          out = compiled.render(
            subscriberContext(sub),
            {
              rootUrl: root,
              unsubscribeUrl,
              ...(settings.disableTracking
                ? {}
                : {
                    tracking: {
                      view: `${root}/campaign/${stored.uuid}/${trackedUuid}/px.png`,
                      link(url: string) {
                        let uuid = links.get(url);
                        if (uuid === undefined) {
                          uuid = deps.tracking.link(url);
                          const link = uuid === null ? null : deps.tracking.get(uuid);
                          if (link) deps.store.registerLink(stored.id, link.id);
                          links.set(url, uuid);
                        }
                        return uuid ? `${root}/link/${uuid}/${stored.uuid}/${trackedUuid}` : url;
                      },
                    },
                  }),
            },
            budget,
          );
        } catch (error) {
          return sendError(error);
        }
        const size = (value: string) => Buffer.byteLength(value);
        totalWork += budget.work;
        totalBytes += size(out.body) + size(out.altBody ?? "") + size(out.subject) + size(out.from);
        totalBytes += attachmentBytes;
        for (const set of out.headers)
          for (const [name, header] of Object.entries(set)) totalBytes += size(name) + size(header);
        // Nothing is queued until every message is rendered, so a refusal sends nothing.
        if (totalBytes > TEST_SEND_BYTES || totalWork > TEST_SEND_WORK)
          throw new HttpError(
            400,
            "The test send is too large: send it to fewer recipients or reduce the rendered size.",
          );
        const headers: Record<string, string | string[]> = {
          "X-Listmonk-Campaign": stored.uuid,
          "X-Listmonk-Subscriber": sub.uuid,
        };
        if (settings.unsubscribeHeader) {
          headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
          headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
        }
        for (const set of out.headers)
          for (const [name, header] of Object.entries(set)) {
            const prior = headers[name];
            headers[name] = prior === undefined ? header : [...[prior].flat(), header];
          }
        messages.push({
          from: out.from,
          to: [sub.email],
          subject: out.subject,
          contentType: campaign.content_type === "plain" ? "plain" : "html",
          body: Buffer.from(out.body),
          ...(out.altBody !== null ? { altBody: Buffer.from(out.altBody) } : {}),
          headers,
          ...(attachments.length ? { attachments } : {}),
          messenger: value.messenger,
        });
      }
      auth.revalidate(context);
      // As listmonk, test messages are queued to the messenger; delivery is not awaited.
      for (const message of messages)
        void deps.emailer
          .push(message, { copies: false })
          .result.catch((error) => context.app.logger.error(error));
      return ok(true);
    } finally {
      testing--;
    }
  };

  const get = any("campaigns:get_all", "campaigns:get");
  const manage = any("campaigns:manage_all", "campaigns:manage");
  router.route("GET", "/api/campaigns", collection, auth.middleware(), get);
  router.route("GET", "/api/campaigns/:id", one, auth.middleware(), get, hasID);
  router.route("GET", "/api/campaigns/:id/preview", preview, auth.middleware(), get, hasID);
  router.route("POST", "/api/campaigns/:id/preview", preview, auth.middleware(), get, hasID);
  router.route(
    "POST",
    "/api/campaigns/:id/preview/archive",
    archivePreview,
    auth.middleware(),
    get,
    hasID,
  );
  router.route(
    "POST",
    "/api/campaigns/:id/text",
    preview,
    auth.middleware(),
    any("campaigns:get"),
    hasID,
  );
  router.route("POST", "/api/campaigns/:id/content", content, auth.middleware(), manage, hasID);
  router.route("POST", "/api/campaigns/:id/test", test, auth.middleware(), manage, hasID);
  router.route("POST", "/api/campaigns", create, auth.middleware(), manage);
  router.route("PUT", "/api/campaigns/:id", update, auth.middleware(), manage, hasID);
  router.route(
    "PUT",
    "/api/campaigns/:id/status",
    status,
    auth.middleware(),
    any("campaigns:send"),
    hasID,
  );
  router.route("PUT", "/api/campaigns/:id/archive", archive, auth.middleware(), manage, hasID);
  router.route(
    "DELETE",
    "/api/campaigns",
    removeMany,
    auth.middleware(),
    any("campaigns:manage", "campaigns:manage_all"),
  );
  router.route("DELETE", "/api/campaigns/:id", removeOne, auth.middleware(), manage, hasID);
}
