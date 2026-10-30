// Default opt-in campaign body adapted from listmonk cmd/campaigns.go
// (makeOptinCampaignMessage) and static/email-templates/subscriber-optin-campaign.html at
// 6fcd95f. The stored body is Liquid: {{ optin_url }} is filled per subscriber.
import type { Translation } from "@/i18n/i18n";

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Liquid has no raw-text tag for `{{`; list names are emitted inside {% raw %}. */
const literal = (value: string) =>
  `{% raw %}${escape(value).replaceAll("{% endraw %}", "")}{% endraw %}`;

export function optinBody(
  t: Translation,
  lists: { uuid: string; name: string; type: string }[],
): string {
  const query = new URLSearchParams(lists.map((l) => ["l", l.uuid])).toString();
  const items = lists
    .map((l) =>
      l.type === "public"
        ? `            <li>${literal(l.name)}</li>`
        : `            <li>${escape(t.T("public.subPrivateList"))}</li>`,
    )
    .join("\n");
  return `

<p>${escape(t.T("email.optin.confirmSubWelcome"))} {{ subscriber.first_name }}</p>
<p>${escape(t.T("public.confirmSubInfo"))}</p>
<ul>
${items}
</ul>
<p>
    <a class="button" href="{{ optin_url }}?${escape(query)}">${escape(t.T("globals.buttons.confirmSubscription"))}</a>
</p>
`;
}
