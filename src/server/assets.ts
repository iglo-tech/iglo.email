// Static response behavior follows listmonk cmd/init.go: staticServer.
import { assets } from "@/server/asset-manifest";
import { errorResponse, HttpError } from "@/server/response";

export function assetResponse(path: string, method: string): Response | undefined {
  if (!path.startsWith("/public/static/") && !path.startsWith("/admin/static/")) return undefined;
  // D21: permit metadata-only probes and advertise every supported method.
  const allow = "OPTIONS, GET, HEAD";
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { Allow: allow } });
  if (method !== "GET" && method !== "HEAD") {
    const response = errorResponse(new HttpError(405, "Method Not Allowed"), method);
    response.headers.set("Allow", allow);
    return response;
  }
  const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
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
