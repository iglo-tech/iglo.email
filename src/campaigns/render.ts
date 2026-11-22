// Campaign message composition adapted from listmonk models/campaigns.go (CompileTemplate),
// internal/manager/message.go (render) and manager.go (TemplateFuncs, message headers) at
// 6fcd95f, on the M1.8 Liquid renderer (docs/design/06-templates.md).
import type { ContentType, WritableCampaign } from "@/campaigns/store";
import { hasTemplate } from "@/campaigns/input";
import { createMessageBudget } from "@/templates/renderer";
import type { RenderRequest, RenderTracking, TemplateRenderer } from "@/templates/renderer";

export const dummyUUID = "00000000-0000-0000-0000-000000000000";
/**
 * D117: the campaign part of a test message's per-subscriber links. Where a real send names its
 * campaign, a test names this, so its unsubscribe, manage, message and opt-in links open the test
 * page and change nothing. Not `dummyUUID`: that one is the opt-in mail's placeholder, which ends a
 * subscriber's unconfirmed subscriptions.
 */
export const testSendUUID = "00000000-0000-0000-0000-000000000001";
/** listmonk's preview subscriber (cmd/subscribers.go dummySubscriber). */
export const dummySubscriber: CampaignSubscriber = {
  uuid: dummyUUID,
  email: "demo@listmonk.app",
  name: "Demo Subscriber",
  attribs: { city: "Bengaluru" },
  external_id: "",
};
export interface CampaignSubscriber {
  uuid: string;
  email: string;
  name: string;
  attribs: Record<string, unknown>;
  external_id: string;
}
/** The campaign fields a message needs. */
export type MessageCampaign = Pick<
  WritableCampaign,
  "name" | "subject" | "from_email" | "body" | "altbody" | "content_type" | "headers" | "attribs"
> & { uuid: string; templateBody: string };
export interface MessageLinks {
  /** The configured root URL, for the public page URLs. */
  rootUrl: string;
  unsubscribeUrl: string;
  tracking?: RenderTracking;
  /** A test message (D117): its per-subscriber links name `testSendUUID`, not the campaign. */
  test?: boolean;
}
export interface CampaignMessage {
  subject: string;
  from: string;
  body: string;
  altBody: string | null;
  headers: Array<Record<string, string>>;
}

/** listmonk models.Subscriber FirstName/LastName: first/last space chunk over two bytes. */
export function nameChunk(name: string, last: boolean): string {
  const chunks = name.split(" ");
  if (last) {
    chunks.reverse();
  }
  return chunks.find((chunk) => Buffer.byteLength(chunk) > 2) ?? name;
}
const mode = (type: ContentType) =>
  type === "markdown" ? "markdown" : type === "plain" ? "plain" : "html";

const fields = <T>(field: "body" | "subject" | "from" | "altbody" | "header", run: () => T): T => {
  try {
    return run();
  } catch {
    throw new CampaignSourceError(field);
  }
};
/** One compiled campaign; render it for many subscribers. Throws on invalid source. */
export function compileCampaign(renderer: TemplateRenderer, c: MessageCampaign) {
  const layout = c.templateBody && c.content_type !== "visual" ? c.templateBody : undefined;
  fields("subject", () => renderer.compile({ body: "", subject: c.subject, mode: "plain" }));
  const main = fields("body", () => {
    const request: Omit<RenderRequest, "data"> = {
      body: c.body,
      subject: c.subject,
      mode: mode(c.content_type),
    };
    if (layout !== undefined) {
      request.layout = layout;
    }
    return renderer.compile(request);
  });
  const text = (field: "from" | "altbody" | "header", value: string) =>
    hasTemplate(value)
      ? fields(field, () => renderer.compile({ body: value, mode: "plain" }))
      : null;
  const from = text("from", c.from_email);
  const alt = c.content_type !== "plain" && c.altbody !== null ? text("altbody", c.altbody) : null;
  const headers = c.headers.map((set) =>
    Object.fromEntries(Object.entries(set).map(([k, v]) => [k, text("header", v)])),
  );
  return {
    /** Every part of the message shares one budget; the caller may read its usage. */
    render(
      sub: CampaignSubscriber,
      links: MessageLinks,
      budget = createMessageBudget(),
    ): CampaignMessage {
      const root = links.rootUrl.replace(/\/+$/, "");
      const data = JSON.stringify({
        subscriber: {
          uuid: sub.uuid,
          email: sub.email,
          name: sub.name,
          first_name: nameChunk(sub.name, false),
          last_name: nameChunk(sub.name, true),
          attribs: sub.attribs,
          external_id: sub.external_id,
        },
        campaign: { uuid: c.uuid, name: c.name, subject: c.subject, attribs: c.attribs },
        unsubscribe_url: links.unsubscribeUrl,
        manage_url: links.unsubscribeUrl ? `${links.unsubscribeUrl}?manage=true` : "",
        optin_url: links.test
          ? `${root}/subscription/optin/${testSendUUID}`
          : `${root}/subscription/optin/${sub.uuid}`,
        message_url: `${root}/campaign/${links.test ? testSendUUID : c.uuid}/${sub.uuid}`,
        archive_url: `${root}/archive`,
      });
      const out = main.renderSync(data, links.tracking, budget);
      const plain = (tpl: ReturnType<TemplateRenderer["compile"]> | null, raw: string) =>
        tpl ? tpl.renderSync(data, undefined, budget).body : raw;
      return {
        subject: out.subject,
        from: plain(from, c.from_email),
        body: out.body,
        altBody: c.content_type !== "plain" && c.altbody !== null ? plain(alt, c.altbody) : null,
        headers: c.headers.map((set, i) =>
          Object.fromEntries(
            Object.entries(set).map(([k, v]) => [
              k,
              // Rendered values must stay single header lines.
              plain(headers[i]![k] ?? null, v).replaceAll(/[\r\n\0]+/g, " "),
            ]),
          ),
        ),
      };
    },
  };
}
/** compileArchiveCampaigns: `archive_meta` is the sample subscriber. */
const text = (value: unknown) => (typeof value === "string" ? value : "");
export function archiveSubscriber(meta: Record<string, unknown>): CampaignSubscriber {
  return {
    uuid: text(meta.uuid),
    email: text(meta.email),
    name: text(meta.name),
    attribs:
      meta.attribs && typeof meta.attribs === "object" && !Array.isArray(meta.attribs)
        ? (meta.attribs as Record<string, unknown>)
        : {},
    external_id: "",
  };
}
export class CampaignSourceError extends Error {
  constructor(readonly field: "body" | "subject" | "from" | "altbody" | "header") {
    super(field);
  }
}
