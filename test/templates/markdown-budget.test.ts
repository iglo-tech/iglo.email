// B105 (D112): realistic Markdown newsletters render at every size up to 64 KiB, Markdown whose output
// would exceed the 1 MiB output limit is refused by the output bound (here the output comes from a
// Liquid loop, since a body is at most 64 KiB), and pathological block shapes are refused by the
// Markdown work budget within a second. Measured through the production renderer's render path.
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

test("Markdown whose output would pass the 1 MiB output limit is refused", async () => {
  // 1 MiB of quotes from a Liquid loop (the loop's output is exactly the limit); each quote becomes
  // `&quot;` in the Markdown output, so the reserved output is six times larger.
  const body = "{% for i in (1..1024) %}" + '"'.repeat(1024) + "{% endfor %}";
  await expect(renderer().render({ body, data: "{}", mode: "markdown" })).rejects.toThrow(
    "Markdown output limit",
  );
});

test("a 64 KiB block shape is refused by the work budget within a second", async () => {
  const body = "|\n-\n".repeat(16 * 1024);
  const started = performance.now();
  await expect(renderer().render({ body, data: "{}", mode: "markdown" })).rejects.toThrow(
    "Work limit",
  );
  expect(performance.now() - started).toBeLessThan(1000);
});
