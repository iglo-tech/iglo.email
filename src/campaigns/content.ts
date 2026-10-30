// Content format conversion adapted from listmonk models/campaigns.go (ConvertContent) at
// 6fcd95f, with the local marked renderer (06-templates.md) instead of goldmark.
import { renderMarkdown } from "@/templates/markdown";

const LIMIT = 4 * 1024 * 1024;
const WORK = 100_000;
const liquid = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g;

/** Markdown to HTML/richtext; other pairs are unsupported, as upstream. */
export function convertContent(body: string, from: string, to: string): string | null {
  if (from !== "markdown" || (to !== "html" && to !== "richtext")) return null;
  // Liquid expressions pass through unchanged: Markdown escaping would break their quotes.
  const saved: string[] = [];
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const source = body.replace(liquid, (match) => `iglo${nonce}x${saved.push(match) - 1}x`);
  const budget = {
    bytes: 0,
    work: 0,
    depth: 0,
    charge(n: number) {
      if ((this.bytes += n) > LIMIT) throw new Error("Markdown limit");
    },
    step(n = 1) {
      if ((this.work += n) > WORK) throw new Error("Work limit");
    },
  };
  const html = renderMarkdown(source, budget);
  return html.replace(new RegExp(`iglo${nonce}x(\\d+)x`, "g"), (_, i: string) => saved[Number(i)]!);
}
