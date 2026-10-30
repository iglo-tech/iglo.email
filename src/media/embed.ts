// Inline images, adapted from listmonk internal/manager/manager.go at 6fcd95f: LoadInlineImages,
// applyInlineImages, MakeContentID, filenameFromSrc and extractSrc. Rewrites sources and reads no
// file, so it can run inside a claim transaction; the bytes come with the attachments. Tags are
// found by a linear scan: upstream's pattern is quadratic on a body of unclosed `<img`.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { MAX_FILES } from "@/media/attachments";
import type { MediaStore } from "@/media/store";

const ATTRIBUTE = "data-embed";
const attribute = /\bdata-embed\b/i;
const source = /(\s)src\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const sources = new RegExp(source.source, "gi");

export interface InlineImage {
  id: bigint;
  cid: string;
}
export interface EmbeddedImages<C> {
  campaign: C;
  images: InlineImage[];
  /** Why the campaign cannot go out as written: it behaves as a missing attachment does. */
  problem: string | null;
}

const contentId = (filename: string) =>
  `${createHash("sha1").update(filename).digest("hex").slice(0, 16)}@email`;

/** The last component of the path of an `<img src>`, whatever the URL around it. */
function filenameFromSrc(src: string): string {
  let path = src;
  try {
    path = decodeURIComponent(new URL(src, "http://relative.invalid").pathname);
  } catch {
    /* Not a URL: the value itself. */
  }
  return posix.basename(path);
}

export function createEmbeds(store: Pick<MediaStore, "byFilename">) {
  /** LoadInlineImages. A template a visual campaign does not use embeds nothing. */
  return function embedImages<
    C extends { content_type: string; body: string; templateBody: string },
  >(c: C): EmbeddedImages<C> {
    if (c.content_type === "plain") return { campaign: c, images: [], problem: null };
    const cids = new Map<string, string | null>();
    const images: InlineImage[] = [];
    let problem: string | null = null;

    function cidOf(filename: string): string | null {
      const known = cids.get(filename);
      if (known !== undefined) return known;
      if (cids.size >= MAX_FILES) {
        problem ??= `more than ${MAX_FILES} embedded images`;
        return null;
      }
      const media = store.byFilename(filename);
      const cid = media ? contentId(media.filename) : null;
      cids.set(filename, cid);
      if (media && cid) images.push({ id: media.id, cid });
      else problem ??= `embedded image ${filename} not found`;
      return cid;
    }
    function rewrite(body: string): string {
      if (!body.includes(ATTRIBUTE)) return body;
      let out = "";
      let copied = 0;
      const opening = /<img\b/gi;
      for (let found = opening.exec(body); found; found = opening.exec(body)) {
        const end = body.indexOf(">", found.index);
        if (end < 0) break;
        opening.lastIndex = end + 1;
        const tag = body.slice(found.index, end + 1);
        if (!attribute.test(tag)) continue;
        const match = source.exec(tag);
        const src = match?.[2] || match?.[3] || "";
        if (!src || src.toLowerCase().startsWith("cid:")) continue;
        const filename = filenameFromSrc(src);
        const cid = filename ? cidOf(filename) : null;
        if (cid === null) continue;
        out += body.slice(copied, found.index) + tag.replace(sources, `$1src="cid:${cid}"`);
        copied = end + 1;
      }
      return out + body.slice(copied);
    }

    const body = rewrite(c.body);
    const templateBody = c.content_type === "visual" ? c.templateBody : rewrite(c.templateBody);
    return { campaign: { ...c, body, templateBody }, images, problem };
  };
}
export type EmbedImages = ReturnType<typeof createEmbeds>;
