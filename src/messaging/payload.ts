// Versioned prepared messages are private journal data, never HTTP projections.
import type { Message } from "@/messaging/email";
import { parseAddress } from "@/settings/mail";

const maxBody = 1024 * 1024;
const maxAttachments = 4 * 1024 * 1024;
const maxPayload = 8 * 1024 * 1024;
const safe = (s: unknown, max: number): s is string =>
  typeof s === "string" && Buffer.byteLength(s) <= max && !/[\r\n\0]/.test(s);
const address = (s: unknown): s is string => safe(s, 2048) && parseAddress(s) !== undefined;
const bytes = (value: unknown, max: number): value is Uint8Array =>
  value instanceof Uint8Array && value.byteLength <= max;
const mediaType = (value: unknown): value is string =>
  safe(value, 2048) &&
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"\r\n\0]*"))*$/.test(
    value,
  );
const invalid = (): never => {
  throw new Error("Invalid prepared message");
};

export function encodePayload(message: Message, subscriberUuid: string | null): string {
  if (
    !message ||
    !address(message.from) ||
    !Array.isArray(message.to) ||
    message.to.length !== 1 ||
    !address(message.to[0]) ||
    !safe(message.subject, 2048) ||
    !["plain", "html"].includes(message.contentType) ||
    !bytes(message.body, maxBody) ||
    (message.altBody !== undefined && !bytes(message.altBody, maxBody)) ||
    (message.messenger !== undefined && !safe(message.messenger, 2048))
  )
    invalid();
  if (
    message.headers !== undefined &&
    (!message.headers || typeof message.headers !== "object" || Array.isArray(message.headers))
  )
    invalid();
  const headers: Record<string, string | string[]> = {};
  const entries = Object.entries(message.headers ?? {});
  if (entries.length > 64) invalid();
  for (const [name, value] of entries) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) invalid();
    if (Array.isArray(value)) {
      if (value.length !== 1 || !safe(value[0], 2048)) invalid();
      headers[name] = [...value];
    } else {
      if (!safe(value, 2048)) invalid();
      headers[name] = value;
    }
    if (["cc", "bcc"].includes(name.toLowerCase())) {
      const list = (Array.isArray(value) ? value[0]! : value).split(",");
      if (!list.length || list.some((v) => !address(v.trim()))) invalid();
    }
  }
  if (message.attachments !== undefined && !Array.isArray(message.attachments)) invalid();
  const attachments = message.attachments ?? [];
  if (attachments.length > 10) invalid();
  let total = 0;
  const encodedAttachments = attachments.map((a) => {
    if (
      !a ||
      !safe(a.name, 2048) ||
      !a.name ||
      !bytes(a.content, maxAttachments) ||
      (a.cid !== undefined && !safe(a.cid, 2048)) ||
      (a.contentType !== undefined && !mediaType(a.contentType)) ||
      (a.inline !== undefined && typeof a.inline !== "boolean") ||
      (a.disposition !== undefined && !["inline", "attachment"].includes(a.disposition))
    )
      invalid();
    total += a.content.byteLength;
    if (total > maxAttachments) invalid();
    return {
      name: a.name,
      content: Buffer.from(a.content).toString("base64"),
      ...(a.cid === undefined ? {} : { cid: a.cid }),
      ...(a.contentType === undefined ? {} : { contentType: a.contentType }),
      ...(a.inline === undefined ? {} : { inline: a.inline }),
      ...(a.disposition === undefined ? {} : { disposition: a.disposition }),
    };
  });
  const payload = JSON.stringify({
    version: 1,
    subscriberUuid,
    message: {
      from: message.from,
      to: [...message.to],
      subject: message.subject,
      contentType: message.contentType,
      body: Buffer.from(message.body).toString("base64"),
      ...(message.altBody === undefined
        ? {}
        : { altBody: Buffer.from(message.altBody).toString("base64") }),
      headers,
      attachments: encodedAttachments,
      ...(message.messenger === undefined ? {} : { messenger: message.messenger }),
    },
  });
  if (Buffer.byteLength(payload) > maxPayload) invalid();
  return payload;
}
export function decodePayload(payload: string): {
  message: Message;
  subscriberUuid: string | null;
} {
  if (typeof payload !== "string" || Buffer.byteLength(payload) > maxPayload) invalid();
  try {
    const raw = JSON.parse(payload);
    if (
      raw.version !== 1 ||
      !(raw.subscriberUuid === null || typeof raw.subscriberUuid === "string")
    )
      invalid();
    const decode = (v: unknown, max: number) => {
      if (
        typeof v !== "string" ||
        v.length > Math.ceil(max / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)
      )
        invalid();
      const result = Buffer.from(v as string, "base64");
      if (result.length > max || result.toString("base64") !== v) invalid();
      return result;
    };
    const m = raw.message;
    if (!m || !Array.isArray(m.attachments) || m.attachments.length > 10) invalid();
    const message: Message = {
      ...m,
      body: decode(m.body, maxBody),
      ...(m.altBody === undefined ? {} : { altBody: decode(m.altBody, maxBody) }),
      attachments: m.attachments.map((a: { content: unknown }) => ({
        ...a,
        content: decode(a.content, maxAttachments),
      })),
    };
    encodePayload(message, raw.subscriberUuid);
    return { message, subscriberUuid: raw.subscriberUuid };
  } catch {
    return invalid();
  }
}
