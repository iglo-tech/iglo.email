// B105: a realistic Markdown newsletter of at most `kib` KiB (UTF-8 bytes), built from the block and
// span kinds an adapter sends: headings, paragraphs with emphasis and code, links, images, bullet
// lists, tables, code blocks, quotes, reference links with definitions and bare URLs. Story `last` is
// the last one included, so tests can look for "Story <last>:" in any rendering of the document.
const REFERENCES =
  '[r0]: https://example.test/r0\n[r1]: https://example.test/r1 "Title one"\n[r2]: https://example.test/r2\n[r3]: https://example.test/r3\n[r4]: https://example.test/r4\n';

function story(n: number): string {
  let text =
    `## Story ${n}: a headline about the topic number ${n}\n\n` +
    `![Chart ${n}](https://img.example.test/charts/${n}.png "Chart ${n} title")\n\n` +
    `In this story we look at **the result** of the work (see [the source](https://example.test/news/${n}?ref=digest&utm=weekly), and *more* details in \`config.${n}\`). It matters because the numbers changed & the team said so. Read more at <https://example.test/more/${n}>.\n\n` +
    `- First point with a [link ${n}](https://example.test/point/${n}) and _emphasis_ words\n- Second point, plain text with an apostrophe's and quotes "like this"\n- Third point [more][r${n % 5}]\n\n`;
  if (n % 4 === 0) {
    text += `| Metric | Value |\n|---|:-:|\n| Opens | ${n * 3} |\n| Clicks | [${n}](https://example.test/c/${n}) |\n\n`;
  }
  if (n % 5 === 0) {
    text += "```\nconst x = 1 && y < 2;\n```\n\n";
  }
  if (n % 6 === 0) {
    text += `> A quoted remark from number ${n} with [a link](https://example.test/quote/${n}).\n\n`;
  }
  text += `Closing paragraph of story ${n}. Footnote-like markers [1] and snake_case_names appear here, plus a bare https://example.test/bare/${n} URL.\n\n`;
  return text;
}

export function newsletter(kib: number): { source: string; last: number } {
  const head = "# Weekly digest\n\nHello, here is what happened this week.\n\n";
  const limit = kib * 1024 - REFERENCES.length;
  let source = head;
  let last = 0;
  for (let next = story(1); source.length + next.length <= limit; next = story(last + 1)) {
    source += next;
    last++;
  }
  return { source: source + REFERENCES, last };
}
