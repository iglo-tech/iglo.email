// B105 (D112), updated by B106 (D113): realistic Markdown newsletters render at every size up to 64 KiB,
// Markdown whose output would exceed the 1 MiB output limit is refused by the output bound (here the output
// comes from a Liquid loop, since a body is at most 64 KiB), and pathological block shapes render within a
// second: the parser is linear, so no work budget applies. Measured through the production render path.
import { expect, test } from "bun:test";
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";
import { createRenderer } from "@/templates/renderer";
import { newsletter } from "@/test/templates/markdown-newsletter";

const renderer = () => createRenderer(createRealClock(), createTranslation());

test.each([4, 16, 64])("a %i KiB newsletter renders as Markdown", async (kib) => {
  const { source, last } = newsletter(kib);
  const started = performance.now();
  const { body } = await renderer().render({ body: source, data: "{}", mode: "markdown" });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(body).toContain("<h2>Story 1: a headline");
  expect(body).toContain(`<h2>Story ${last}: a headline`);
});

// B105 r2 (D112): the Markdown source after Liquid expansion is capped at 128 KiB. The check runs before
// the parser sees the source, so an expansion above the cap is refused at once, with the same message on
// preview, test send and send.
test("a Markdown source just over 128 KiB after expansion is refused before it is parsed", async () => {
  const body = "x\n{% for i in (1..129) %}" + "a".repeat(1024) + "{% endfor %}";
  const started = performance.now();
  await expect(renderer().render({ body, data: "{}", mode: "markdown" })).rejects.toThrow(
    "Markdown is larger than 128 KiB after template expansion",
  );
  expect(performance.now() - started).toBeLessThan(1000);
});

test("a Markdown source of exactly 128 KiB after expansion is not refused by the size bound", async () => {
  const body = "{% for i in (1..128) %}" + "a".repeat(1024) + "{% endfor %}";
  const { body: html } = await renderer().render({ body, data: "{}", mode: "markdown" });
  expect(html).toContain("<p>" + "a".repeat(1024));
});

// B106 (D113): the block shape that B105 refused by the work budget renders: each `|` line is a heading.
test("a 64 KiB block shape renders within a second", async () => {
  const body = "|\n-\n".repeat(16 * 1024);
  const started = performance.now();
  const { body: html } = await renderer().render({ body, data: "{}", mode: "markdown" });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(html).toContain("<h2>|</h2>");
});
