// Adapted from listmonk cmd/import.go and the import routes of cmd/handlers.go at 6fcd95f. The
// request is read to its end before anything is validated, as Go's form parsing does, but into a
// temporary file rather than memory. See 07-api-and-ui.md for what differs.
import { open } from "node:fs/promises";
import type { Roles } from "@/roles/roles";
import type { Handler, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import type { ImportOptions, Importer, UploadSlot } from "@/subscribers/import/importer";
import {
  MalformedForm,
  multipartBoundary,
  receiveForm,
  UploadTooLarge,
  type ReceivedForm,
} from "@/subscribers/import/multipart";
import type { Authentication } from "@/users/auth";

const MEBIBYTE = 1024 * 1024;
/** The largest file, a limit of this project: upstream has none. About 2 million rows. */
export const MAX_UPLOAD_BYTES = 100 * MEBIBYTE;
/** Room for the multipart boundaries, the parameters and the part headers around the file. */
const MAX_BODY_BYTES = MAX_UPLOAD_BYTES + 256 * 1024;
const PERMISSION = "subscribers:import";

interface Params {
  mode?: unknown;
  subscription_status?: unknown;
  delim?: unknown;
  lists?: unknown;
  overwrite?: unknown;
  overwrite_userinfo?: unknown;
  overwrite_subscription_status?: unknown;
}
/** Upstream's SessionOpt: wrong types are errors and absent or null fields are empty. */
function parseParams(raw: string) {
  const value = JSON.parse(raw) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("params must be an object");
  const params = value as Params;
  const text = (item: unknown) => {
    if (item === undefined || item === null) return "";
    if (typeof item !== "string") throw new Error("expected a string");
    return item;
  };
  const flag = (item: unknown) => {
    if (item === undefined || item === null) return false;
    if (typeof item !== "boolean") throw new Error("expected a boolean");
    return item;
  };
  const lists = params.lists ?? [];
  if (!Array.isArray(lists) || !lists.every((id) => Number.isSafeInteger(id)))
    throw new Error("expected a list of integers");
  return {
    mode: text(params.mode),
    status: text(params.subscription_status),
    delim: text(params.delim),
    listIds: [...new Set((lists as number[]).map(BigInt))],
    overwrite: flag(params.overwrite),
    overwriteUserInfo: flag(params.overwrite_userinfo),
    overwriteStatus: flag(params.overwrite_subscription_status),
  };
}

export function registerImportRoutes(
  router: Router,
  deps: { importer: Importer; roles: Roles; auth: Authentication },
) {
  const { importer, roles, auth } = deps;
  const already = (c: RequestContext) => new HttpError(400, c.app.i18n.T("import.alreadyRunning"));
  const receive = async (c: RequestContext, slot: UploadSlot): Promise<ReceivedForm> => {
    const boundary = multipartBoundary(c.request.headers.get("content-type"));
    if (!boundary || !c.request.body) return {};
    const file = await open(slot.path, "wx", 0o600);
    try {
      return await receiveForm(c.request.body, boundary, file, MAX_BODY_BYTES, slot.signal);
    } catch (error) {
      if (error instanceof UploadTooLarge) throw new HttpError(413, "The file is too large.");
      if (slot.signal.aborted) throw new HttpError(503, "The server is shutting down.");
      // A broken or abandoned request: Go's FormValue finds no parameters in it.
      if (error instanceof MalformedForm) return {};
      throw error;
    } finally {
      await file.close();
    }
  };
  const options = (c: RequestContext, form: ReceivedForm): ImportOptions => {
    const { i18n } = c.app;
    // A long upload outlives the check that admitted it.
    auth.revalidate(c, PERMISSION);
    let params: ReturnType<typeof parseParams>;
    try {
      params = parseParams(form.params ?? "");
    } catch (error) {
      throw new HttpError(
        400,
        i18n.Ts("globals.messages.invalidParams", "error", (error as Error).message),
      );
    }
    const { mode } = params;
    const identity = c.identity!;
    const scope = roles.listScope(identity.role, identity.user.list_role_id, "list:manage");
    const listIds = scope.all
      ? params.listIds
      : params.listIds.filter((id) => scope.ids.includes(id));
    // Blocklist mode doesn't require list subscriptions.
    if (!listIds.length && mode !== "blocklist")
      throw new HttpError(403, i18n.Ts("globals.messages.permissionDenied", "name", "lists"));
    if (mode !== "subscribe" && mode !== "blocklist")
      throw new HttpError(400, i18n.T("globals.messages.invalidMode"));
    const status = params.status || (mode === "subscribe" ? "unconfirmed" : "unsubscribed");
    if (!["unconfirmed", "confirmed", "unsubscribed"].includes(status))
      throw new HttpError(400, i18n.T("import.invalidSubStatus"));
    if (Buffer.byteLength(params.delim) !== 1)
      throw new HttpError(400, i18n.T("import.invalidDelim"));
    if (form.filename === undefined)
      throw new HttpError(400, i18n.Ts("globals.messages.invalidFile", "error", "no such file"));
    // Upstream takes anything else for a ZIP, which is after v1 (01-scope.md).
    if (!form.filename.toLowerCase().endsWith(".csv"))
      throw new HttpError(400, "Only a CSV file can be imported: ZIP files are not supported.");
    return {
      mode,
      status,
      // The old `overwrite` field means both.
      overwriteUserInfo: params.overwrite || params.overwriteUserInfo,
      overwriteStatus: params.overwrite || params.overwriteStatus,
      delimiter: params.delim.charCodeAt(0),
      listIds,
    };
  };
  const start: Handler = async (c) => {
    const current = importer.status().status;
    if (current === "importing") throw already(c);
    if (current === "stopping")
      throw new HttpError(
        500,
        c.app.i18n.Ts("import.errorStarting", "error", "an import is already running"),
      );
    if (Number(c.request.headers.get("content-length")) > MAX_BODY_BYTES)
      throw new HttpError(413, "The file is too large.");
    const slot = importer.reserve();
    if (!slot) throw already(c);
    try {
      importer.start(slot, options(c, await receive(c, slot)));
      return ok(importer.status());
    } finally {
      await slot.release();
    }
  };
  router.route(
    "GET",
    "/api/import/subscribers",
    () => ok(importer.status()),
    auth.middleware(PERMISSION),
  );
  router.route(
    "GET",
    "/api/import/subscribers/logs",
    () => ok(importer.logs()),
    auth.middleware(PERMISSION),
  );
  router.route("POST", "/api/import/subscribers", start, auth.middleware(PERMISSION));
  router.route(
    "DELETE",
    "/api/import/subscribers",
    () => {
      importer.stop();
      return ok(importer.status());
    },
    auth.middleware(PERMISSION),
  );
}
