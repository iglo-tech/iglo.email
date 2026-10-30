// Native: Mailgun's webhook, which listmonk lacks (docs/design/04-sending.md#bounces). Pure
// signature checks and parsing; a test's payloads follow Mailgun's documented shape.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { BounceEvent, BounceType } from "@/bounces/store";
import { sanitizeEmail } from "@/subscribers/email";

/** How far a signature's timestamp may sit from now, either way. */
export const SIGNATURE_WINDOW_MS = 15 * 60_000;
const MAX_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 1000;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const sendMessage = new RegExp(`^<?(${uuid})@[^@>\\s]+>?$`, "i");
const campaignMessage = new RegExp(`^<?(${uuid})\\.(${uuid})@[^@>\\s]+>?$`, "i");
const addresses = /[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g;

const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The token a valid, fresh signature carries, with the time its replay stops mattering. */
export function verifySignature(body: unknown, key: string, now: Date) {
  const { timestamp, token, signature } = record(record(body).signature);
  if (
    typeof timestamp !== "string" ||
    typeof token !== "string" ||
    typeof signature !== "string" ||
    !/^\d{1,12}$/.test(timestamp) ||
    !token ||
    token.length > MAX_ID_LENGTH ||
    !/^[0-9a-f]{64}$/i.test(signature)
  )
    return null;
  const expected = createHmac("sha256", key).update(`${timestamp}${token}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return null;
  const signedAt = Number(timestamp) * 1000;
  if (Math.abs(now.getTime() - signedAt) > SIGNATURE_WINDOW_MS) return null;
  return { token, expiresAt: new Date(signedAt + SIGNATURE_WINDOW_MS + 1000) };
}

function bounceType(data: Record<string, unknown>): BounceType | null {
  if (data.event === "complained") return "complaint";
  if (data.event !== "failed") return null;
  if (data.severity === "permanent") return "hard";
  return data.severity === "temporary" ? "soft" : null;
}

/** Provider text is bounded and loses addresses, which it often repeats. */
function safeText(value: unknown) {
  if (typeof value !== "string" || !value) return undefined;
  return value.slice(0, MAX_TEXT_LENGTH).replace(addresses, "[address]");
}

/**
 * The stored `meta`: why it bounced, and nothing of the message. Headers, the subject, the
 * envelope, client details and user variables are never kept.
 */
function bounceMeta(data: Record<string, unknown>) {
  const status = record(data["delivery-status"]);
  return JSON.stringify({
    event_id: safeText(data.id),
    event: data.event,
    severity: safeText(data.severity),
    reason: safeText(data.reason),
    code: typeof status.code === "number" ? status.code : undefined,
    message: safeText(status.message),
    description: safeText(status.description),
  });
}

/** The bounce an accepted event describes, or null for an event that is not one. */
export function mailgunEvent(body: unknown, now: Date) {
  const data = record(record(body)["event-data"]);
  const type = bounceType(data);
  if (!type) return null;
  const messageId = record(record(data.message).headers)["message-id"];
  const id = typeof messageId === "string" ? messageId.trim() : "";
  const campaign = campaignMessage.exec(id);
  const email = typeof data.recipient === "string" ? sanitizeEmail(data.recipient) : undefined;
  const event: BounceEvent = {
    subscriberUuid: campaign?.[2]?.toLowerCase() ?? "",
    email: email ?? "",
    campaignUuid: campaign?.[1]?.toLowerCase() ?? "",
    sendUuid: sendMessage.exec(id)?.[1]?.toLowerCase() ?? "",
    type,
    source: "mailgun",
    meta: bounceMeta(data),
    createdAt: now.toISOString(),
  };
  const eventId = typeof data.id === "string" && data.id.length <= MAX_ID_LENGTH ? data.id : "";
  return { event, eventId };
}
