// Inline images, adapted from listmonk internal/manager/manager.go at 6fcd95f: LoadInlineImages,
// applyInlineImages, ApplyArchiveImages, MakeContentID, filenameFromSrc and extractSrc. Rewrites
// sources and reads no file, so it can run inside a claim transaction; the bytes come with the
// attachments. Tags are found by a linear scan: upstream's pattern is quadratic on a body of
// unclosed `<img`.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ErrorLogger } from "@/app";
import { MAX_FILES } from "@/media/attachments";
import type { MediaStore } from "@/media/store";

const ATTRIBUTE = "data-embed";
/** Distinct names looked up in one message: a body can name more images than it can embed. */
const MAX_LOOKUPS = 100;
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
  /** Over a limit, so the message cannot go out as written: it behaves as a missing attachment. */
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

/** Replaces the source of each `data-embed` image for which `resolve` returns a new one. */
function rewriteImages(body: string, resolve: (filename: string) => string | null): string {
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
    const replacement = filename ? resolve(filename) : null;
    if (replacement === null) continue;
    out +=
      body.slice(copied, found.index) +
      tag.replace(sources, (_, space: string) => `${space}src="${replacement}"`);
    copied = end + 1;
  }
  return out + body.slice(copied);
}

export function createEmbeds(store: Pick<MediaStore, "byFilename">, logger: ErrorLogger) {
  /**
   * LoadInlineImages. A template a visual campaign does not use embeds nothing. As upstream, an
   * image with no media row, an external URL or a Liquid source, keeps its source: only the row
   * says the image is ours to embed.
   */
  return function embedImages<
    C extends { content_type: string; body: string; templateBody: string },
  >(c: C): EmbeddedImages<C> {
    if (c.content_type === "plain") return { campaign: c, images: [], problem: null };
    const cids = new Map<string, string | null>();
    const images: InlineImage[] = [];
    let problem: string | null = null;

    function sourceOf(filename: string): string | null {
      const known = cids.get(filename);
      if (known !== undefined) return known === null ? null : `cid:${known}`;
      if (cids.size >= MAX_LOOKUPS) {
        problem ??= `more than ${MAX_LOOKUPS} embedded image names`;
        return null;
      }
      const media = store.byFilename(filename);
      if (!media) {
        cids.set(filename, null);
        logger.error(new Error(`inline image ${filename} not embedded: no such media`));
        return null;
      }
      if (images.length >= MAX_FILES) {
        problem ??= `more than ${MAX_FILES} embedded images`;
        return null;
      }
      const cid = contentId(media.filename);
      cids.set(filename, cid);
      images.push({ id: media.id, cid });
      return `cid:${cid}`;
    }

    const body = rewriteImages(c.body, sourceOf);
    const templateBody =
      c.content_type === "visual" ? c.templateBody : rewriteImages(c.templateBody, sourceOf);
    return { campaign: { ...c, body, templateBody }, images, problem };
  };
}
export type EmbedImages = ReturnType<typeof createEmbeds>;

/**
 * ApplyArchiveImages: `cid:` cannot resolve on a web page, so a stored name becomes its public
 * URL. These pages are anonymous, so a source with no row stays as written without a log line.
 */
export function createPublicImages(
  store: Pick<MediaStore, "byFilename">,
  url: (filename: string) => string,
) {
  return function publicImages<
    C extends { content_type: string; body: string; templateBody: string },
  >(c: C): C {
    if (c.content_type === "plain") return c;
    const urls = new Map<string, string | null>();
    function urlOf(filename: string): string | null {
      const known = urls.get(filename);
      if (known !== undefined) return known;
      if (urls.size >= MAX_LOOKUPS) return null;
      const media = store.byFilename(filename);
      // The result is template source inside an attribute, and a name is neither.
      const found = media
        ? url(media.filename).replace(/[{}&]/g, (char) => encodeURIComponent(char))
        : null;
      urls.set(filename, found);
      return found;
    }
    const body = rewriteImages(c.body, urlOf);
    const templateBody =
      c.content_type === "visual" ? c.templateBody : rewriteImages(c.templateBody, urlOf);
    return { ...c, body, templateBody };
  };
}
export type PublicImages = ReturnType<typeof createPublicImages>;
