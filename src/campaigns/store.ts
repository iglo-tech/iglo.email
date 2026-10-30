// Adapted from listmonk internal/core/campaigns.go, models/campaigns.go and
// queries/campaigns.sql at 6fcd95f.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import sql from "@/campaigns/store.sql" with { type: "text" };

export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "running"
  | "paused"
  | "cancelled"
  | "finished";
export type ContentType = "richtext" | "html" | "markdown" | "plain" | "visual";
export const contentTypes: readonly ContentType[] = [
  "richtext",
  "html",
  "markdown",
  "plain",
  "visual",
];
export interface CampaignRow {
  id: bigint;
  uuid: string;
  name: string;
  subject: string;
  from_email: string;
  body: string;
  body_source: string | null;
  altbody: string | null;
  content_type: ContentType;
  send_at: string | null;
  headers: string;
  attribs: string;
  status: CampaignStatus;
  tags: string | null;
  type: "regular" | "optin";
  messenger: string;
  template_id: bigint | null;
  to_send: bigint;
  sent: bigint;
  max_subscriber_id: bigint;
  last_subscriber_id: bigint;
  archive: bigint;
  archive_slug: string | null;
  archive_template_id: bigint | null;
  archive_meta: string;
  started_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  views: bigint;
  clicks: bigint;
  bounces: bigint;
  lists: string;
  media: string;
}
/** The writable campaign fields after request binding and validation. */
export interface WritableCampaign {
  type: "regular" | "optin";
  name: string;
  subject: string;
  from_email: string;
  body: string;
  body_source: string | null;
  altbody: string | null;
  content_type: ContentType;
  send_at: string | null;
  headers: Record<string, string>[];
  attribs: Record<string, unknown>;
  tags: string[];
  messenger: string;
  template_id: bigint | null;
  archive: boolean;
  archive_slug: string | null;
  archive_template_id: bigint | null;
  archive_meta: Record<string, unknown>;
}
export interface Scope {
  all: boolean;
  ids: bigint[];
}
export interface CampaignFilter {
  query: string;
  statuses: string[];
  tags: string[];
  type: string;
}
export class CampaignError extends Error {
  constructor(readonly reason: "missing" | "slug" | "template" | `status:${string}`) {
    super(reason);
  }
}
const sortFields = ["name", "status", "created_at", "updated_at", "started_at", "send_at"];
const ids = (values: bigint[]) => JSON.stringify(values.map(String)).replaceAll('"', "");

/** listmonk normalizeTags: trim and replace whitespace runs with a dash; drop empties. */
export function normalizeTags(tags: string[]): string[] {
  return tags.map((t) => t.trim().replace(/\s+/g, "-")).filter(Boolean);
}

/** Owner lookups for the tables a campaign references (templates, lists). */
export interface CampaignReferences {
  templateExists(id: bigint): boolean;
  defaultTemplate(): bigint | null;
  listName(id: bigint): string | null;
}

export function createCampaignStore(db: Database, clock: Clock, refs: CampaignReferences) {
  const q = prepareNamedQueries(db, [{ name: "campaigns/store", sql }]);
  const get = (id: bigint) => q.get("campaign-by-id").get(id) as CampaignRow | null;
  const now = () => clock.now().toISOString();
  const slugOwner = (slug: string | null) =>
    slug === null
      ? null
      : ((q.get("archive-slug-owner").get(slug) as { id: bigint } | null)?.id ?? null);
  const templateExists = (id: bigint | null) => id === null || refs.templateExists(id);
  const setLists = (id: bigint, listIds: bigint[]) => {
    q.get("delete-other-campaign-lists").run(id, ids(listIds));
    for (const list of listIds) {
      const name = refs.listName(list);
      if (name !== null) q.get("insert-campaign-list").run(id, list, name);
    }
  };
  const setMedia = (id: bigint, mediaIds: bigint[]) => {
    q.get("delete-other-campaign-media").run(id, ids(mediaIds));
    for (const media of mediaIds) q.get("insert-campaign-media").run(id, media);
  };
  const values = (c: WritableCampaign) => ({
    headers: JSON.stringify(c.headers),
    attribs: JSON.stringify(c.attribs),
    tags: c.tags.length ? JSON.stringify(c.tags) : null,
    archiveMeta: JSON.stringify(c.archive_meta),
  });
  return {
    get,
    byUuid: (uuid: string) =>
      q.get("campaign-by-uuid").get(uuid) as {
        id: bigint;
        uuid: string;
        type: string;
        status: string;
      } | null,
    listIds: (id: bigint) =>
      (q.get("campaign-list-ids").all(id) as { list_id: bigint }[]).map((r) => r.list_id),
    hasLists(id: bigint, listIds: bigint[]): boolean {
      return (q.get("campaign-has-lists").get(id, ids(listIds)) as { has: bigint }).has === 1n;
    },
    query(
      filter: CampaignFilter,
      scope: Scope,
      orderBy: string,
      order: string,
      offset: number,
      limit: number,
    ): { rows: CampaignRow[]; total: number } {
      const field = sortFields.includes(orderBy) ? orderBy : "created_at";
      const direction = order === "asc" ? "ASC" : order === "desc" ? "DESC" : "DESC";
      const found = q
        .get("query-campaign-ids")
        .all(
          JSON.stringify(filter.statuses),
          JSON.stringify(filter.tags),
          filter.query,
          filter.type,
          scope.all ? 1 : 0,
          ids(scope.ids),
          field,
          direction,
          limit < 1 ? -1 : limit,
          offset,
        ) as { id: bigint; total: bigint }[];
      return {
        rows: found.map((r) => get(r.id)).filter((r): r is CampaignRow => r !== null),
        total: Number(found[0]?.total ?? 0),
      };
    },
    /** create-campaign: the given or default template; the campaign is always a draft. */
    create(input: WritableCampaign, listIds: bigint[], mediaIds: bigint[]): CampaignRow {
      return writeTransaction(db, () => {
        if (slugOwner(input.archive_slug) !== null) throw new CampaignError("slug");
        let template: bigint | null = null;
        if (input.template_id !== null) {
          if (templateExists(input.template_id)) template = input.template_id;
        } else if (input.content_type !== "visual") {
          template = refs.defaultTemplate();
        }
        const archiveTemplate =
          input.archive_template_id !== null && templateExists(input.archive_template_id)
            ? input.archive_template_id
            : null;
        const v = values(input);
        const at = now();
        const { id } = q
          .get("insert-campaign")
          .get(
            crypto.randomUUID(),
            input.type,
            input.name,
            input.subject,
            input.from_email,
            input.body,
            input.altbody,
            input.content_type,
            input.send_at,
            v.headers,
            v.attribs,
            v.tags,
            input.messenger,
            template,
            input.archive ? 1 : 0,
            input.archive_slug,
            archiveTemplate,
            v.archiveMeta,
            input.body_source,
            at,
            at,
          ) as { id: bigint };
        setLists(id, listIds);
        setMedia(id, mediaIds);
        return get(id)!;
      });
    },
    /** update-campaign within one write: the caller's merge is rechecked against the row. */
    update(
      id: bigint,
      merge: (row: CampaignRow) => {
        value: WritableCampaign;
        listIds: bigint[];
        mediaIds: bigint[];
      },
    ): CampaignRow {
      return writeTransaction(db, () => {
        const row = get(id);
        if (!row) throw new CampaignError("missing");
        const { value, listIds, mediaIds } = merge(row);
        const owner = slugOwner(value.archive_slug);
        if (owner !== null && owner !== id) throw new CampaignError("slug");
        if (!templateExists(value.template_id) || !templateExists(value.archive_template_id))
          throw new CampaignError("template");
        const v = values(value);
        q.get("update-campaign").run(
          id,
          value.name,
          value.subject,
          value.from_email,
          value.body,
          value.altbody === "" ? null : value.altbody,
          value.content_type,
          value.send_at,
          v.headers,
          v.attribs,
          v.tags,
          value.messenger,
          value.template_id,
          value.archive ? 1 : 0,
          value.archive_slug,
          value.archive_template_id,
          v.archiveMeta,
          value.body_source,
          now(),
        );
        setLists(id, listIds);
        setMedia(id, mediaIds);
        return get(id)!;
      });
    },
    /** UpdateCampaignStatus: upstream's transitions, checked and written in one transaction. */
    updateStatus(id: bigint, status: string): CampaignRow {
      return writeTransaction(db, () => {
        const row = get(id);
        if (!row) throw new CampaignError("missing");
        const from = row.status;
        let refused = "";
        switch (status) {
          case "draft":
            if (from !== "scheduled") refused = "onlyScheduledAsDraft";
            break;
          case "scheduled":
            if (from !== "draft" && from !== "paused") refused = "onlyDraftAsScheduled";
            if (row.send_at === null) refused = "needsSendAt";
            break;
          case "running":
            if (from !== "paused" && from !== "draft") refused = "onlyPausedDraft";
            break;
          case "paused":
            if (from !== "running") refused = "onlyActivePause";
            break;
          case "cancelled":
            if (from !== "running" && from !== "paused") refused = "onlyActiveCancel";
            break;
          case "finished":
            break;
          default:
            refused = "invalid";
        }
        if (refused) throw new CampaignError(`status:${refused}`);
        q.get("update-campaign-status").run(id, status, now());
        // listmonk returns the campaign read before the write with the requested status.
        return { ...row, status: status as CampaignStatus };
      });
    },
    updateArchive(
      id: bigint,
      archive: boolean,
      templateId: bigint,
      meta: Record<string, unknown> | null,
      slug: string,
    ): void {
      writeTransaction(db, () => {
        if (!get(id)) return;
        const owner = slugOwner(slug || null);
        if (owner !== null && owner !== id) throw new CampaignError("slug");
        if (templateId > 0n && !templateExists(templateId)) throw new CampaignError("template");
        q.get("update-campaign-archive").run(
          id,
          archive ? 1 : 0,
          slug || null,
          templateId,
          meta === null ? null : JSON.stringify(meta),
          now(),
        );
      });
    },
    remove(id: bigint): boolean {
      return q.get("delete-campaign").run(id).changes > 0;
    },
    removeMany(selection: bigint[], filter: CampaignFilter, scope: Scope): void {
      writeTransaction(db, () => {
        const found = q
          .get("delete-campaign-ids")
          .all(
            ids(selection),
            filter.query,
            JSON.stringify(filter.statuses),
            JSON.stringify(filter.tags),
            filter.type,
            scope.all ? 1 : 0,
            ids(scope.ids),
          ) as { id: bigint }[];
        for (const row of found) q.get("delete-campaign").run(row.id);
      });
    },
    registerView(id: bigint, subscriberId: bigint | null) {
      q.get("register-campaign-view").run(id, subscriberId, now());
    },
    registerClick(id: bigint, linkId: bigint, subscriberId: bigint | null) {
      q.get("register-campaign-click").run(id, linkId, subscriberId, now());
    },
    close: () => q.close(),
  };
}
export type CampaignStore = ReturnType<typeof createCampaignStore>;
