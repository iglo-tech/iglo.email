// Static response behavior follows listmonk cmd/init.go: staticServer.
import { assets } from "@/server/asset-manifest";
import { errorResponse, HttpError } from "@/server/response";

export function assetResponse(path: string, method: string): Response | undefined {
  if (!path.startsWith("/public/static/") && !path.startsWith("/admin/static/")) return undefined;
  if (method !== "GET") return errorResponse(new HttpError(405, "Method Not Allowed"), method);
  const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
  if (!asset)
    return new Response("404 page not found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  return new Response(Bun.file(asset.path), {
    headers: { "Content-Type": asset.type, "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
