// Campaign attachments, adapted from listmonk cmd/manager_store.go: GetAttachment and
// internal/manager/manager.go: attachMedia at 6fcd95f. Reads files, so a caller holds no
// database transaction. Upstream has no bound and keeps a copy per campaign. Here one cache per
// instance holds the bytes, by media ID, and nothing else keeps them between batches.
import type { Message } from "@/messaging/email";
import type { Filesystem } from "@/media/filesystem";
import type { InlineImage } from "@/media/embed";
import type { MediaStore } from "@/media/store";

export const MAX_FILES = 10;
const MAX_BYTES = 10 * 1024 * 1024;
const CACHE_BYTES = 64 * 1024 * 1024;
const MAX_LOADS = 4;
const mediaType = /^[\w.+-]+\/[\w.+-]+(;[ \t]*[\w.+-]+=("[^"\r\n]*"|[\w.+-]+))*$/;

export type Attachment = NonNullable<Message["attachments"]>[number];

export function createAttachments(
  store: Pick<MediaStore, "get">,
  files: Filesystem,
  cacheBytes = CACHE_BYTES,
) {
  /** Least recently used first. An entry holds for one version of the file. */
  const cache = new Map<string, { content: Buffer; size: number; modified: number }>();
  const reading = new Map<string, Promise<Buffer>>();
  const waiting: (() => void)[] = [];
  let loading = 0;
  let cached = 0;
  const forget = (key: string) => {
    cached -= cache.get(key)?.content.length ?? 0;
    cache.delete(key);
  };
  async function bytes(
    id: bigint | number,
    file: { path: string; size: number; modified: number },
  ) {
    const key = String(id);
    const hit = cache.get(key);
    if (hit?.size === file.size && hit.modified === file.modified) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.content;
    }
    // Concurrent requests for a template's image share one read and not a copy each.
    const version = `${key}:${file.size}:${file.modified}`;
    const pending = reading.get(version);
    if (pending) return pending;
    const read = files
      .read(file.path)
      .then((content) => {
        forget(key);
        if (content.length > cacheBytes) return content;
        cache.set(key, { content, size: file.size, modified: file.modified });
        cached += content.length;
        for (const oldest of cache.keys()) {
          if (cached <= cacheBytes) break;
          forget(oldest);
        }
        return content;
      })
      .finally(() => reading.delete(version));
    reading.set(version, read);
    return read;
  }

  /** Every item or an error: a campaign never goes out without one of its files. */
  async function load(
    ids: readonly (bigint | number)[],
    inline: readonly InlineImage[],
  ): Promise<Attachment[]> {
    const out: Attachment[] = [];
    let total = 0;
    for (const { id, cid } of [...ids.map((id) => ({ id, cid: undefined })), ...inline]) {
      const media = store.get(id);
      if (!media) throw new Error(`attachment ${id} not found`);
      if (media.provider !== "filesystem") throw new Error(`attachment ${id} is not stored here`);
      const file = await files.stat(media.filename);
      if (!file) throw new Error(`attachment ${id} has no file`);
      total += file.size;
      if (total > MAX_BYTES) throw new Error(`attachments over ${MAX_BYTES} bytes`);
      out.push({
        name: media.filename,
        content: await bytes(id, file),
        // MakeAttachmentHeader's default for a missing or unusable type.
        contentType: mediaType.test(media.content_type)
          ? media.content_type
          : "application/octet-stream",
        ...(cid === undefined ? {} : { cid, disposition: "inline" as const }),
      });
    }
    return out;
  }

  /** At most MAX_LOADS load at a time, so requests in a burst wait holding no bytes. */
  return async function attachments(
    ids: readonly (bigint | number)[],
    inline: readonly InlineImage[] = [],
  ): Promise<Attachment[]> {
    if (ids.length + inline.length > MAX_FILES)
      throw new Error(`more than ${MAX_FILES} attachments`);
    if (!ids.length && !inline.length) return [];
    if (loading < MAX_LOADS) loading++;
    else await new Promise<void>((turn) => waiting.push(turn));
    try {
      return await load(ids, inline);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else loading--;
    }
  };
}
export type Attachments = ReturnType<typeof createAttachments>;
