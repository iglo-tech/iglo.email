// Campaign attachments, adapted from listmonk cmd/manager_store.go: GetAttachment and
// internal/manager/manager.go: attachMedia at 6fcd95f. Reads files, so a caller holds no
// database transaction. Upstream has no bound; every send holds these bytes in memory.
import type { Message } from "@/messaging/email";
import type { Filesystem } from "@/media/filesystem";
import type { MediaStore } from "@/media/store";

const MAX_FILES = 10;
const MAX_BYTES = 10 * 1024 * 1024;
const mediaType = /^[\w.+-]+\/[\w.+-]+(;[ \t]*[\w.+-]+=("[^"\r\n]*"|[\w.+-]+))*$/;

export type Attachment = NonNullable<Message["attachments"]>[number];

export function createAttachments(store: Pick<MediaStore, "get">, files: Filesystem) {
  /** Every item or an error: a campaign never goes out without one of its files. */
  return async function attachments(ids: readonly (bigint | number)[]): Promise<Attachment[]> {
    if (ids.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} attachments`);
    const out: Attachment[] = [];
    let total = 0;
    for (const id of ids) {
      const media = store.get(id);
      if (!media) throw new Error(`attachment ${id} not found`);
      if (media.provider !== "filesystem") throw new Error(`attachment ${id} is not stored here`);
      const file = await files.stat(media.filename);
      if (!file) throw new Error(`attachment ${id} has no file`);
      total += file.size;
      if (total > MAX_BYTES) throw new Error(`attachments over ${MAX_BYTES} bytes`);
      out.push({
        name: media.filename,
        content: await files.read(file.path),
        // MakeAttachmentHeader's default for a missing or unusable type.
        contentType: mediaType.test(media.content_type)
          ? media.content_type
          : "application/octet-stream",
      });
    }
    return out;
  };
}
export type Attachments = ReturnType<typeof createAttachments>;
