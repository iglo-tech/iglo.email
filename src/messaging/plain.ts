// B120 (D118): the generated text/plain alternative of an HTML message, one converter for every
// path. No upstream counterpart: listmonk sends HTML only, a difference recorded in 07-api-and-ui.md.
//
// Bun's HTMLRewriter streams the document once, so its handlers collect the visible text in document
// order. Its own output is discarded. Every later pass is a linear scan of the collected text.
import type { MessageBudget } from "@/templates/renderer";

/** Elements whose content is never shown: the document head, styles, scripts and the title. */
const SKIPPED = new Set(["head", "script", "style", "title"]);
/** Elements without an end tag: nothing to close, so no end handler is registered for them. */
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
/** Block elements: a line break before and after. A list item gets a bullet instead. */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);
/** Characters that have no visible form. They are removed, wherever they are. */
const INVISIBLE = /[͏​-‍­﻿]/g;

// Named references a message normally uses: the HTML 4 Latin-1 set (code points 160 to 255, in order)
// and common punctuation. A name outside this table is left as written, not guessed.
const LATIN1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(
    " ",
  );
const PUNCTUATION: Array<[string, number]> = [
  ["quot", 34],
  ["amp", 38],
  ["apos", 39],
  ["lt", 60],
  ["gt", 62],
  ["OElig", 338],
  ["oelig", 339],
  ["Scaron", 352],
  ["scaron", 353],
  ["Yuml", 376],
  ["circ", 710],
  ["tilde", 732],
  ["ensp", 8194],
  ["emsp", 8195],
  ["thinsp", 8201],
  ["zwnj", 8204],
  ["zwj", 8205],
  ["lrm", 8206],
  ["rlm", 8207],
  ["ndash", 8211],
  ["mdash", 8212],
  ["lsquo", 8216],
  ["rsquo", 8217],
  ["sbquo", 8218],
  ["ldquo", 8220],
  ["rdquo", 8221],
  ["bdquo", 8222],
  ["dagger", 8224],
  ["Dagger", 8225],
  ["bull", 8226],
  ["hellip", 8230],
  ["permil", 8240],
  ["prime", 8242],
  ["Prime", 8243],
  ["lsaquo", 8249],
  ["rsaquo", 8250],
  ["euro", 8364],
  ["trade", 8482],
  ["larr", 8592],
  ["uarr", 8593],
  ["rarr", 8594],
  ["darr", 8595],
  ["harr", 8596],
];
const NAMED = new Map<string, string>([
  ...LATIN1.map((name, i) => [name, String.fromCodePoint(160 + i)] as [string, string]),
  ...PUNCTUATION.map(([name, code]) => [name, String.fromCodePoint(code)] as [string, string]),
]);

/** A reference is one pass over the text, so a decoded `&amp;nbsp;` stays the literal `&nbsp;`. */
const REFERENCE = /&(?:#[xX]([0-9a-fA-F]{1,8});?|#([0-9]{1,8});?|([A-Za-z][A-Za-z0-9]{1,31});?)/g;
function decodeReferences(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(REFERENCE, (match, hex?: string, dec?: string, name?: string) => {
    if (hex !== undefined || dec !== undefined) {
      const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10);
      // Zero, a surrogate and anything past U+10FFFF are not characters: the replacement character.
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? "�"
        : String.fromCodePoint(code);
    }
    return NAMED.get(name!) ?? match;
  });
}

/**
 * A hidden element is one whose inline style hides it: `display:none`, `visibility:hidden` (or
 * `collapse`), `mso-hide:all`, or `max-height:0` with `overflow:hidden`. The last declaration of a
 * property wins, and `!important` is ignored. Classes from a `<style>` block are not evaluated.
 */
function hiddenByStyle(style: string | null): boolean {
  if (style === null || !style.includes(":")) return false;
  const declared = new Map<string, string>();
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    let value = declaration
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    const bang = value.lastIndexOf("!");
    if (bang >= 0 && value.slice(bang + 1).trim() === "important")
      value = value.slice(0, bang).trim();
    declared.set(declaration.slice(0, colon).trim().toLowerCase(), value);
  }
  if (declared.get("display") === "none") return true;
  const visibility = declared.get("visibility");
  if (visibility === "hidden" || visibility === "collapse") return true;
  if (declared.get("mso-hide") === "all") return true;
  const maxHeight = declared.get("max-height");
  return (
    maxHeight !== undefined &&
    Number.parseFloat(maxHeight) === 0 &&
    declared.get("overflow") === "hidden"
  );
}

/** One text node: references decoded, invisible characters removed, whitespace collapsed to a space. */
const clean = (text: string) => text.replace(INVISIBLE, "").replace(/\s+/g, " ");

/**
 * Converts an HTML message to its text/plain alternative and charges the output to `budget`. The
 * output is never longer than the input: markup is replaced by shorter text, and hidden or invisible
 * content is dropped. A link is written as its text and its URL, with the URL once when the text is
 * the URL. The rendered href is used as it stands, tracked or not.
 */
export async function plainText(html: string, budget: MessageBudget): Promise<string> {
  const parts: string[] = [];
  // Depth of hidden or skipped content. Its text is read, but never kept.
  let skip = 0;
  // The current text node, joined across chunks so no character reference is split.
  let raw = "";
  const link = (at: number, href: string) => {
    const text = parts.slice(at).join("").replace(/\s+/g, " ").trim();
    parts.push(text === href ? "" : ` (${href})`);
  };
  const rewriter = new HTMLRewriter().on("*", {
    element(el) {
      if (skip > 0) return;
      const name = el.tagName.toLowerCase();
      const isVoid = VOID.has(name);
      if (SKIPPED.has(name) || hiddenByStyle(el.getAttribute("style"))) {
        if (!isVoid) {
          skip++;
          el.onEndTag(() => {
            skip--;
          });
        }
        return;
      }
      if (name === "a") {
        const href = (el.getAttribute("href") ?? "").trim();
        if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return;
        const at = parts.length;
        el.onEndTag(() => link(at, href));
        return;
      }
      if (name === "li") parts.push("\n- ");
      else if (name === "td" || name === "th") parts.push(" ");
      else if (BLOCK.has(name) || name === "br" || name === "hr") parts.push("\n");
      if (!isVoid && BLOCK.has(name))
        el.onEndTag(() => {
          parts.push("\n");
        });
    },
    text(chunk) {
      raw += chunk.text;
      if (!chunk.lastInTextNode) return;
      if (skip === 0) parts.push(clean(decodeReferences(raw)));
      raw = "";
    },
  });
  await rewriter.transform(new Response(html)).text();
  const text = parts
    .join("")
    .replace(/ {2,}/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  budget.charge(Buffer.byteLength(text));
  return text;
}
