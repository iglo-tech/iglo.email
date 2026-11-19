// D110: a Liquid render is bounded by the deterministic D54 budgets, never by the wall clock. The clock
// is stubbed here so that every reading is 600 ms later than the last: a render that reads it a
// few times must still complete, as it does on a host whose CPU is starved for a second.
import { afterEach, expect, spyOn, test } from "bun:test";
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";
import { createRenderer } from "@/templates/renderer";

let clockSpy: { mockRestore(): void } | undefined;
afterEach(() => {
  clockSpy?.mockRestore();
  clockSpy = undefined;
});

test("a render that reads the clock several times late still completes", () => {
  const renderer = createRenderer(createRealClock(), createTranslation());
  const compiled = renderer.compile({
    body: "{% for i in (1..3) %}{{ i }}{% endfor %}",
    mode: "plain",
  });
  const real = performance.now.bind(performance);
  let offset = 0;
  clockSpy = spyOn(performance, "now").mockImplementation(() => {
    offset += 600;
    return real() + offset;
  });
  expect(compiled.renderSync("{}").body).toBe("123");
});
