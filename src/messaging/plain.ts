// B120 (D118): the generated text/plain alternative of an HTML message, one converter for every
// path. No upstream counterpart: listmonk sends HTML only, a difference recorded in 07-api-and-ui.md.
//
// Bun's HTMLRewriter streams the document once. Its element handlers keep a stack of open elements,
// so a hidden element ends where a browser ends it, including an end tag the parser implies (a `td`
// closed by the next cell). Its document handler collects the text in order. Every later pass is a
// linear scan of the collected text, and a link is one entry on the stack, so nested links are linear.
import type { MessageBudget } from "@/templates/renderer";

/** Elements whose content is never shown: the document head, styles, scripts and the title. */
const SKIPPED = new Set(["head", "script", "style", "title"]);
/** Elements that may appear in a head: any other element starts the body and ends an open head. */
const HEAD_CONTENT = new Set([
  "base",
  "basefont",
  "bgsound",
  "link",
  "meta",
  "noframes",
  "noscript",
  "script",
  "style",
  "template",
  "title",
]);
/**
 * Open elements tracked at once. Each has an end-tag handler, and Bun's rewriter charges every end tag
 * for the handlers still pending, so nesting beyond this depth would cost time with its square.
 */
const HANDLER_CAP = 256;
/**
 * End-tag handlers Bun holds at once: registered and not yet fired. An implied end leaves its handler
 * pending until an ancestor's end tag, so omitted end tags grow this count without growing the stack.
 * Past it the conversion stops, and the message goes without a text part (D118).
 */
const HELD_CAP = 1024;
/** Block elements: a line break before and after. A list item gets a bullet instead. */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "center",
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
  "option",
  "select",
  "tr",
  "ul",
]);
/** Start tags that end an open `p` (HTML's "close a p element" list, the block-level ones). */
const CLOSES_P = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "center",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "fieldset",
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
  "hgroup",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "ul",
]);
/** Scope boundaries for a `p`: a `p` above the nearest of these is in button scope. */
const P_SCOPE = [
  "applet",
  "button",
  "caption",
  "html",
  "marquee",
  "object",
  "table",
  "td",
  "template",
  "th",
];
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
  // The markup names for a tab and a newline, which a browser strips from a URL, and the colon.
  ["colon", 58],
  ["Tab", 9],
  ["NewLine", 10],
];
const NAMED = new Map<string, string>([
  ...LATIN1.map((name, i) => [name, String.fromCodePoint(160 + i)] as [string, string]),
  ...PUNCTUATION.map(([name, code]) => [name, String.fromCodePoint(code)] as [string, string]),
]);

/** A reference is one pass over the text, so a decoded `&amp;nbsp;` stays the literal `&nbsp;`. */
/**
 * The names a browser decodes without a `;`: the Latin-1 set and the four markup names. Any other
 * name needs its `;`.
 */
const LEGACY = new Map<string, string>([
  ...LATIN1.map((name, i) => [name, String.fromCodePoint(160 + i)] as [string, string]),
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
]);
/** A numeric reference in 0x80 to 0x9F is the Windows-1252 character a browser shows for it. */
const WINDOWS_1252 = new Map<number, string>([
  [0x80, "€"],
  [0x82, "‚"],
  [0x83, "ƒ"],
  [0x84, "„"],
  [0x85, "…"],
  [0x86, "†"],
  [0x87, "‡"],
  [0x88, "ˆ"],
  [0x89, "‰"],
  [0x8a, "Š"],
  [0x8b, "‹"],
  [0x8c, "Œ"],
  [0x8e, "Ž"],
  [0x91, "‘"],
  [0x92, "’"],
  [0x93, "“"],
  [0x94, "”"],
  [0x95, "•"],
  [0x96, "–"],
  [0x97, "—"],
  [0x98, "˜"],
  [0x99, "™"],
  [0x9a, "š"],
  [0x9b, "›"],
  [0x9c, "œ"],
  [0x9e, "ž"],
  [0x9f, "Ÿ"],
]);
const REFERENCE = /&(?:#[xX]([0-9a-fA-F]{1,8});?|#([0-9]{1,8});?|([A-Za-z][A-Za-z0-9]{1,31})(;?))/g;
/**
 * Decodes character references once. In an attribute (`attribute`), a legacy name without `;` that
 * a `=`, a letter or a digit follows stays literal, as a browser leaves it; in text the longest legacy
 * prefix decodes.
 */
function decodeReferences(text: string, attribute = false): string {
  if (!text.includes("&")) return text;
  return text.replace(
    REFERENCE,
    (
      match,
      hex?: string,
      dec?: string,
      name?: string,
      semicolon?: string,
      offset?: number,
      whole?: string,
    ) => {
      if (hex !== undefined || dec !== undefined) {
        const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10);
        const windows = WINDOWS_1252.get(code);
        if (windows !== undefined) return windows;
        // Zero, a surrogate and anything past U+10FFFF are not characters: the replacement character.
        return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
          ? "�"
          : String.fromCodePoint(code);
      }
      if (semicolon === ";") return NAMED.get(name!) ?? match;
      // A reference without `;` decodes only when it is a legacy name.
      if (attribute) {
        const after = whole?.[(offset ?? 0) + match.length] ?? "";
        if (after === "=" || /[A-Za-z0-9]/.test(after)) return match;
        return LEGACY.get(name!) ?? match;
      }
      for (let end = name!.length; end > 0; end--) {
        const value = LEGACY.get(name!.slice(0, end));
        if (value !== undefined) return value + name!.slice(end);
      }
      return match;
    },
  );
}

/**
 * A hidden element is one whose inline style hides it: `display:none`, `visibility:hidden` (or
 * `collapse`), `mso-hide:all`, or `max-height:0` with `overflow:hidden`. The last declaration of a
 * property wins, and `!important` is ignored. Classes from a `<style>` block are not evaluated. The
 * style is passed decoded, since the rewriter returns attribute values as written.
 */
function hiddenByStyle(style: string): boolean {
  if (!style.includes(":")) return false;
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
 * A URL in the text part is written between angle brackets, so the characters that could end it
 * early, and whitespace and control characters, are percent-encoded (RFC 3986 Appendix C).
 */
const escapeUrl = (href: string) =>
  // oxlint-disable-next-line no-control-regex
  href.replace(/[\s<>"\u0000-\u001f\u007f]/gu, (character) => encodeURIComponent(character));

interface Link {
  /** The href, decoded once: the URL a reader follows. */
  href: string;
  /** Where the link's text starts in the output parts. */
  at: number;
  /** Written already: a new link, or the link's end tag, finishes it once. */
  done: boolean;
}

interface Entry {
  name: string;
  /** Position on the stack: the stack only grows and shrinks at its top, so this stays true. */
  index: number;
  /** A hidden element of its own: its content and its text are never kept. */
  own: boolean;
  popped: boolean;
  link: Link | undefined;
}

/**
 * Converts an HTML message to its text/plain alternative and charges the output to `budget`. The
 * output is never longer than the input, and a conversion fault or an over-long result sends the
 * message without a text part, as before D118. A link is written as its text and its URL in angle
 * brackets, `text <URL>`, the URL alone when the text is the URL or empty. A link whose text is only a
 * symbol is decoration and writes nothing; consecutive links with the same href write the URL once.
 */
export async function plainText(html: string, budget: MessageBudget): Promise<string> {
  try {
    return await convert(html, budget);
  } catch {
    // A fault in the conversion never fails a send. The message goes without a text part.
    return "";
  }
}

async function convert(html: string, budget: MessageBudget): Promise<string> {
  const parts: string[] = [];
  const stack: Entry[] = [];
  const open = new Map<string, Entry[]>();
  // Depth of hidden elements on the stack. Their content, and the markup that marks it, is not kept.
  let hidden = 0;
  // The current text node, joined across chunks so no character reference is split.
  let raw = "";
  // The last link that wrote a URL, and where its output ends.
  let lastLink: { href: string; end: number } | null = null;
  // The link whose text is being written: a new link finishes it.
  let activeLink: Link | undefined;
  // End-tag handlers the rewriter holds: registered, and not yet fired (see HELD_CAP).
  let held = 0;

  const latest = (name: string) => open.get(name)?.at(-1);
  const indexOf = (name: string) => latest(name)?.index ?? -1;
  const newest = (...names: string[]) => {
    let best: Entry | undefined;
    for (const name of names) {
      const entry = latest(name);
      if (entry && (!best || entry.index > best.index)) best = entry;
    }
    return best;
  };
  const boundary = (...names: string[]) => Math.max(-1, ...names.map(indexOf));

  const finishLink = (link: Link) => {
    const text = parts.slice(link.at).join("").replace(/\s+/g, " ").trim();
    parts.length = link.at;
    // A symbol with no letter or digit (an arrow, an emoji) is empty text: a reader still needs its URL.
    const shown = text !== "" && !/[\p{L}\p{N}]/u.test(text) ? "" : text;
    const gap = parts.slice(lastLink?.end ?? parts.length).join("");
    // Consecutive links with the same href, with nothing but spaces between, write the URL once.
    if (
      lastLink !== null &&
      lastLink.href === link.href &&
      gap.trim() === "" &&
      !gap.includes("\n")
    ) {
      if (shown !== "") parts.push(` ${shown}`);
      lastLink = { href: link.href, end: parts.length };
      return;
    }
    const url = `<${escapeUrl(link.href)}>`;
    parts.push(shown === "" || shown === link.href ? ` ${url}` : ` ${shown} ${url}`);
    lastLink = { href: link.href, end: parts.length };
  };

  const finishOnce = (link: Link) => {
    if (link.done) return;
    link.done = true;
    finishLink(link);
  };
  // Pops the entry at the top of the stack, which is also the newest entry of its name.
  const finish = (entry: Entry) => {
    entry.popped = true;
    open.get(entry.name)!.pop();
    if (entry.own) hidden--;
    if (entry.own || hidden > 0) return;
    if (entry.link) finishOnce(entry.link);
    if (BLOCK.has(entry.name)) parts.push("\n");
  };
  // Closes an entry and everything above it, as an end tag or an implied end does.
  const close = (entry: Entry) => {
    while (!entry.popped) finish(stack.pop()!);
  };

  // The HTML rules by which a start tag implies the end of an open element, for the elements the
  // hidden-content rule and the link rule depend on.
  const impliedEnds = (name: string) => {
    // A head with no end tag ends at the body, or at the first element that is not head content.
    if (name === "body" || (name !== "html" && name !== "head" && !HEAD_CONTENT.has(name))) {
      const head = latest("head");
      if (head) close(head);
    }
    if (name === "td" || name === "th") {
      const cell = newest("td", "th");
      if (cell && cell.index > indexOf("table")) close(cell);
    } else if (name === "tr") {
      const row = latest("tr");
      if (row && row.index > indexOf("table")) close(row);
    } else if (name === "thead" || name === "tbody" || name === "tfoot") {
      const section = newest("thead", "tbody", "tfoot");
      if (section && section.index > indexOf("table")) close(section);
    } else if (name === "li") {
      const item = latest("li");
      if (item && item.index > boundary("ul", "ol")) close(item);
    } else if (name === "dt" || name === "dd") {
      const item = newest("dt", "dd");
      if (item && item.index > indexOf("dl")) close(item);
    } else if (name === "option") {
      const item = latest("option");
      if (item && item.index > boundary("select", "datalist", "optgroup")) close(item);
    }
    if (CLOSES_P.has(name)) {
      const paragraph = latest("p");
      if (paragraph && paragraph.index > boundary(...P_SCOPE)) close(paragraph);
    }
  };

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const name = el.tagName.toLowerCase();
        // Past the cap, markup is not tracked: no entry and no end handler, so deeper structure is plain
        // text, and the rewriter's cost per end tag stays bounded (D118).
        if (stack.length >= HANDLER_CAP && el.canHaveContent) return;
        // An implied end pops an entry that the rewriter still holds, so running the rules past the cap
        // would grow the held count (a deep nested list would then abort).
        impliedEnds(name);
        // A void or self-closing element has no content, so it hides nothing and has no end tag.
        const content = el.canHaveContent;
        const style = el.getAttribute("style");
        const own =
          content &&
          (SKIPPED.has(name) || (style !== null && hiddenByStyle(decodeReferences(style, true))));
        if (own) hidden++;
        const shown = hidden === 0;
        if (shown) {
          if (name === "li") parts.push("\n- ");
          else if (name === "td" || name === "th") parts.push(" ");
          else if (BLOCK.has(name) || name === "br" || name === "hr") parts.push("\n");
        }
        let link: Link | undefined;
        if (name === "a" && content && shown) {
          // A new link ends the open one, as a browser shows it. The rewriter keeps the element nested, so
          // the stack keeps the outer one until its own end tag, which the handler count depends on.
          if (activeLink) finishOnce(activeLink);
          activeLink = undefined;
          const href = decodeReferences(el.getAttribute("href") ?? "", true).trim();
          // A browser ignores the controls and spaces around a scheme and drops tab and newline inside
          // it, so the scheme is read after both. A script or data scheme writes no URL.
          // oxlint-disable-next-line no-control-regex
          const scheme = href.replace(/[\u0000-  ]/g, "");
          if (href && !href.startsWith("#") && !/^(javascript|vbscript|data):/i.test(scheme)) {
            link = { href, at: parts.length, done: false };
            activeLink = link;
          }
        }
        if (!content) return;
        // The rewriter keeps every registered handler until it fires, so the held count is the cost of
        // the next end tag. Past the cap the conversion stops: a throw rejects the rewriter's output.
        if (held >= HELD_CAP) throw new Error("end-tag handlers held");
        held++;
        const entry: Entry = { name, index: stack.length, own, popped: false, link };
        stack.push(entry);
        let list = open.get(name);
        if (!list) open.set(name, (list = []));
        list.push(entry);
        el.onEndTag(() => {
          held--;
          close(entry);
        });
      },
    })
    .onDocument({
      text(chunk) {
        raw += chunk.text;
        if (!chunk.lastInTextNode) return;
        const value = clean(decodeReferences(raw));
        raw = "";
        // Text directly inside an open head ends the head, as a browser ends it.
        const top = stack[stack.length - 1];
        if (top?.name === "head" && /\S/.test(value)) close(top);
        if (hidden === 0) parts.push(value);
      },
      end() {
        // A document that ends with elements open closes them, so their links and markers count.
        while (stack.length > 0) close(stack[stack.length - 1]!);
      },
    });
  await rewriter.transform(new Response(html)).text();
  const text = parts
    .join("")
    .replace(/ {2,}/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // A backstop: the output is never longer than the input. Markup is always longer than the text
  // that replaces it, so this only matters for a URL escaped longer than the markup around it.
  if (Buffer.byteLength(text) > Buffer.byteLength(html)) return "";
  budget.charge(Buffer.byteLength(text));
  return text;
}
