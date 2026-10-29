// Adapted from listmonk queries/subscribers.sql (query-subscribers, query-subscribers-count,
// query-subscribers-for-export, query-subscribers-template), models/queries.go ApplyOrphanFilter,
// internal/core/subscribers.go validateQueryTables and cmd/subscribers.go formatSQLExp at 6fcd95f.
import type { Database, Statement } from "bun:sqlite";

/** A SQL argument; integers are int64 identities. */
export type Arg = string | bigint;

/**
 * The subscriber filter shared by query, export, bulk actions and (later) sequence conditions.
 * `lists` null means no list restriction; upstream's permission sentinel -1 matches nothing.
 */
export interface SubscriberFilter {
  lists: bigint[] | null;
  /** Subscription status: "", unconfirmed, confirmed, unsubscribed or "none" (no lists). */
  subscriptionStatus: string;
  search: string;
  subscriberStatus: string;
  /** A validated SQLite `WHERE` fragment (see checkFragment), or "". */
  fragment: string;
}

export const subscriptionStatuses = ["unconfirmed", "confirmed", "unsubscribed"];
export const subscriberStatuses = ["enabled", "disabled", "blocklisted"];
// listmonk internal/core/core.go subQuerySortFields.
export const sortFields = ["email", "status", "name", "created_at", "updated_at"];

/** listmonk formatSQLExp: trim and drop one trailing semicolon. */
export function formatSQLExp(q: string): string {
  q = q.trim();
  return q.endsWith(";") ? q.slice(0, -1) : q;
}

/**
 * Reject fragments that could leave the wrapping parentheses or add another statement:
 * a statement separator, a comment, an unterminated literal or unbalanced parentheses.
 * Returns an error message, or undefined when the fragment is a self-contained expression.
 */
export function checkFragment(sql: string): string | undefined {
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const end = ch === "[" ? "]" : ch;
      let closed = false;
      for (i++; i < sql.length; i++) {
        if (sql[i] === end) {
          if (end !== "]" && sql[i + 1] === end) i++;
          else {
            closed = true;
            break;
          }
        }
      }
      if (!closed) return "unterminated quoted text";
    } else if (ch === ";") return "multiple statements are not allowed";
    else if (
      (ch === "-" && next === "-") ||
      (ch === "/" && next === "*") ||
      (ch === "*" && next === "/")
    )
      return "comments are not allowed";
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return "unbalanced parentheses";
    else if (ch === "\0") return "invalid character";
  }
  return depth ? "unbalanced parentheses" : undefined;
}

const ascii = (value: string) => /^[\p{ASCII}]*$/u.test(value);
// FTS5's unicode61 tokenizer splits on everything except letters, numbers and private-use code points.
const hasToken = (value: string) => /[\p{L}\p{N}\p{Co}]/u.test(value);

/**
 * The FROM/WHERE part of upstream's query-subscribers family in SQLite. The LEFT JOIN keeps
 * `subscriber_lists.*` addressable from fragments exactly when upstream joins it.
 *
 * Search matches listmonk's case-insensitive substring results for whole words, word prefixes
 * and e-mail addresses: an FTS5 phrase-prefix match narrows candidates and, for ASCII input,
 * a substring check keeps exactly the rows upstream's `~* ('***=' || search)` returns.
 */
export function filterSQL(filter: SubscriberFilter, extra?: { sql: string; args: Arg[] }) {
  const args: Arg[] = [];
  let status = filter.subscriptionStatus;
  const where: string[] = [];
  if (status === "none") {
    status = "";
    where.push("NOT EXISTS (SELECT 1 FROM subscriber_lists WHERE subscriber_id = subscribers.id)");
  }
  const lists = filter.lists ?? [];
  // As upstream, subscriber_lists is always joined but only matches when a list or
  // subscription status filter is given, so fragments may reference its columns.
  let join = ` LEFT JOIN subscriber_lists ON (${lists.length > 0 || status !== "" ? "1" : "0"} AND subscriber_lists.subscriber_id = subscribers.id`;
  if (status) {
    join += " AND subscriber_lists.status = ?";
    args.push(status);
  }
  join += ")";
  if (lists.length) {
    where.push(`subscriber_lists.list_id IN (SELECT value FROM json_each(?))`);
    args.push(`[${lists.join(",")}]`);
  }
  if (status) where.push("subscriber_lists.subscriber_id IS NOT NULL");
  const search = filter.search;
  if (search) {
    const lower = search.toLowerCase();
    const substring =
      "(instr(lower(subscribers.name), ?) > 0 OR instr(lower(subscribers.email), ?) > 0)";
    if (hasToken(search)) {
      where.push(
        "subscribers.id IN (SELECT rowid FROM subscribers_fts WHERE subscribers_fts MATCH ?)",
      );
      args.push(`"${search.replaceAll('"', '""')}" *`);
      if (ascii(search)) {
        where.push(substring);
        args.push(lower, lower);
      }
    } else {
      where.push(substring);
      args.push(lower, lower);
    }
  }
  if (filter.subscriberStatus) {
    where.push("subscribers.status = ?");
    args.push(filter.subscriberStatus);
  }
  if (extra) {
    where.push(extra.sql);
    args.push(...extra.args);
  }
  // The newline keeps any trailing text of the fragment inside its own parentheses.
  if (filter.fragment) where.push(`(\n${filter.fragment}\n)`);
  return {
    from: `FROM subscribers${join}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`,
    args,
  };
}

export function countSQL(filter: SubscriberFilter) {
  const { from, args } = filterSQL(filter);
  return { sql: `SELECT COUNT(DISTINCT subscribers.id) ${from}`, args };
}

export function pageSQL(
  filter: SubscriberFilter,
  orderBy: string,
  order: string,
  offset: number,
  limit: number,
) {
  const column = sortFields.includes(orderBy) ? `subscribers.${orderBy}` : "subscribers.id";
  const direction = order === "asc" ? "ASC" : "DESC";
  const { from, args } = filterSQL(filter);
  return {
    sql: `SELECT DISTINCT subscribers.id ${from} ORDER BY ${column} ${direction}, subscribers.id ${direction} LIMIT ? OFFSET ?`,
    args: [...args, BigInt(limit < 1 ? -1 : limit), BigInt(offset)],
  };
}

/** Matching IDs in ascending order, optionally among `only`, after a cursor and in batches. */
export function idsSQL(
  filter: SubscriberFilter,
  options: { only?: bigint[]; after?: bigint; limit?: number } = {},
) {
  const conditions: string[] = [],
    extra: Arg[] = [];
  if (options.only?.length) {
    conditions.push("subscribers.id IN (SELECT value FROM json_each(?))");
    extra.push(`[${options.only.join(",")}]`);
  }
  if (options.after !== undefined) {
    conditions.push("subscribers.id > ?");
    extra.push(options.after);
  }
  const { from, args } = filterSQL(
    filter,
    conditions.length ? { sql: conditions.join(" AND "), args: extra } : undefined,
  );
  return {
    sql: `SELECT DISTINCT subscribers.id ${from} ORDER BY subscribers.id${options.limit ? " LIMIT ?" : ""}`,
    args: options.limit ? [...args, BigInt(options.limit)] : args,
  };
}

// listmonk internal/core/subscribers.go allowedSubQueryTables, plus the FTS5 index of
// subscriber name and e-mail used by search.
const allowedTables = new Set([
  "subscribers",
  "lists",
  "subscriber_lists",
  "campaigns",
  "campaign_lists",
  "campaign_views",
  "links",
  "link_clicks",
  "bounces",
  "subscribers_fts",
  "subscribers_fts_data",
  "subscribers_fts_idx",
  "subscribers_fts_docsize",
  "subscribers_fts_config",
]);

export class QueryError extends Error {}

/**
 * Prepare a statement that embeds a user fragment. Like upstream's validateQueryTables, the
 * compiled program may only open allowed tables; it must also be read-only, take exactly the
 * arguments supplied, and not touch temporary or attached schemas.
 */
export function prepareChecked(db: Database, sql: string, args: Arg[]): Statement {
  // sqlite3_stmt_readonly also reports ATTACH/DETACH as read-only; only SELECTs run here.
  if (!/^SELECT\s/.test(sql)) throw new QueryError("only SELECT statements are allowed");
  let stmt: Statement;
  let plan: { opcode: string; p2: number | bigint; p3: number | bigint; p5: number | bigint }[];
  try {
    stmt = db.prepare(sql);
  } catch (error) {
    throw new QueryError(error instanceof Error ? error.message : "invalid query");
  }
  const explain = db.prepare(`EXPLAIN ${sql}`);
  try {
    plan = explain.all(...args) as typeof plan;
  } catch (error) {
    stmt.finalize();
    throw new QueryError(error instanceof Error ? error.message : "invalid query");
  } finally {
    explain.finalize();
  }
  if (!stmt.readonly || stmt.paramsCount !== args.length) {
    stmt.finalize();
    throw new QueryError("query parameters and writes are not allowed");
  }
  const roots = new Map<number, string>([[1, "sqlite_schema"]]);
  const schema = db.prepare("SELECT tbl_name, rootpage FROM sqlite_schema WHERE rootpage > 0");
  for (const row of schema.all() as { tbl_name: string; rootpage: number | bigint }[])
    roots.set(Number(row.rootpage), row.tbl_name);
  schema.finalize();
  for (const op of plan) {
    if (!["OpenRead", "OpenWrite", "ReopenIdx"].includes(op.opcode)) continue;
    const name = roots.get(Number(op.p2));
    if (
      op.opcode === "OpenWrite" ||
      Number(op.p3) !== 0 ||
      Number(op.p5) & 0x10 /* OPFLAG_P2ISREG */ ||
      !name
    ) {
      stmt.finalize();
      throw new QueryError("table is not allowed");
    }
    if (!allowedTables.has(name)) {
      stmt.finalize();
      throw new QueryError(`table '${name}' is not allowed`);
    }
  }
  return stmt;
}
