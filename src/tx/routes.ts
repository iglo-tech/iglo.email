// Transactional API adapted from listmonk cmd/tx.go (SendTxMessage, validateTxMessage)
// and models/messages.go (TxMessage.Render) at 6fcd95f. Recipient rules, idempotency,
// async and the response body follow docs/design/04-sending.md; marketing unsubscribe
// links, headers and tracking come from src/unsubscribe (M2.4).
import { refuseWhileHeld } from "@/settings/hold";
import { createHash } from "node:crypto";
import { dummyUUID } from "@/campaigns/render";
import type { Message } from "@/messaging/email";
import type { RequestedSend, Sends } from "@/messaging/sends";
import type { startOutbox } from "@/messaging/outbox";
import { parseAddress } from "@/settings/mail";
import type { ListReferences } from "@/lists/references";
import type { Attachments } from "@/media/attachments";
import type { EmbedImages } from "@/media/embed";
import { UploadRootError } from "@/media/filesystem";
import type { Handler } from "@/server/context";
import type { Router } from "@/server/router";
import { HttpError, ok } from "@/server/response";
import type { SubscriberStore } from "@/subscribers/store";
import { allowedDomain, sanitizeEmail } from "@/subscribers/email";
import type { TemplateStore } from "@/templates/store";
import { RenderCapacityError, type TemplateRenderer } from "@/templates/renderer";
import type { Authentication } from "@/users/auth";
import { createByteGate, type ByteGate, type Reservation } from "@/tx/gate";
import { BODY_LIMIT, readTxMessage, TxInputError, type TxMessage } from "@/tx/input";
import { messageLinks } from "@/unsubscribe/message";
import type { MarketingSettings } from "@/unsubscribe/policy";
import type { Tracking } from "@/unsubscribe/tracking";

const MAX_RECIPIENTS = 100;
/** Aggregate prepared bytes for one request; each payload is also bounded by messaging. */
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
/**
 * Memory a send with attachments may hold at once, across requests (D74, D87). Counted bytes are
 * real bytes: the multipliers below are measured peak RSS growth per attachment byte
 * (docs/perf/B26-tx-memory.md), so the budget bounds the counted, measured-per-copy memory (on top
 * of a fixed ~25 MiB and the garbage collector's lag, which let measured peaks reach 389 MiB). A multipart upload costs its body about 4.3
 * times while it is parsed (read chunks, joined body, form, file copy); after it the journal encodes and decodes one payload per
 * recipient, and each synchronous recipient's message is pushed concurrently with a decoded copy,
 * a base64 string and the SMTP library's own encoding.
 */
const MAX_ATTACHMENT_BYTES_IN_FLIGHT = 128 * 1024 * 1024;
const MAX_ATTACHMENT_SENDS = 64;
/** How long an upload waits for room before a 429. */
const ATTACHMENT_WAIT_MS = 2000;
/** Held from the journal write on: a fixed part per attachment byte, then one per recipient. */
const HELD_COPIES = 4;
/** A synchronous recipient also keeps its decoded copy and SMTP encoding until the server answers. */
const HELD_COPIES_PER_RECIPIENT = 7;
/** An async recipient is only encoded into the journal here; its send happens later, in turn. */
const ENCODED_COPIES_PER_RECIPIENT = 5;
/**
 * Charged against a multipart body's size before it is read: the parse itself peaks near 4.3 times
 * the body, but the reservation is kept for the journal write and a one-recipient send after it, so
 * a request admitted to parse does not then find the room gone and answer 429 after its work.
 */
const PARSE_COPIES = HELD_COPIES + HELD_COPIES_PER_RECIPIENT;
type Slot = { reservation: Reservation | null };
const MAX_KEY_BYTES = 255;
const MAX_HEADERS = 64;
const headerName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface TxPolicy {
  fromEmail: string;
  domainAllowlist: string[];
  domainBlocklist: string[];
}
type Outbox = Pick<ReturnType<typeof startOutbox>, "dispatch">;
type SubscriberRow = NonNullable<ReturnType<SubscriberStore["get"]>>;

/** Go textproto.CanonicalMIMEHeaderKey for valid token names. */
function canonical(name: string): string {
  let upper = true;
  let out = "";
  for (const c of name) {
    out += upper ? c.toUpperCase() : c.toLowerCase();
    upper = c === "-";
  }
  return out;
}
/** listmonk models.Subscriber FirstName/LastName: first/last space chunk over two bytes. */
function nameChunk(name: string, last: boolean): string {
  const chunks = name.split(" ");
  if (last) chunks.reverse();
  return chunks.find((chunk) => Buffer.byteLength(chunk) > 2) ?? name;
}
function subscriberContext(row: SubscriberRow | null, email: string) {
  const name = row?.name ?? "";
  return {
    id: row ? Number(row.id) : 0,
    uuid: row?.uuid ?? "",
    email: row?.email ?? email,
    name,
    first_name: nameChunk(name, false),
    last_name: nameChunk(name, true),
    attribs: row ? (JSON.parse(row.attribs) as unknown) : {},
    status: row?.status ?? "",
    external_id: row?.external_id ?? "",
  };
}

export function registerTxRoutes(
  router: Router,
  deps: {
    auth: Authentication;
    sends: Sends;
    outbox: Outbox;
    subscribers: SubscriberStore;
    templates: TemplateStore;
    renderer: TemplateRenderer;
    lists: ListReferences;
    policy: () => TxPolicy;
    marketing: { settings: () => MarketingSettings; tracking: Tracking };
    attachments: Attachments;
    embedImages: EmbedImages;
    /** Test seam for the attachment budget; production uses the constants above. */
    limits?: {
      maxBytes?: number;
      maxSends?: number;
      waitMs?: number;
      maxOvertakes?: number;
    };
  },
) {
  const budget = deps.limits?.maxBytes ?? MAX_ATTACHMENT_BYTES_IN_FLIGHT;
  let gate: ByteGate | undefined;
  const busy = () =>
    new HttpError(429, "Too many sends with attachments in progress.", {
      "Retry-After": "1",
    });
  /** Gives the handler its reservation slot and releases whatever it still holds on any exit. */
  const guarded =
    (
      inner: (context: Parameters<Handler>[0], gate: ByteGate, slot: Slot) => ReturnType<Handler>,
    ): Handler =>
    async (context) => {
      gate ??= createByteGate({
        clock: context.app.clock,
        maxBytes: budget,
        maxHolders: deps.limits?.maxSends ?? MAX_ATTACHMENT_SENDS,
        waitMs: deps.limits?.waitMs ?? ATTACHMENT_WAIT_MS,
        ...(deps.limits?.maxOvertakes === undefined
          ? {}
          : { maxOvertakes: deps.limits.maxOvertakes }),
      });
      const slot: Slot = { reservation: null };
      try {
        return await inner(context, gate, slot);
      } finally {
        slot.reservation?.release();
      }
    };
  router.route(
    "POST",
    "/api/tx",
    guarded(async (context, gate, slot) => {
      const t = context.app.i18n;
      const invalid = (name: string) =>
        new HttpError(400, t.Ts("globals.messages.invalidFields", "name", name));
      let m: TxMessage;
      try {
        // Only a multipart body can carry caller attachments. Its parse buffers are charged
        // before it is read, from its declared size or the cap, and waited for briefly.
        if ((context.request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
          const declared = Number(context.request.headers.get("content-length"));
          // A body over the cap is 413 whatever the load: it is never read, so it needs no room.
          if (declared > BODY_LIMIT) throw new HttpError(413);
          const size = declared > 0 ? declared : BODY_LIMIT;
          slot.reservation = await gate.acquire(size * PARSE_COPIES);
          if (!slot.reservation) throw busy();
        }
        m = await readTxMessage(context.request);
      } catch (error) {
        if (error instanceof TxInputError) throw invalid(error.field);
        throw error;
      }
      // An async message is a row that waits with the rest of the queue; this one would not.
      if (!m.async) refuseWhileHeld(context.app.db);
      const policy = deps.policy();
      const requestedFrom = m.fromEmail;
      const { emails, ids, mode } = validate(m, policy, invalid, {
        invalidEmail: t.T("globals.messages.invalidEmail"),
        blocklisted: t.T("subscribers.domainBlocklisted"),
        messenger: t.Ts("campaigns.fieldInvalidMessenger", "name", m.messenger),
      });

      const kind = m.kind || "transactional";
      if (kind !== "transactional" && kind !== "marketing") throw invalid("kind");
      if (kind === "marketing" ? m.listId <= 0n : m.listId !== 0n) throw invalid("list_id");
      if (Buffer.byteLength(m.idempotencyKey) > MAX_KEY_BYTES) throw invalid("idempotency_key");

      // Headers: textproto.MIMEHeader.Add per set, then the messenger uses each first value.
      const headers: Record<string, string> = Object.create(null);
      for (const set of m.headers)
        for (const [name, value] of Object.entries(set)) {
          if (!headerName.test(name) || /[\r\n\0]/.test(value) || Buffer.byteLength(value) > 2048)
            throw invalid("headers");
          const key = canonical(name);
          if (!Object.hasOwn(headers, key)) headers[key] = value;
          if (Object.keys(headers).length > MAX_HEADERS) throw invalid("headers");
        }
      // A marketing send has one SMTP recipient, the admitted subscriber: copies would
      // bypass consent, the frequency cap and the scoped unsubscribe link.
      if (kind === "marketing" && (Object.hasOwn(headers, "Cc") || Object.hasOwn(headers, "Bcc")))
        throw invalid("headers");
      if (
        typeof m.fromEmail !== "string" ||
        /[\r\n\0]/.test(m.fromEmail) ||
        parseAddress(m.fromEmail) === undefined
      )
        throw invalid("from_email");
      for (const a of m.attachments)
        if (
          /[\r\n\0]/.test(a.name) ||
          Buffer.byteLength(a.name) > 2048 ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"\r\n\0]*"))*$/.test(
            a.contentType,
          ) ||
          Buffer.byteLength(a.contentType) > 2048
        )
          throw invalid("file");

      // A retry replays its first result before consulting mutable lists, templates or
      // subscribers, so later edits to them cannot turn it into an error.
      const idempotency = m.idempotencyKey
        ? {
            key: m.idempotencyKey,
            fingerprint: fingerprint(m, requestedFrom, mode, emails, ids, headers),
          }
        : null;
      const authorize = () => deps.auth.revalidate(context, "tx:send");
      if (idempotency) {
        const previous = deps.sends.replayRequest({ idempotency, authorize });
        if (previous) return ok({ sends: previous.sends });
      }

      if (kind === "marketing" && !deps.lists.subscriberMetadata(m.listId))
        throw new HttpError(400, t.Ts("globals.messages.notFound", "name", `list ${m.listId}`));
      const template = m.templateId > 0n ? deps.templates.get(m.templateId) : null;
      if (!template || template.type !== "tx")
        throw new HttpError(
          400,
          t.Ts("globals.messages.notFound", "name", `template ${m.templateId}`),
        );

      // upstream's CacheTpl embeds once. Here a template has no cached form: its images are found
      // for each request and the bytes come through the attachment cache, which checks the file,
      // so a media change applies to the next send. The journal keeps what each send carried.
      // Files are read before the recipients, so nothing awaits between those and the journal.
      const embedded = deps.embedImages({
        content_type: "html",
        body: template.body,
        templateBody: "",
      });
      if (embedded.problem)
        throw new HttpError(400, t.Ts("templates.errorRendering", "error", embedded.problem));
      const inline = await deps.attachments([], embedded.images).catch((error) => {
        const reason = error instanceof UploadRootError ? error.message : "embedded image";
        throw new HttpError(500, t.Ts("templates.errorRendering", "error", reason));
      });

      // Resolve every recipient before rendering or writing anything.
      const recipients: Array<{ row: SubscriberRow | null; email: string }> = [];
      const notFound = (label: string) =>
        new HttpError(
          400,
          t.Ts("globals.messages.notFound", "name", `{globals.terms.subscriber} (${label})`),
        );
      if (m.subscriberExternalId) {
        const row = deps.subscribers.external(m.subscriberExternalId);
        if (!row) throw notFound(`external_id: ${m.subscriberExternalId}`);
        recipients.push({ row, email: row.email });
      } else if (ids.length)
        for (const id of ids) {
          const row = id > 0n ? deps.subscribers.get(id) : null;
          if (!row) throw notFound(`${id}: `);
          recipients.push({ row, email: row.email });
        }
      else
        for (const email of emails) {
          // Any address can receive a transactional email; `external` skips the lookup.
          const row = mode === "external" ? null : deps.subscribers.byEmail(email);
          recipients.push({ row, email: row?.email ?? email });
        }

      // Render. listmonk renders the template body, then a templated subject/alt body.
      const marketing = kind === "marketing";
      const transactional = {
        mode: "html" as const,
        transactional: !marketing,
      };
      let body: ReturnType<TemplateRenderer["compile"]>;
      let alt: ReturnType<TemplateRenderer["compile"]> | null = null;
      const renderError = () =>
        new HttpError(400, t.Ts("templates.errorRendering", "error", "invalid template"));
      try {
        body = deps.renderer.compile({
          ...transactional,
          body: embedded.campaign.body,
          subject: m.subject || template.subject,
        });
        if (m.altBody && /\{\{|\{%/.test(m.altBody))
          alt = deps.renderer.compile({
            body: m.altBody,
            mode: "plain",
            transactional: !marketing,
          });
      } catch {
        throw renderError();
      }
      const contentType = m.contentType === "plain" ? "plain" : "html";
      const requested: RequestedSend[] = [];
      const marketingSettings = deps.marketing.settings();
      const links = messageLinks(marketingSettings, deps.marketing.tracking);
      const root = marketingSettings.rootUrl.replace(/\/+$/, "");
      const attachments = [
        ...m.attachments.map((a) => ({
          name: a.name,
          content: a.content,
          contentType: a.contentType,
        })),
        ...inline,
      ];
      const attachmentBytes = attachments.reduce((sum, a) => sum + a.content.byteLength, 0);
      let total = 0;
      for (const recipient of recipients) {
        // The send UUID is fixed before rendering so its URLs can carry it.
        const uuid = crypto.randomUUID();
        const prepared = links({
          uuid,
          kind,
          subscriberUuid: recipient.row?.uuid ?? null,
        });
        const unsubscribe = marketing
          ? `,"unsubscribe_url":${JSON.stringify(prepared.unsubscribeUrl ?? "")}`
          : "";
        // Preferences for a known subscriber: scoped by the send when marketing, else general.
        const preferences =
          prepared.unsubscribeUrl ??
          (recipient.row ? `${root}/subscription/${dummyUUID}/${recipient.row.uuid}` : "");
        const manage = `,"manage_url":${JSON.stringify(preferences && `${preferences}?manage=true`)}`;
        const data = `{"subscriber":${JSON.stringify(subscriberContext(recipient.row, recipient.email))},"data":${m.data ?? "{}"}${unsubscribe}${manage}}`;
        let rendered: { body: string; subject: string };
        let altBody = m.altBody;
        try {
          rendered = body.renderSync(data, prepared.tracking);
          if (alt) altBody = alt.renderSync(data, prepared.tracking).body;
        } catch (error) {
          if (error instanceof RenderCapacityError)
            throw new HttpError(429, "Too many template renders in progress.");
          throw renderError();
        }
        if (/[\r\n\0]/.test(rendered.subject)) throw renderError();
        const message: Message = {
          from: m.fromEmail,
          to: [recipient.email],
          subject: rendered.subject,
          contentType,
          body: Buffer.from(rendered.body),
          ...(altBody ? { altBody: Buffer.from(altBody) } : {}),
          // The generated List-Unsubscribe pair replaces caller values of the same name.
          headers: { ...headers, ...prepared.headers },
          attachments,
        };
        total += message.body.byteLength + (message.altBody?.byteLength ?? 0) + attachmentBytes;
        if (total > MAX_REQUEST_BYTES) throw new HttpError(413);
        requested.push({
          send: {
            uuid,
            source: "tx",
            kind,
            message,
            subscriberId: recipient.row?.id ?? null,
            templateId: template.id,
            listId: kind === "marketing" ? m.listId : null,
          },
          subscriberUuid: recipient.row?.uuid ?? null,
        });
      }

      // The journal encodes every recipient's payload, and each synchronous send decodes its own
      // copy of every attachment and holds it until SMTP answers. An async send is encoded in the
      // request, then its row waits in the journal and the outbox loop sends one batch at a time.
      const held = attachments.length
        ? attachmentBytes *
          (HELD_COPIES +
            (m.async ? ENCODED_COPIES_PER_RECIPIENT : HELD_COPIES_PER_RECIPIENT) * requested.length)
        : 0;
      // A charge over the whole budget can never be admitted, even on an idle server, so a 429
      // would make a retrying client loop forever. Main answered such a request with this 400.
      if (held > budget)
        throw new HttpError(400, t.Ts("templates.errorRendering", "error", "invalid message"));
      if (!held) {
        slot.reservation?.release();
        slot.reservation = null;
      } else if (slot.reservation) {
        if (held <= slot.reservation.bytes) slot.reservation.shrink(held);
        else if (!slot.reservation.grow(held - slot.reservation.bytes)) throw busy();
      } else {
        slot.reservation = gate.admit(held);
        if (!slot.reservation) throw busy();
      }

      let result: ReturnType<Sends["enqueueRequest"]>;
      try {
        result = deps.sends.enqueueRequest({
          sends: requested,
          idempotency,
          authorize,
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        // The renderer bounded every field; a prepared-payload rejection is invalid input.
        throw new HttpError(400, t.Ts("templates.errorRendering", "error", "invalid message"));
      }
      // Synchronously after commit, so the outbox loop cannot claim these rows first.
      if (!m.async && result.queued.length) {
        await deps.outbox.dispatch(result.queued);
        const current = result.ids.map((id, i) => deps.sends.summary(id) ?? result.sends[i]!);
        return ok({ sends: current });
      }
      return ok({ sends: result.sends });
    }),
    deps.auth.middleware("tx:send"),
  );
}

function validate(
  m: TxMessage,
  policy: TxPolicy,
  invalid: (name: string) => HttpError,
  messages: { invalidEmail: string; blocklisted: string; messenger: string },
) {
  if (m.subscriberEmails.length && m.subscriberEmail)
    throw invalid("do not send `subscriber_email`");
  if (m.subscriberIds.length && m.subscriberId !== 0n) throw invalid("do not send `subscriber_id`");
  const emails = [...m.subscriberEmails];
  const ids = [...m.subscriberIds];
  if (m.subscriberEmail) emails.push(m.subscriberEmail);
  if (m.subscriberId !== 0n) ids.push(m.subscriberId);
  const mode = m.subscriberMode || "default";
  const external = m.subscriberExternalId ? 1 : 0;
  switch (mode) {
    case "default":
      if ((emails.length ? 1 : 0) + (ids.length ? 1 : 0) + external !== 1)
        throw invalid("send subscriber_emails OR subscriber_ids");
      break;
    case "fallback":
    case "external":
      if (ids.length || external)
        throw invalid("subscriber_ids not allowed in fallback or external mode");
      if (!emails.length) throw invalid("subscriber_emails");
      break;
    default:
      throw invalid("subscriber_mode");
  }
  if (emails.length + ids.length > MAX_RECIPIENTS) throw invalid("subscriber_emails");
  for (let i = 0; i < emails.length; i++) {
    const email = sanitizeEmail(emails[i]!);
    if (email === undefined || /[\r\n\0]/.test(email))
      throw new HttpError(400, messages.invalidEmail);
    if (!allowedDomain(email, policy.domainAllowlist, policy.domainBlocklist))
      throw new HttpError(400, messages.blocklisted);
    emails[i] = email;
  }
  if (!m.fromEmail) m.fromEmail = policy.fromEmail;
  if (m.messenger && m.messenger !== "email") throw new HttpError(400, messages.messenger);
  return { emails, ids, mode };
}

/** Stable digest of the normalized request; `async` only changes when the caller waits. */
function fingerprint(
  m: TxMessage,
  from: string,
  mode: string,
  emails: string[],
  ids: bigint[],
  headers: Record<string, string>,
): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([
      mode,
      emails,
      ids.map(String),
      m.subscriberExternalId,
      String(m.templateId),
      m.data,
      from,
      Object.entries(headers),
      m.contentType,
      m.messenger,
      m.subject,
      m.altBody,
      m.kind || "transactional",
      String(m.listId),
      m.attachments.map((a) => [
        a.name,
        a.contentType,
        createHash("sha256").update(a.content).digest("hex"),
      ]),
    ]),
  );
  return hash.digest("hex");
}
