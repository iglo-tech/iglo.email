// Adapted from listmonk cmd/media.go, the media routes of cmd/handlers.go and the Static route
// of cmd/init.go at 6fcd95f. Bytes reach the disk first and the row follows, without a
// transaction open across file I/O: a crash between them leaves an unlisted file, which is never
// served, and never a row without its file. Deletion removes the row first for the same reason.
// Thumbnails are not generated (01-scope.md): `thumb` names the image itself. See 07-api-and-ui.md.
import { imageSize } from "@/media/image";
import {
  extensionOf,
  makeFilename,
  uploadRoot,
  UploadRootError,
  type Filesystem,
} from "@/media/filesystem";
import type { MediaRow, MediaStore } from "@/media/store";
import type { Handler, Middleware, RequestContext } from "@/server/context";
import { HttpError, ok } from "@/server/response";
import type { Router } from "@/server/router";
import { getID, hasID } from "@/server/validation";
import type { Authentication } from "@/users/auth";

const MEBIBYTE = 1024 * 1024;
/** The largest file, a limit of this project: upstream has none. */
export const MAX_FILE_BYTES = 25 * MEBIBYTE;
/** Room for the multipart boundaries and part headers around the file. */
const MAX_BODY_BYTES = MAX_FILE_BYTES + 64 * 1024;
/** A body is held in memory until it is stored, so this bounds what uploads can hold. */
const MAX_UPLOADS = 8;
/** Long enough to matter, short enough that a deleted file does not linger. */
const CACHE_CONTROL = "public, max-age=3600";

const vectorExtensions = ["svg"];
const imageExtensions = ["gif", "png", "jpg", "jpeg"];
/** Types a browser shows without running anything from them, or under the CSP below. */
const inlineTypes =
  /^(image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)|(audio|video)\/.+|text\/plain)$/;
/** A file is never a document of this origin, even if it is opened as one. */
const SANDBOX = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";

export interface MediaSettings {
  provider: string;
  extensions: string[];
  rootUrl: string;
}

const UPLOAD_PATH = "upload.filesystem.upload_path";

/**
 * Runs in the settings transaction. A row has one location, the upload directory, so the
 * directory cannot change under stored media: an existing URL would name someone else's file.
 */
export function uploadPathCheck(dataDir: string, store: Pick<MediaStore, "any">) {
  return (next: Record<string, any>, current: Record<string, any>): void => {
    if (next[UPLOAD_PATH] === current[UPLOAD_PATH]) return;
    let root: string;
    try {
      root = uploadRoot(dataDir, next[UPLOAD_PATH]);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    const same = (() => {
      try {
        return uploadRoot(dataDir, current[UPLOAD_PATH]) === root;
      } catch {
        return false;
      }
    })();
    if (!same && store.any())
      throw new HttpError(
        400,
        "The upload path cannot change while media exists: its files stay where they are. " +
          "Delete the media first.",
      );
  };
}

// Go strconv.Atoi, ignoring its error.
const atoi = (value: string | null) => {
  if (!value || !/^[+-]?\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
};

async function readUpload(request: Request): Promise<Uint8Array> {
  const tooLarge = () => new HttpError(413, "The file is too large.");
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw tooLarge();
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return Buffer.concat(chunks);
}

export function registerMediaRoutes(
  router: Router,
  deps: {
    store: MediaStore;
    files: Filesystem;
    auth: Authentication;
    settings: () => MediaSettings;
  },
) {
  const { store, files, auth, settings } = deps;
  let uploading = 0;

  const project = (row: MediaRow) => {
    const { rootUrl } = settings();
    return {
      id: Number(row.id),
      uuid: row.uuid,
      filename: row.filename,
      content_type: row.content_type,
      created_at: row.created_at,
      thumb_url: row.thumb ? files.url(rootUrl, row.thumb) : null,
      provider: row.provider,
      meta: JSON.parse(row.meta) as object,
      url: files.url(rootUrl, row.filename),
    };
  };
  const notFound = () => new HttpError(404, "not found");
  const filesystemOnly = (c: RequestContext) => {
    if (settings().provider !== "filesystem")
      throw new HttpError(
        400,
        c.app.i18n.Ts("globals.messages.errorUploadingFile", "error", "S3 is not supported"),
      );
  };
  /** The file of a form, as Go's FormFile: the first part of the name that has a filename. */
  const formFile = async (c: RequestContext, body: Uint8Array) => {
    const invalid = (error: string) =>
      new HttpError(400, c.app.i18n.Ts("globals.messages.invalidFile", "error", error));
    const type = c.request.headers.get("content-type") ?? "";
    if (type.split(";", 1)[0]?.trim().toLowerCase() !== "multipart/form-data")
      throw invalid("request Content-Type isn't multipart/form-data");
    let form: FormData;
    try {
      form = await new Request("http://form.invalid", {
        method: "POST",
        headers: { "content-type": type },
        body: new Blob([body as Uint8Array<ArrayBuffer>]),
      }).formData();
    } catch {
      throw invalid("malformed multipart form");
    }
    for (const value of form.getAll("file")) if (typeof value !== "string") return value;
    throw invalid("http: no such file");
  };

  const upload: Handler = async (c) => {
    filesystemOnly(c);
    if (uploading >= MAX_UPLOADS)
      throw new HttpError(429, "Too many uploads in progress.", { "Retry-After": "1" });
    uploading++;
    try {
      // Fixed before the body arrives, so a row always names the directory that admitted it.
      let root: string;
      try {
        root = files.root();
      } catch (error) {
        if (error instanceof UploadRootError) throw new HttpError(503, error.message);
        throw error;
      }
      const changed = () => new HttpError(409, "The upload path changed during the upload.");
      const body = await readUpload(c.request);
      const file = await formFile(c, body);
      // A long upload outlives the check that admitted it.
      auth.revalidate(c, "media:manage");
      filesystemOnly(c);
      const name = makeFilename(file.name);
      const ext = extensionOf(name);
      const { extensions } = settings();
      if (!extensions.includes("*") && !extensions.includes(ext))
        throw new HttpError(
          400,
          c.app.i18n.Ts("globals.messages.unsupportedFileType", "type", ext),
        );
      if (file.size > MAX_FILE_BYTES) throw new HttpError(413, "The file is too large.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const size = imageExtensions.includes(ext) ? imageSize(bytes) : null;
      if (!files.current(root)) throw changed();
      const stored = await files.put(root, name, bytes, store.filenameTaken);
      try {
        // Nothing runs between this check and the insert.
        if (!files.current(root)) throw changed();
        return ok(
          project(
            store.insert({
              filename: stored,
              thumb: imageExtensions.includes(ext) || vectorExtensions.includes(ext) ? stored : "",
              contentType: file.type,
              provider: "filesystem",
              meta: size ?? {},
            }),
          ),
        );
      } catch (error) {
        await files.remove(stored, root);
        throw error;
      }
    } finally {
      uploading--;
    }
  };
  const collection: Handler = (c) => {
    const params = c.url.searchParams;
    let page = atoi(params.get("page"));
    if (page < 1) page = 1;
    const rawPer = params.get("per_page");
    let perPage = rawPer === "all" ? 0 : atoi(rawPer);
    if (rawPer !== "all" && perPage < 1) perPage = 20;
    const { results, total } = store.query(
      settings().provider,
      params.get("query") ?? "",
      perPage ? Math.min((page - 1) * perPage, Number.MAX_SAFE_INTEGER) : 0,
      perPage,
    );
    return ok({
      results: results.map(project),
      search: "",
      query: "",
      total,
      per_page: perPage,
      page,
    });
  };
  const one: Handler = (c) => {
    const row = store.get(getID(c));
    if (!row) throw notFound();
    return ok(project(row));
  };
  const remove: Handler = async (c) => {
    const row = store.delete(getID(c));
    if (!row) throw notFound();
    // Once the row is gone a failure here leaves only an unlisted file: the delete still holds.
    if (row.provider === "filesystem")
      try {
        await files.remove(row.filename);
        if (row.thumb && row.thumb !== row.filename && !store.filenameTaken(row.thumb))
          await files.remove(row.thumb);
      } catch (error) {
        c.app.logger.error(error);
      }
    return ok(true);
  };

  /**
   * The Static route of cmd/init.go. `upload_uri` is a live setting, so this is a middleware and
   * not a fixed route. Only a stored name is served, looked up as a whole and never joined from
   * the URL, so nothing else in the directory is reachable. The stored content type came from the
   * uploader, so the file's own extension decides, and anything that is not known to be harmless
   * is a download.
   */
  const serve: Middleware = async (c, next) => {
    const { method } = c.request;
    if (method !== "GET" && method !== "HEAD") return next();
    const name = files.nameOf(c.url.pathname);
    if (name === undefined || settings().provider !== "filesystem") return next();
    if (!store.byFilename(name)) return next();
    const file = await files.stat(name).catch(() => null);
    if (!file) return next();
    const ext = extensionOf(name);
    // Same origin as the admin: with `nosniff`, this type is what stops `<script src>` on an upload
    // from passing the admin's `script-src 'self'` (D71).
    const known = Bun.file(ext ? `file.${ext}` : "file").type.split(";", 1)[0]!;
    const type = /script/.test(known) ? "application/octet-stream" : known;
    const tag = `"${file.size.toString(16)}-${Math.floor(file.modified).toString(16)}"`;
    const modified = new Date(file.modified).toUTCString();
    const headers: Record<string, string> = {
      "Content-Type": /^text\//.test(type) ? `${type}; charset=utf-8` : type,
      "Cache-Control": CACHE_CONTROL,
      ETag: tag,
      "Last-Modified": modified,
      "X-Content-Type-Options": "nosniff",
    };
    // A CSP sandbox can stop a browser's built-in viewer, so a PDF has none and `nosniff` keeps
    // it a PDF. That viewers are isolated from the origin is their design, not verified here.
    if (type !== "application/pdf") headers["Content-Security-Policy"] = SANDBOX;
    if (type !== "application/pdf" && !inlineTypes.test(type))
      headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
    const since = c.request.headers.get("if-modified-since");
    const match = c.request.headers.get("if-none-match");
    if (match === tag || (!match && since && Date.parse(since) >= Date.parse(modified)))
      return new Response(null, { status: 304, headers });
    headers["Content-Length"] = String(file.size);
    return new Response(method === "HEAD" ? null : Bun.file(file.path), { headers });
  };

  router.use(serve);
  router.route("GET", "/api/media", collection, auth.middleware("media:get"));
  router.route("GET", "/api/media/:id", one, auth.middleware("media:get"), hasID);
  router.route("POST", "/api/media", upload, auth.middleware("media:manage"));
  router.route("DELETE", "/api/media/:id", remove, auth.middleware("media:manage"), hasID);
}
