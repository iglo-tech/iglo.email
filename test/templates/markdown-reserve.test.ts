// B105 (D112), updated by B106 (D113): the output bound is the memory guarantee, so it must bound the bytes
// the Markdown output writes. Over the reviewer's shapes, the constructs the first reserve missed (loose list
// items, image alternative text, task items) and a seeded random corpus, the charged bound must be at least
// the actual output. renderMarkdown charges the bound once, before the output is built, so that charge is
// the bound.
import { expect, test } from "bun:test";
import { createMarkdownBudget, renderMarkdown } from "@/templates/markdown";

/** The reserved and the actual output bytes of a render that completes, or undefined for a refusal. */
function measure(source: string): { reserved: number; actual: number } | undefined {
  const charges: Array<number> = [];
  const budget = createMarkdownBudget((bytes) => charges.push(bytes));
  try {
    const html = renderMarkdown(source, budget);
    return { reserved: charges.at(-1)!, actual: Buffer.byteLength(html) };
  } catch {
    return undefined;
  }
}

const constructs = [
  "- a\n\n  b\n\n",
  "- a\n\n  b\n\n  c\n\n",
  "1. loose one\n\n2. loose two\n\n   more text\n\n",
  "- [ ] task\n- [x] done\n- [X] upper\n",
  "- [x] checked loose\n\n  second paragraph\n\n",
  "1. [x] ordered\n2. [ ] open\n",
  '![a \\* b *c* **d** [e](f)](g "title")\n\n',
  "![\\\\ \\_ \\& \"q\" 'r' <s>](img.png)\n\n",
  "![x](y 'single')\n\n",
  "![![badge](https://b.test/x.svg)](https://b.test/)\n\n",
  "[![\\\"\\'\\&](https://i.test/a.png)](https://e.test/)\n\n",
  "| a | b |\n|:--|--:|\n| 1 | `c` |\n\n",
  '```js\nlet a = "<b>" && 1;\n```\n\n',
  "    indented code\n\n",
  "> quote *a* [b](c)\n>> nested\n\n",
  '<div class="x">raw & html</div>\n\n',
  "inline <span>html</span> & more\n\n",
  '[link](https://e.test/a?x=1&y=2 "t \\" q")\n\n',
  "<https://auto.test/a&b>\n\n",
  '[ref][r]\n\n[r]: https://r.test "ref title"\n\n',
  "~~strike~~ and ~single~\n\n",
  "## Heading with `code` and *em*\n\n",
  "Setext\n====\n\n",
  "---\n\n",
  "a  \nhard break\n\n",
  "Unicode 😀 ‘quotes’ “double” ünïcödé\n\n",
  "\\* escaped \\_ \\` backticks\n\n",
  "&amp; &copy; &#35; literal\n\n",
  "x".repeat(300) + "\n\n",
  "- item\n  continuation line\n- item 2\n\n",
  "text with \"quotes\" and 'apostrophes' <tags>\n\n",
  "![img](https://i.test/a.png)\n\n",
  "> > deep\n> > deeper\n\n",
  "| x |\n|---|\n| `|` |\n\n",
  '[a](<b c> "t")\n\n',
  "a\\\nb\n\n",
];

/** The reviewer's block shapes and the B104 families, each repeated to about 2 KiB. */
const shapes = [
  "|\n-\n",
  " |\n-\n",
  "<\n-\n",
  "`\n-\n",
  "[\n-\n",
  "_\n-\n",
  "a\n--\n",
  "--\n",
  "\n--",
  "a\n***\n",
  "w ~",
  "__+",
  "[](",
  "![](",
  '[x](y "',
  "[x][",
  String.raw`\[`,
  "*'w",
  "|a|\n",
  ">=\n",
  "1. ",
  "- > ",
  "> - ",
];

/** A seeded linear congruential generator, so the corpus is the same on every run. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function corpus(): Array<string> {
  const random = generator(20_261_119);
  const documents: Array<string> = [];
  for (let i = 0; i < 600; i++) {
    const parts: Array<string> = [];
    const count = 1 + Math.floor(random() * 12);
    for (let j = 0; j < count; j++) {
      parts.push(constructs[Math.floor(random() * constructs.length)]!);
    }
    documents.push(parts.join(random() < 0.5 ? "\n" : ""));
  }
  return documents;
}

test("the reserve bounds the output of every construct the first reserve missed", () => {
  const violations: Array<string> = [];
  for (const construct of constructs) {
    for (const repeated of [1, 8, 40]) {
      const source = construct.repeat(repeated);
      const result = measure(source);
      if (result && result.actual > result.reserved) {
        violations.push(
          `${JSON.stringify(source.slice(0, 60))} x${repeated}: ${result.actual} > ${result.reserved}`,
        );
      }
    }
  }
  expect(violations).toEqual([]);
});

test("the reserve bounds the output of the reviewer's block shapes at 2 KiB", () => {
  const violations: Array<string> = [];
  let measured = 0;
  for (const shape of shapes) {
    const source = shape.repeat(Math.ceil(2048 / shape.length)).slice(0, 2048);
    const result = measure(source);
    if (!result) {
      continue;
    }
    measured++;
    if (result.actual > result.reserved) {
      violations.push(`${JSON.stringify(shape)}: ${result.actual} > ${result.reserved}`);
    }
  }
  expect(measured).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});

test("the reserve bounds the output of a seeded random corpus", () => {
  const violations: Array<string> = [];
  let measured = 0;
  for (const source of corpus()) {
    const result = measure(source);
    if (!result) {
      continue;
    }
    measured++;
    if (result.actual > result.reserved) {
      violations.push(
        `${JSON.stringify(source.slice(0, 80))}: ${result.actual} > ${result.reserved}`,
      );
    }
  }
  expect(measured).toBeGreaterThan(500);
  expect(violations).toEqual([]);
});
