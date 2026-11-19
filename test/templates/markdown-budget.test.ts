// B105 (D112): realistic Markdown newsletters render at every size up to 256 KiB, a campaign body
// whose output would exceed the 1 MiB output limit is refused by the output bound, and pathological
// block shapes are refused by the Markdown work budget within a second. Measured through the
// renderer's campaign path (compile with `campaign: true`, as previews, test sends and sends use)
// and the template path (render), whose source limit stays at 64 KiB (D54).
import { expect, test } from "bun:test";
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";
import { createRenderer } from "@/templates/renderer";
import { newsletter } from "@/test/templates/markdown-newsletter";

const renderer = () => createRenderer(createRealClock(), createTranslation());

test.each([4, 16, 64, 256])("a %i KiB newsletter renders as a campaign body", async (kib) => {
  const { source, last } = newsletter(kib);
  const started = performance.now();
  const compiled = renderer().compile({ body: source, mode: "markdown", campaign: true });
  const { body } = compiled.renderSync("{}");
  expect(performance.now() - started).toBeLessThan(1000);
  expect(body).toContain("<h2>Story 1: a headline");
  expect(body).toContain(`<h2>Story ${last}: a headline`);
});

test("a campaign body whose Markdown output would pass the 1 MiB output limit is refused", async () => {
  const body = '"'.repeat(200 * 1024);
  const compiled = renderer().compile({ body, mode: "markdown", campaign: true });
  expect(() => compiled.renderSync("{}")).toThrow("Markdown output limit");
});

test("a 64 KiB block shape is refused by the work budget within a second", async () => {
  const body = "|\n-\n".repeat(16 * 1024);
  const compiled = renderer().compile({ body, mode: "markdown" });
  const started = performance.now();
  expect(() => compiled.renderSync("{}")).toThrow("Work limit");
  expect(performance.now() - started).toBeLessThan(1000);
});
