// Static response behavior follows listmonk cmd/init.go: staticServer.
import { assets } from "@/server/asset-manifest";
import { errorResponse, HttpError } from "@/server/response";
import { posix } from "node:path";

export function assetResponse(path: string, method: string): Response | undefined {
  const prefix = path.startsWith("/public/static/")
    ? "/public/static/"
    : path.startsWith("/admin/static/")
      ? "/admin/static/"
      : undefined;
  if (!prefix) return undefined;
  // D21: permit metadata-only probes and advertise every supported method.
  const allow = "OPTIONS, GET, HEAD";
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { Allow: allow } });
  if (method !== "GET" && method !== "HEAD") {
    const response = errorResponse(new HttpError(405, "Method Not Allowed"), method);
    response.headers.set("Allow", allow);
    return response;
  }
  let canonical = "";
  try {
    // Go's file server receives a decoded path and cleans redundant separators.
    // Decode once, then stay inside this asset namespace and the embedded map.
    canonical = posix.normalize(decodeURIComponent(path));
  } catch {
    // Invalid UTF-8 cannot name an embedded resource; malformed escape syntax is
    // rejected earlier by the router's transport boundary.
  }
  const asset =
    canonical.startsWith(prefix) && Object.hasOwn(assets, canonical)
      ? assets[canonical]
      : undefined;
  if (!asset)
    return new Response(method === "HEAD" ? null : "404 page not found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Length": "19" },
    });
  const file = Bun.file(asset.path);
  return new Response(method === "HEAD" ? null : file, {
    headers: {
      "Content-Type": asset.type,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": String(file.size),
    },
  });
}
