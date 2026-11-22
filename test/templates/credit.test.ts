// B129 (D127): every built-in template renders with no product credit, in its HTML and in the text
// part a mail gets from it. The campaign layouts and the sample transactional template are the
// ones the operator starts from, so their output is what a reader sees. Through the renderer, the
// boundary that every template goes through.
import { expect, test } from "bun:test";
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";
import { plainText } from "@/messaging/plain";
import { mailBrand } from "@/public/brand";
import { initialTemplates, systemTemplates } from "@/templates/builtins";
import { createMessageBudget, createRenderer } from "@/templates/renderer";

const creditWords = ["Powered by", "poweredBy", "Based on", "listmonk", "iglo.email"];
const renderer = createRenderer(createRealClock(), createTranslation());
const data = JSON.stringify({
  subscriber: { name: "Ada", first_name: "Ada", email: "ada@example.test" },
  campaign: { name: "News", subject: "News" },
  data: {},
  unsubscribe_url: "https://example.test/unsubscribe",
  message_url: "https://example.test/view",
  manage_url: "https://example.test/manage",
  archive_url: "https://example.test/archive",
  track_view: "",
  content: "<p>Body</p>",
  // The brand a template reads (B129): a logo with the name beside it, a pale accent, a web font.
  ...mailBrand({
    logoUrl: "https://brand.example.test/logo.png",
    siteName: "Brand Co",
    siteUrl: "",
    accent: "#ffeb3b",
    font: "Lora",
    header: "logo_and_name",
  }),
});

function expectNoCredit(text: string) {
  for (const word of creditWords) {
    expect(text).not.toContain(word);
  }
}

test("each built-in campaign layout and the sample transactional template render with no credit", async () => {
  for (const item of initialTemplates) {
    const budget = createMessageBudget();
    const rendered =
      item.type === "campaign"
        ? renderer.renderSync({ body: "<p>Hi</p>", layout: item.body, mode: "html", data }, budget)
        : renderer.renderSync(
            { body: item.body, subject: item.subject, mode: "html", data, transactional: true },
            budget,
          );
    expectNoCredit(rendered.body);
    expectNoCredit(await plainText(rendered.body, budget));
  }
});

test("each system mail template renders with no credit in its HTML or text part", async () => {
  for (const body of Object.values(systemTemplates)) {
    const budget = createMessageBudget();
    const rendered = renderer.renderSync({ body, mode: "html", data }, budget);
    expectNoCredit(rendered.body);
    expectNoCredit(await plainText(rendered.body, budget));
  }
});
