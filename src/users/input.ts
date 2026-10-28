// Bounded request bodies for the user routes adapted from listmonk cmd/users.go and cmd/auth.go.
import { HttpError } from "@/server/response";

export async function readBody(request: Request): Promise<string> {
  const limit = 64 * 1024;
  if (Number(request.headers.get("content-length")) > limit) throw new HttpError(413);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > limit) {
          await reader.cancel();
          throw new HttpError(413);
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}
