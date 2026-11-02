// Native: Amazon SES bounces and complaints over SNS. Adapted from listmonk
// internal/bounce/webhooks/ses.go at 6fcd95f: the certificate URL pattern, the string to sign,
// the bounce type mapping and the campaign header. Differences are listed in
// docs/design/04-sending.md#bounces: signature versions 1 and 2, bounded fetches, a bounded
// certificate cache, every recipient, and no stored headers or addresses in `meta`.
import { X509Certificate, createVerify } from "node:crypto";
import type { BounceEvent, BounceType } from "@/bounces/store";
import { campaignMessage, record, safeText, sendMessage } from "@/bounces/mailgun";
import type { Clock } from "@/clock";
import { sanitizeEmail } from "@/subscribers/email";

/** ses.go sesRegCertURL. */
const certUrl =
  /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\/SimpleNotificationService-[a-z0-9]+\.pem$/i;
/** A confirmation link: the same hosts, any path, so long as it is HTTPS on that host alone. */
const confirmUrl = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\/(\?[^#\s]*)?$/i;
export const SES_BODY_LIMIT = 256 * 1024;
const CERT_LIMIT = 16 * 1024;
const CERT_CACHE = 16;
const FETCH_TIMEOUT_MS = 5000;
/** SNS retries for hours at most; a receipt lasts a day, so an older message is a replay. */
export const SNS_MAX_AGE_MS = 86_400_000;
const SNS_MAX_AHEAD_MS = 15 * 60_000;

export interface SnsFetch {
  (url: string, init: { signal: AbortSignal; redirect: "error" }): Promise<Response>;
}
const strings = [
  "Message",
  "MessageId",
  "Signature",
  "SignatureVersion",
  "SigningCertURL",
  "Subject",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
  "SubscribeURL",
] as const;
export type Sns = Partial<Record<(typeof strings)[number], string>>;

/** The notification's string fields; anything else in the envelope is ignored. */
export function parseSns(text: string): Sns | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = record(body);
  const out: Sns = {};
  for (const key of strings) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return null;
    out[key] = value;
  }
  return out;
}

/** ses.go buildSignature, which is AWS's string to sign for the types handled here. */
function stringToSign(n: Sns) {
  const field = (name: keyof Sns) => `${name}\n${n[name] ?? ""}\n`;
  let out = field("Message") + field("MessageId");
  if (n.Subject) out += field("Subject");
  if (n.SubscribeURL) out += field("SubscribeURL");
  out += field("Timestamp");
  if (n.Token) out += field("Token");
  return out + field("TopicArn") + field("Type");
}

/** True when the URL is exactly an SNS endpoint of the pattern; the host carries no userinfo or port. */
function snsUrl(value: string, pattern: RegExp) {
  if (!pattern.test(value)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.port && url.protocol === "https:";
  } catch {
    return false;
  }
}

async function readCapped(response: Response, limit: number) {
  const length = Number(response.headers.get("content-length"));
  if (length > limit) throw new Error("too large");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader)
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error("too large");
      }
      chunks.push(item.value);
    }
  return Buffer.concat(chunks);
}

export function createSnsClient(deps: {
  clock: Clock;
  fetch?: SnsFetch;
  /** Certificates kept in memory. */
  cacheSize?: number;
}) {
  const fetcher: SnsFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const size = deps.cacheSize ?? CERT_CACHE;
  const certs = new Map<string, X509Certificate>();
  const pending = new Map<string, Promise<X509Certificate>>();
  const get = async (url: string, accept: (r: Response) => boolean, limit: number) => {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "error",
    });
    if (!accept(response)) {
      await response.body?.cancel();
      throw new Error(`status ${response.status}`);
    }
    return readCapped(response, limit);
  };
  const load = async (url: string) => {
    const body = await get(url, (r) => r.status === 200, CERT_LIMIT);
    return new X509Certificate(body);
  };
  async function certificate(url: string) {
    const cached = certs.get(url);
    if (cached) return cached;
    let loading = pending.get(url);
    if (!loading) {
      loading = load(url);
      pending.set(url, loading);
      loading.then(
        (cert) => {
          pending.delete(url);
          certs.set(url, cert);
          while (certs.size > size) certs.delete(certs.keys().next().value!);
        },
        () => pending.delete(url),
      );
    }
    return loading;
  }
  return {
    /**
     * True only for a notification signed by a certificate fetched from an SNS host of the
     * pattern, and neither stale nor from the future. Nothing in the message is used before this.
     */
    async verify(n: Sns): Promise<boolean> {
      try {
        const { Signature, SignatureVersion, SigningCertURL, Timestamp } = n;
        if (!Signature || !SigningCertURL || !snsUrl(SigningCertURL, certUrl)) return false;
        const algorithm =
          SignatureVersion === "1" ? "RSA-SHA1" : SignatureVersion === "2" ? "RSA-SHA256" : null;
        if (!algorithm) return false;
        const sent = Date.parse(Timestamp ?? "");
        const now = deps.clock.now().getTime();
        if (!Number.isFinite(sent) || now - sent > SNS_MAX_AGE_MS || sent - now > SNS_MAX_AHEAD_MS)
          return false;
        const cert = await certificate(SigningCertURL);
        if (now < cert.validFromDate.getTime() || now > cert.validToDate.getTime()) return false;
        const signature = Buffer.from(Signature, "base64");
        return createVerify(algorithm).update(stringToSign(n)).verify(cert.publicKey, signature);
      } catch {
        return false;
      }
    },
    /** Confirm a verified subscription by requesting its `SubscribeURL`. */
    async confirm(n: Sns): Promise<boolean> {
      const url = n.SubscribeURL;
      if (!url || !snsUrl(url, confirmUrl)) return false;
      try {
        await get(url, (r) => r.status === 200, CERT_LIMIT);
        return true;
      } catch {
        return false;
      }
    },
  };
}
export type SnsClient = ReturnType<typeof createSnsClient>;

const recipients = (value: unknown) =>
  Array.isArray(value) ? value.map((item) => record(item)) : [];

function bounceKind(inner: Record<string, unknown>) {
  const kind = typeof inner.eventType === "string" ? inner.eventType : "";
  const notification = typeof inner.notificationType === "string" ? inner.notificationType : "";
  // ses.go accepts eventType Bounce and notificationType Bounce or Complaint; a complaint event
  // published through a configuration set reports the same thing as eventType Complaint.
  if (kind && kind !== "Bounce" && kind !== "Complaint") return null;
  if (notification && notification !== "Bounce" && notification !== "Complaint") return null;
  return (kind || notification) === "Complaint" ? "Complaint" : "Bounce";
}

/**
 * The bounces a verified notification's message describes: one for each recipient, or null when
 * the message is not a bounce or complaint, or names nobody (ses.go returns an error).
 */
export function sesEvents(message: string, now: Date) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  const inner = record(parsed);
  const kind = bounceKind(inner);
  if (!kind) return null;
  const mail = record(inner.mail);
  const destination = Array.isArray(mail.destination)
    ? mail.destination.filter((item): item is string => typeof item === "string")
    : [];
  const bounce = record(inner.bounce);
  const complaint = record(inner.complaint);
  const listed = recipients(kind === "Complaint" ? complaint.complainedRecipients : bounce.bouncedRecipients);
  // ses.go takes `destination[0]`; the recipients SES names are used when it names any.
  const named: Record<string, unknown>[] = listed.length
    ? listed
    : destination.slice(0, 1).map((emailAddress) => ({ emailAddress }));
  if (!named.length) return null;

  let campaignUuid = "",
    subscriberUuid = "",
    messageId = "";
  if (mail.headersTruncated !== true && Array.isArray(mail.headers)) {
    for (const header of mail.headers) {
      const { name, value } = record(header);
      if (typeof name !== "string" || typeof value !== "string") continue;
      const lower = name.toLowerCase();
      // ses.go compares the name exactly; header names are case-insensitive.
      if (lower === "x-listmonk-campaign" && !campaignUuid) campaignUuid = value.trim();
      else if (lower === "x-listmonk-subscriber" && !subscriberUuid)
        subscriberUuid = value.trim();
      else if (lower === "message-id" && !messageId) messageId = value.trim();
    }
  }

  // Our own Message-ID names the send or the campaign delivery, as the Mailgun route reads it.
  const delivery = campaignMessage.exec(messageId);
  campaignUuid ||= delivery?.[1] ?? "";
  subscriberUuid ||= delivery?.[2] ?? "";
  const sendUuid = sendMessage.exec(messageId)?.[1]?.toLowerCase() ?? "";

  const timestamp = Date.parse(typeof mail.timestamp === "string" ? mail.timestamp : "");
  const createdAt = new Date(
    Number.isFinite(timestamp) ? Math.min(timestamp, now.getTime()) : now.getTime(),
  ).toISOString();
  const type = typeof bounce.bounceType === "string" ? bounce.bounceType : "";
  const events: BounceEvent[] = [];
  for (const entry of named) {
    const email = typeof entry.emailAddress === "string" ? sanitizeEmail(entry.emailAddress) : undefined;
    if (!email) continue;
    const status = typeof entry.status === "string" ? entry.status : "";
    let kindOfBounce: BounceType = "soft";
    if (kind === "Complaint") kindOfBounce = "complaint";
    else if (type === "Permanent" || (type === "Transient" && status === "5.4.4"))
      // "Invalid domain" is permanent, whatever SES calls it.
      kindOfBounce = "hard";
    const codes = {
      type: kind.toLowerCase(),
      bounce_type: safeText(type),
      bounce_sub_type: safeText(bounce.bounceSubType),
      status: safeText(status),
      action: safeText(entry.action),
      feedback_type: safeText(complaint.complaintFeedbackType),
      complaint_sub_type: safeText(complaint.complaintSubType),
      feedback_id: safeText(bounce.feedbackId ?? complaint.feedbackId),
      message_id: safeText(mail.messageId),
    };
    events.push({
      subscriberUuid: /^[0-9a-f-]{36}$/i.test(subscriberUuid) ? subscriberUuid.toLowerCase() : "",
      email,
      campaignUuid: campaignUuid.toLowerCase(),
      sendUuid,
      recipient: email,
      type: kindOfBounce,
      source: "ses",
      meta: JSON.stringify({ ...codes, diagnostic_code: safeText(entry.diagnosticCode) }),
      bareMeta: JSON.stringify(codes),
      bareSource: "ses",
      createdAt,
    });
  }
  return events;
}

