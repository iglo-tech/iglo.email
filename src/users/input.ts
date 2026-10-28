// Bounded user/list request bodies adapted from listmonk cmd/users.go, cmd/auth.go and cmd/lists.go.
import { HttpError } from "@/server/response";

export async function readBodyBytes(request: Request): Promise<Buffer> {
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
  return Buffer.concat(chunks);
}

export async function readBody(request: Request): Promise<string> {
  return (await readBodyBytes(request)).toString("utf8");
}
