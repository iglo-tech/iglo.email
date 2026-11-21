// Test-only reader for a message captured by the loopback SMTP sink. The sink keeps the DATA
// section as latin1 octets, so each part is decoded from its transfer encoding (quoted-printable or
// base64) and then as UTF-8. No MIME library is a dependency; this reads only what the tests check.

export interface MimePart {
  /** Unfolded header block, lines joined by LF. */
  headers: string;
  /** Lowercase media type from Content-Type, without parameters. */
  type: string;
  /** Decoded body, with LF line endings. */
  text: string;
  header(name: string): string | null;
}

function splitPart(raw: string): MimePart {
  const at = raw.indexOf("\r\n\r\n");
  const headerBlock = at < 0 ? raw : raw.slice(0, at);
  const body = at < 0 ? "" : raw.slice(at + 4);
  const headers = headerBlock.replace(/\r\n[ \t]+/g, " ").replace(/\r\n/g, "\n");
  const header = (name: string) =>
    new RegExp(`^${name}:[ \\t]*(.*)$`, "mi").exec(headers)?.[1]?.trim() ?? null;
  const type = (header("Content-Type") ?? "text/plain").split(";")[0]!.trim().toLowerCase();
  const encoding = (header("Content-Transfer-Encoding") ?? "7bit").toLowerCase();
  let text: string;
  if (encoding === "base64") {
    text = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  } else if (encoding === "quoted-printable") {
    const octets = body
      .replace(/=\r\n/g, "")
      .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    text = Buffer.from(octets, "latin1").toString("utf8");
  } else {
    text = Buffer.from(body, "latin1").toString("utf8");
  }
  return { headers, type, text: text.replace(/\r\n/g, "\n"), header };
}

/** The top-level part of a captured DATA section, with its child parts when it is multipart. */
export function parseMail(data: string): { top: MimePart; parts: MimePart[] } {
  const at = data.indexOf("\r\n\r\n");
  const top = splitPart(data);
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(top.headers)?.[1];
  if (!boundary || at < 0) return { top, parts: [] };
  const body = data.slice(at + 4);
  const parts = body
    .split(`--${boundary}`)
    .slice(1)
    .filter((segment) => !segment.startsWith("--"))
    .map((segment) => splitPart(segment.replace(/^\r\n/, "").replace(/\r\n$/, "")));
  return { top, parts };
}

/** The text/plain part of a multipart message, or undefined when there is none. */
export function textPart(data: string): string | undefined {
  return parseMail(data).parts.find((part) => part.type === "text/plain")?.text;
}

/** The text/html part of a multipart message, or undefined when there is none. */
export function htmlPart(data: string): string | undefined {
  return parseMail(data).parts.find((part) => part.type === "text/html")?.text;
}
