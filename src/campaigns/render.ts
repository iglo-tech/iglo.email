// Campaign message composition adapted from listmonk models/campaigns.go (CompileTemplate),
// internal/manager/message.go (render) and manager.go (TemplateFuncs, message headers) at
// 6fcd95f, on the M1.8 Liquid renderer (docs/design/06-templates.md).
import type { ContentType, WritableCampaign } from "@/campaigns/store";
import { hasTemplate } from "@/campaigns/input";
import {
  createMessageBudget,
  type MessageBudget,
  type RenderTracking,
  type TemplateRenderer,
} from "@/templates/renderer";

export const dummyUUID = "00000000-0000-0000-0000-000000000000";
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
  unsubscribeUrl: string;
  tracking?: RenderTracking;
}
export interface CampaignMessage {
  subject: string;
  from: string;
  body: string;
  altBody: string | null;
  headers: Record<string, string>[];
}

/** listmonk models.Subscriber FirstName/LastName: first/last space chunk over two bytes. */
function nameChunk(name: string, last: boolean): string {
  const chunks = name.split(" ");
  if (last) chunks.reverse();
  return chunks.find((chunk) => Buffer.byteLength(chunk) > 2) ?? name;
}
const mode = (type: ContentType) =>
  type === "markdown" ? "markdown" : type === "plain" ? "plain" : "html";

/** One compiled campaign; render it for many subscribers. Throws on invalid source. */
export function compileCampaign(renderer: TemplateRenderer, c: MessageCampaign) {
  const layout = c.templateBody && c.content_type !== "visual" ? c.templateBody : undefined;
  const fields = (
    field: "body" | "subject" | "from" | "altbody" | "header",
    run: () => unknown,
  ) => {
    try {
      return run();
    } catch {
      throw new CampaignSourceError(field);
    }
  };
  fields("subject", () => renderer.compile({ body: "", subject: c.subject, mode: "plain" }));
  const main = fields("body", () =>
    renderer.compile({
      body: c.body,
      subject: c.subject,
      mode: mode(c.content_type),
      ...(layout === undefined ? {} : { layout }),
    }),
  ) as ReturnType<TemplateRenderer["compile"]>;
  const text = (field: "from" | "altbody" | "header", value: string) =>
    hasTemplate(value)
      ? (fields(field, () => renderer.compile({ body: value, mode: "plain" })) as ReturnType<
          TemplateRenderer["compile"]
        >)
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
        // Preferences, opt-in, view-in-browser and archive pages are later public pages.
        manage_url: "",
        optin_url: "",
        message_url: "",
        archive_url: "",
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
              plain(headers[i]![k] ?? null, v).replace(/[\r\n\0]+/g, " "),
            ]),
          ),
        ),
      };
    },
  };
}
export class CampaignSourceError extends Error {
  constructor(readonly field: "body" | "subject" | "from" | "altbody" | "header") {
    super(field);
  }
}
