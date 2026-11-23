// `template_reference` lists exactly the filters and tags the renderer accepts (B135, D23). The test
// asks the renderer, through its save-time parse, which filter names it accepts, and compares that
// with the Filters row of the reference. Its universe is every LiquidJS built-in filter plus the
// documented names, so a built-in that is not documented is refused here, and a documented name
// that the renderer does not accept fails here.
import { expect, test } from "bun:test";
import { Liquid } from "liquidjs";
import { TEMPLATE_REFERENCE } from "@/mcp/reference";
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";
import { createRenderer, registeredFilters } from "@/templates/renderer";

const filterRow = TEMPLATE_REFERENCE.split("\n").find((line) => line.startsWith("| Filters |"));

/** The names in the Filters row: the backticked names before the row's first `;`. */
function documentedFilters(): Array<string> {
  const listed = (filterRow ?? "").split("|")[2]?.split(";")[0] ?? "";
  return [...listed.matchAll(/`([a-z_]+)`/g)].map((match) => match[1] ?? "").sort();
}

test("the Filters row names exactly the filters the renderer accepts", () => {
  const renderer = createRenderer(createRealClock(), createTranslation());
  const documented = documentedFilters();
  const builtins = Object.keys(new Liquid().filters);
  // The universe must really contain LiquidJS's built-ins, or the refusals below prove nothing.
  expect(builtins).toContain("first");
  expect(builtins).toContain("escape");
  const universe = [...new Set([...builtins, ...documented])];
  const accepted = universe.filter((name) => {
    try {
      renderer.validate(`{{ value | ${name} }}`, "", false);
      return true;
    } catch {
      return false;
    }
  });
  expect(documented.length).toBeGreaterThan(0);
  expect(accepted.sort()).toEqual(documented);
  expect([...registeredFilters].sort()).toEqual(documented);
});
