// Adapted from listmonk internal/core/templates.go and queries/templates.sql at 6fcd95f.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import type { ErrorLogger } from "@/app";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import type { CampaignTemplateReferences } from "@/campaigns/template-references";
import { TemplateSourceError, type TemplateRenderer } from "@/templates/renderer";
import { initialTemplates } from "@/templates/builtins";
import sql from "@/templates/store.sql" with { type: "text" };

export type TemplateType = "campaign" | "campaign_visual" | "tx";
export interface TemplateRow {
  id: bigint;
  name: string;
  type: TemplateType;
  subject: string;
  body: string;
  body_source: string | null;
  is_default: bigint;
  created_at: string | null;
  updated_at: string | null;
}
export interface WritableTemplate {
  name: string;
  type: TemplateType;
  subject: string;
  body: string;
  body_source: string | null;
}
export type TemplatePatch = Partial<WritableTemplate>;
export class TemplateError extends Error {
  constructor(
    readonly reason:
      | "name"
      | "type"
      | "subject"
      | "subject-syntax"
      | "slot"
      | "body"
      | "missing"
      | "default"
      | "delete",
  ) {
    super(reason);
  }
}
export function createTemplateStore(
  db: Database,
  clock: Clock,
  renderer: TemplateRenderer,
  references: CampaignTemplateReferences,
  logger: ErrorLogger,
) {
  const q = prepareNamedQueries(db, [{ name: "templates/store", sql }]);
  const byId = (id: bigint) => q.get("template-by-id").get(id) as TemplateRow | null;
  const defaultRow = () => q.get("template-default").get() as TemplateRow | null;
  const all = () => q.get("templates-all").all() as TemplateRow[];
  const count = () => (q.get("template-count").get() as { count: bigint }).count;
  const insert = (value: WritableTemplate, isDefault = false) => {
    const now = clock.now().toISOString();
    return (
      q
        .get("template-insert")
        .get(
          value.name,
          value.type,
          value.subject,
          value.body,
          value.body_source,
          isDefault ? 1 : 0,
          now,
          now,
        ) as { id: bigint }
    ).id;
  };
  function validate(value: WritableTemplate) {
    if (
      typeof value.name !== "string" ||
      Buffer.byteLength(value.name) < 1 ||
      Buffer.byteLength(value.name) > 2000 ||
      value.name.includes("\0")
    )
      throw new TemplateError("name");
    if (value.type !== "campaign" && value.type !== "tx") throw new TemplateError("type");
    if (
      typeof value.subject !== "string" ||
      Buffer.byteLength(value.subject) > 2048 ||
      value.subject.includes("\0") ||
      (value.type === "tx" && !value.subject.trim())
    )
      throw new TemplateError("subject");
    if (
      typeof value.body !== "string" ||
      Buffer.byteLength(value.body) > 65536 ||
      value.body.includes("\0") ||
      (value.body_source !== null &&
        (typeof value.body_source !== "string" ||
          Buffer.byteLength(value.body_source) > 65536 ||
          value.body_source.includes("\0")))
    )
      throw new TemplateError("body");
    try {
      renderer.validate(value.body, value.subject, value.type === "campaign");
    } catch (error) {
      if (error instanceof TemplateSourceError && error.field === "subject")
        throw new TemplateError("subject-syntax");
      if (error instanceof TemplateSourceError && error.field === "slot")
        throw new TemplateError("slot");
      throw new TemplateError("body");
    }
  }
  function initialize() {
    writeTransaction(db, () => {
      if (count() !== 0n) return;
      for (const value of initialTemplates)
        insert({ ...value, body_source: null }, value.isDefault);
    });
  }
  function warn(row: TemplateRow) {
    try {
      if (row.type === "tx" && renderer.refersToUnsubscribe(row.body, row.subject))
        logger.error("Transactional template references unsubscribe_url; it will be empty.");
    } catch {
      // A diagnostic must never turn a committed write into an apparent failure.
    }
  }
  function create(input: WritableTemplate) {
    const result = writeTransaction(db, () => {
      const value = { ...input, subject: input.type === "campaign" ? "" : input.subject };
      validate(value);
      const id = insert(value);
      return byId(id)!;
    });
    warn(result);
    return result;
  }
  function update(id: bigint, input: TemplatePatch) {
    const result = writeTransaction(db, () => {
      const old = byId(id);
      if (!old) throw new TemplateError("missing");
      if (input.type !== undefined && input.type !== old.type) throw new TemplateError("type");
      const value = {
        name: input.name ?? old.name,
        type: old.type,
        subject: input.subject ?? old.subject,
        body: input.body ?? old.body,
        body_source: input.body_source === undefined ? old.body_source : input.body_source,
      };
      if (value.type === "campaign") value.subject = "";
      validate(value);
      q.get("template-update").run(
        value.name,
        value.subject,
        value.body,
        value.body_source,
        clock.now().toISOString(),
        id,
      );
      return byId(id)!;
    });
    warn(result);
    return result;
  }
  function setDefault(id: bigint) {
    return writeTransaction(db, () => {
      const row = byId(id);
      if (!row || row.type !== "campaign") throw new TemplateError("default");
      q.get("template-clear-default").run();
      q.get("template-set-default").run(id);
    });
  }
  function remove(id: bigint) {
    return writeTransaction(db, () => {
      const row = byId(id);
      if (!row || row.is_default || count() <= 1n) throw new TemplateError("delete");
      const def = defaultRow();
      if (!def) throw new TemplateError("default");
      references.reassign(id, def.id);
      q.get("template-delete").run(id);
    });
  }
  function list(query = "", orderBy = "", order = "") {
    const search = query
      .replace(
        /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,
        "",
      )
      .replace(/[\t\n\f\r ]+/g, " ")
      .toLowerCase();
    const field =
      (["name", "type", "created_at", "updated_at"] as const).find((f) => f === orderBy) ??
      "created_at";
    const direction = !order || order === "asc" ? 1 : -1;
    return all()
      .filter((row) => row.name.toLowerCase().includes(search))
      .sort((a, b) => {
        const x = a[field] ?? "",
          y = b[field] ?? "";
        return direction * (x < y ? -1 : x > y ? 1 : 0);
      });
  }
  return {
    initialize,
    get: byId,
    getDefault: defaultRow,
    list,
    create,
    update,
    setDefault,
    remove,
    close: () => q.close(),
  };
}
export type TemplateStore = ReturnType<typeof createTemplateStore>;
