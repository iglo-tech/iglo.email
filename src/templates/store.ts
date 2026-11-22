// Adapted from listmonk internal/core/templates.go and queries/templates.sql at 6fcd95f.
import type { Database } from "bun:sqlite";
import type { Clock } from "@/clock";
import { must } from "@/invariant";
import { prepareNamedQueries } from "@/db/queries";
import { writeTransaction } from "@/db/transaction";
import type { CampaignTemplateReferences } from "@/campaigns/template-references";
import { TemplateSourceError } from "@/templates/renderer";
import type { TemplateRenderer } from "@/templates/renderer";
import { initialTemplates } from "@/templates/builtins";
import { previewBody, previewData } from "@/templates/sample";
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
  /** `detail` names an unknown filter, for the save message (D134); it is empty otherwise. */
  constructor(
    readonly reason:
      | "name"
      | "type"
      | "subject"
      | "subject-syntax"
      | "slot"
      | "body"
      | "loop"
      | "render"
      | "missing"
      | "default"
      | "delete"
      | "capacity",
    readonly detail = "",
  ) {
    super(reason);
  }
}
export function createTemplateStore(
  db: Database,
  clock: Clock,
  renderer: TemplateRenderer,
  references: CampaignTemplateReferences,
) {
  const q = prepareNamedQueries(db, [{ name: "templates/store", sql }]);
  const byId = (id: bigint) => q.get("template-by-id").get(id) as TemplateRow | null;
  const defaultRow = () => q.get("template-default").get() as TemplateRow | null;
  const all = () => q.get("templates-all").all() as Array<TemplateRow>;
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
    ) {
      throw new TemplateError("name");
    }
    if (value.type !== "campaign" && value.type !== "tx") {
      throw new TemplateError("type");
    }
    if (
      typeof value.subject !== "string" ||
      Buffer.byteLength(value.subject) > 2048 ||
      value.subject.includes("\0") ||
      (value.type === "tx" && !value.subject.trim())
    ) {
      throw new TemplateError("subject");
    }
    if (
      typeof value.body !== "string" ||
      Buffer.byteLength(value.body) > 65_536 ||
      value.body.includes("\0") ||
      (value.body_source !== null &&
        (typeof value.body_source !== "string" ||
          Buffer.byteLength(value.body_source) > 65_536 ||
          value.body_source.includes("\0")))
    ) {
      throw new TemplateError("body");
    }
    try {
      renderer.validate(value.body, value.subject, value.type === "campaign");
    } catch (error) {
      if (error instanceof TemplateSourceError && error.field === "subject") {
        throw new TemplateError("subject-syntax", error.detail);
      }
      if (error instanceof TemplateSourceError && error.field === "slot") {
        throw new TemplateError("slot");
      }
      if (error instanceof TemplateSourceError && error.field === "loop") {
        throw new TemplateError("loop");
      }
      if (error instanceof TemplateSourceError) {
        throw new TemplateError("body", error.detail);
      }
      throw new TemplateError("body");
    }
    // The save-time render (D134): as a send renders it, against the preview's sample.
    const check =
      value.type === "campaign"
        ? renderer.check({ body: previewBody, layout: value.body, mode: "html" }, previewData)
        : renderer.check(
            { body: value.body, subject: value.subject, mode: "html", transactional: true },
            previewData,
          );
    if (check.outcome === "busy") {
      throw new TemplateError("capacity");
    }
    if (check.outcome === "refused") {
      throw new TemplateError("render", check.reason);
    }
  }
  function initialize() {
    writeTransaction(db, () => {
      if (count() !== 0n) {
        return;
      }
      for (const value of initialTemplates) {
        insert({ ...value, body_source: null }, value.isDefault);
      }
    });
  }
  function create(input: WritableTemplate) {
    const result = writeTransaction(db, () => {
      const value = { ...input, subject: input.type === "campaign" ? "" : input.subject };
      validate(value);
      const id = insert(value);
      return must(byId(id), "template");
    });
    return result;
  }
  function update(id: bigint, input: TemplatePatch) {
    const result = writeTransaction(db, () => {
      const old = byId(id);
      if (!old) {
        throw new TemplateError("missing");
      }
      if (input.type !== undefined && input.type !== old.type) {
        throw new TemplateError("type");
      }
      const value = {
        name: input.name ?? old.name,
        type: old.type,
        subject: input.subject ?? old.subject,
        body: input.body ?? old.body,
        body_source: input.body_source === undefined ? old.body_source : input.body_source,
      };
      if (value.type === "campaign") {
        value.subject = "";
      }
      validate(value);
      q.get("template-update").run(
        value.name,
        value.subject,
        value.body,
        value.body_source,
        clock.now().toISOString(),
        id,
      );
      return must(byId(id), "template");
    });
    return result;
  }
  function setDefault(id: bigint) {
    return writeTransaction(db, () => {
      const row = byId(id);
      if (!row || row.type !== "campaign") {
        throw new TemplateError("default");
      }
      q.get("template-clear-default").run();
      q.get("template-set-default").run(id);
    });
  }
  function remove(id: bigint) {
    return writeTransaction(db, () => {
      const row = byId(id);
      if (!row || row.is_default || count() <= 1n) {
        throw new TemplateError("delete");
      }
      const def = defaultRow();
      if (!def) {
        throw new TemplateError("default");
      }
      references.reassign(id, def.id);
      q.get("template-delete").run(id);
    });
  }
  function list(query = "", orderBy = "", order = "") {
    const search = query
      .replaceAll(
        /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,
        "",
      )
      .replaceAll(/[\t\n\f\r ]+/g, " ")
      .toLowerCase();
    const field =
      (["name", "type", "created_at", "updated_at"] as const).find((f) => f === orderBy) ??
      "created_at";
    // B80: order takes any case (a deliberate difference from upstream's ASC).
    const direction = !order || order.toLowerCase() === "asc" ? 1 : -1;
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
