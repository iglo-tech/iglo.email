// The operator's brand on the public pages and the subscriber mail (B129, D127): the accent colour,
// the font and the header mode, as `appearance.brand.*`. The settings are validated where they are
// saved (src/settings/validate.ts), so these helpers only map a stored value to CSS and links; a
// value that reached them is one of the forms the validator accepts.

/** The colour links and buttons had before the brand setting (listmonk's public blue). */
export const defaultAccent = "#0055d4";

/** The public pages' stack before the brand setting (the body's own stack). */
const publicStack = `"Inter", "Open Sans", "Helvetica Neue", sans-serif`;
/** The stack the mails' body has before the brand setting. */
export const mailStack = `system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif`;

/** The fixed font choices, with the stack each one uses. Any other font is a Google Fonts family. */
const systemFonts = new Map<string, string>([
  ["system-sans", publicStack],
  ["system-serif", `Georgia, "Times New Roman", serif`],
  ["system-mono", `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`],
]);

export type BrandHeader = "auto" | "logo" | "name" | "logo_and_name";

/** The WCAG relative luminance of a validated `#rgb` or `#rrggbb` colour. */
function luminance(hex: string): number {
  const digits = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((at) => {
    const value = Number.parseInt(digits.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two colours, from 1 to 21. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/**
 * The focus ring colour (B129 review, D127): the accent when it stands out from the white page by
 * at least 3:1 (WCAG non-text contrast), else near-black, so a focus ring is never lost on a pale
 * accent.
 */
export function focusColour(accent: string): string {
  const colour = accent || defaultAccent;
  return contrast(colour, "#ffffff") >= 3 ? colour : "#111";
}

/**
 * The text colour on a button or a button-like link in the accent: black or white, whichever gives
 * the higher contrast (WCAG, B129 adopter check). A pale accent takes black text, a dark one white.
 */
export function onAccentText(accent: string): string {
  const colour = accent || defaultAccent;
  return contrast(colour, "#111") >= contrast(colour, "#ffffff") ? "#111" : "#ffffff";
}

/**
 * The font stack for a stored font value. A Google family is prepended to the stack the surface
 * already has (`fallback`), so a missing web font falls back to that stack, not a bare sans-serif.
 */
export function fontStack(font: string, fallback = publicStack): string {
  return systemFonts.get(font) ?? `"${font}", ${fallback}`;
}

/**
 * The Google Fonts stylesheet for a family, or "" for a system font. It asks for the 400, 600 and
 * 700 weights, so headings and the site name are not faux-bold. Only the public pages load it: a
 * subscriber's browser then contacts Google (the privacy note is in docs/operations.md). Mail never
 * loads it, since mail clients do not fetch web fonts reliably.
 */
export function googleFontUrl(font: string): string {
  if (systemFonts.has(font)) {
    return "";
  }
  const family = new URLSearchParams({ family: font }).toString();
  return `https://fonts.googleapis.com/css2?${family}:wght@400;600;700&display=swap`;
}

/**
 * What the header shows. Without a logo URL it is the site name whatever is stored: no mode shows
 * a bundled image (B129 review, D127). With one, `auto` is the logo and the other modes are as stored.
 */
export function headerMode(header: BrandHeader, hasLogo: boolean): Exclude<BrandHeader, "auto"> {
  if (!hasLogo) {
    return "name";
  }
  return header === "auto" ? "logo" : header;
}
