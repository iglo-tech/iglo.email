// The operator's brand on the public pages and the subscriber mail (B129, D127): the accent colour,
// the font and the header mode, as `appearance.brand.*`. The settings are validated where they are
// saved (src/settings/validate.ts), so these helpers only map a stored value to CSS and links; a
// value that reached them is one of the forms the validator accepts.

/** The colour links and buttons had before the brand setting (listmonk's public blue). */
export const defaultAccent = "#0055d4";

/** The fixed font choices, with the stack each one uses. Any other font is a Google Fonts family. */
const systemFonts = new Map<string, string>([
  ["system-sans", `"Inter", "Open Sans", "Helvetica Neue", sans-serif`],
  ["system-serif", `Georgia, "Times New Roman", serif`],
  ["system-mono", `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`],
]);

export type BrandHeader = "auto" | "logo" | "name" | "logo_and_name";

/** The font stack a page or mail uses for a stored font value. */
export function fontStack(font: string): string {
  return systemFonts.get(font) ?? `"${font}", sans-serif`;
}

/**
 * The Google Fonts stylesheet for a family, or "" for a system font. Only the public pages load
 * it: a subscriber's browser then contacts Google (the privacy note is in docs/operations.md). Mail
 * never loads it, since mail clients do not fetch web fonts reliably.
 */
export function googleFontUrl(font: string): string {
  if (systemFonts.has(font)) {
    return "";
  }
  return `https://fonts.googleapis.com/css2?${new URLSearchParams({ family: font, display: "swap" })}`;
}

/**
 * What the header shows. `auto` is the logo when a logo is set and the site name otherwise; the
 * other modes are as stored.
 */
export function headerMode(header: BrandHeader, hasLogo: boolean): Exclude<BrandHeader, "auto"> {
  if (header !== "auto") {
    return header;
  }
  return hasLogo ? "logo" : "name";
}
