// Content format conversion adapted from listmonk models/campaigns.go (ConvertContent) at
// 6fcd95f, with the local Markdown renderer (06-templates.md, D113) instead of goldmark.
import { must } from "@/invariant";
import { createMarkdownBudget, renderMarkdown } from "@/templates/markdown";

const LIMIT = 4 * 1024 * 1024;
const liquid = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g;

/** Markdown to HTML/richtext; other pairs are unsupported, as upstream. */
export function convertContent(body: string, from: string, to: string): string | null {
  if (from !== "markdown" || (to !== "html" && to !== "richtext")) {
    return null;
  }
  // Liquid expressions pass through unchanged: Markdown escaping would break their quotes.
  const saved: Array<string> = [];
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const source = body.replaceAll(liquid, (match) => `iglo${nonce}x${saved.push(match) - 1}x`);
  let bytes = 0;
  const budget = createMarkdownBudget((n) => {
    if ((bytes += n) > LIMIT) {
      throw new Error("Markdown limit");
    }
  });
  const html = renderMarkdown(source, budget);
  return html.replaceAll(new RegExp(`iglo${nonce}x(\\d+)x`, "g"), (_, i: string) =>
    must(saved[Number(i)], "saved Liquid expression"),
  );
}
