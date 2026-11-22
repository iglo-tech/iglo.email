// The operator's brand on the public pages and the subscriber mail (B129, D127): the accent colour,
// the font and the header mode, as `appearance.brand.*`. The settings are validated where they are
// saved (src/settings/validate.ts), so these helpers only map a stored value to CSS and links; a
// value that reached them is one of the forms the validator accepts.

/** The colour links and buttons had before the brand setting (listmonk's public blue). */
export const defaultAccent = "#0055d4";

/** The logo a mail or template shows: an http(s) URL, or "" for none (the name shows instead). */
export function safeLogo(value: string): string {
  if (!value) {
    return "";
  }
  if (Buffer.byteLength(value, "utf-8") > 64 * 1024) {
    throw new Error("Template data limit exceeded");
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : "";
  } catch {
    return "";
  }
}

/** The public pages' stack before the brand setting (the body's own stack). */
const publicStack = `"Inter", "Open Sans", "Helvetica Neue", sans-serif`;
/** The stack the mails' body has before the brand setting. */
export const mailStack = `system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif`;

/** The site settings a mail or a campaign's brand is made from (the stored values, as they are). */
export interface BrandSite {
  readonly logoUrl: string;
  readonly siteName: string;
  readonly siteUrl: string;
  readonly accent: string;
  readonly font: string;
  readonly header: BrandHeader;
}

/**
 * The brand values a mail or a campaign template reads (B129, D127). Every system mail and the
 * campaign and archive data take these, so a template can show the logo or name, the accent on its
 * buttons, the link colour on its links (readable on white), and the font. The logo passes only as an http(s) URL (safeLogo). A font that is
 * not a system choice is a Google family, and a mail takes its stack only, never the web font.
 */
export function mailBrand(site: BrandSite) {
  const logo = safeLogo(site.logoUrl);
  return {
    logo_url: logo,
    site_name: site.siteName,
    site_url: site.siteUrl,
    brand_accent: site.accent || defaultAccent,
    brand_link: linkColour(site.accent),
    brand_on_accent: onAccentText(site.accent),
    brand_font: site.font === "system-sans" ? "" : fontStack(site.font, mailStack),
    brand_header: headerMode(site.header, logo !== ""),
  };
}

/** The fixed font choices, with the stack each one uses. Any other font is a Google Fonts family. */
const systemFonts = new Map<string, string>([
  ["system-sans", publicStack],
  ["system-serif", `Georgia, "Times New Roman", serif`],
  ["system-mono", `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`],
]);

export type BrandHeader = "auto" | "logo" | "name" | "logo_and_name";

/** The red, green and blue channels (0 to 255) of a validated `#rgb` or `#rrggbb` colour. */
function channels(hex: string) {
  const digits =
    hex.length === 4
      ? hex
          .slice(1)
          .split("")
          .map((c) => c + c)
          .join("")
      : hex.slice(1);
  return {
    red: Number.parseInt(digits.slice(0, 2), 16),
    green: Number.parseInt(digits.slice(2, 4), 16),
    blue: Number.parseInt(digits.slice(4, 6), 16),
  };
}

/** The linear light of one channel (0 to 255), as WCAG defines it. */
function linearChannel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** The WCAG relative luminance of a validated `#rgb` or `#rrggbb` colour. */
function luminance(hex: string): number {
  const { red, green, blue } = channels(hex);
  return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue);
}

/** The hue (degrees), saturation and lightness (0 to 1) of a validated colour. */
function hsl(hex: string) {
  const { red, green, blue } = channels(hex);
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) {
    return { hue: 0, saturation: 0, lightness };
  }
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const sector =
    max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: (sector * 60 + 360) % 360, saturation, lightness };
}

/** The `#rrggbb` colour of a hue (degrees), saturation and lightness (0 to 1). */
function fromHsl(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = lightness - chroma / 2;
  let red = 0;
  let green = 0;
  let blue = 0;
  const sector = Math.floor(hue / 60);
  if (sector < 1) {
    red = chroma;
    green = secondary;
  } else if (sector < 2) {
    red = secondary;
    green = chroma;
  } else if (sector < 3) {
    green = chroma;
    blue = secondary;
  } else if (sector < 4) {
    green = secondary;
    blue = chroma;
  } else if (sector < 5) {
    red = secondary;
    blue = chroma;
  } else {
    red = chroma;
    blue = secondary;
  }
  const byte = (value: number) =>
    Math.round((value + offset) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(red)}${byte(green)}${byte(blue)}`;
}

/** The WCAG contrast ratio of two colours, from 1 to 21. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
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
 * The colour of brand-coloured text (links, and the outline button's text) on the white page and in
 * the mails (B129, D127). It is the accent when the accent has WCAG AA contrast (4.5:1) against white,
 * else the accent with its HSL lightness stepped down until it has. The accent itself stays the fill
 * of buttons and the bar, and the colour of borders, so only text takes this. Black is 21:1, so the
 * step always ends.
 */
export function linkColour(accent: string): string {
  const colour = accent || defaultAccent;
  if (contrast(colour, "#ffffff") >= 4.5) {
    return colour;
  }
  const { hue, saturation, lightness } = hsl(colour);
  let stepped = lightness;
  let candidate = colour;
  while (contrast(candidate, "#ffffff") < 4.5) {
    stepped = Math.max(0, stepped - 0.005);
    candidate = fromHsl(hue, saturation, stepped);
  }
  return candidate;
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
