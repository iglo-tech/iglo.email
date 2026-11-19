// B105 (D112), review of e6fbe3d: a long run of a block marker is a fence or rule candidate for marked's
// regexes. Each run is tested at the end of a paragraph, a list item, a blockquote and a table row, with
// and without a newline after it, at the full 64 KiB source limit. Every case must render or be refused
// by a Markdown budget within a second; a quadratic regex fails the bound.
import { expect, test } from "bun:test";
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";
import { createRenderer } from "@/templates/renderer";

const renderer = () => createRenderer(createRealClock(), createTranslation());
const LIMIT = 64 * 1024;

const markers: [string, string][] = [
  ["backtick", "`"],
  ["tilde", "~"],
  ["dash", "-"],
  ["star", "*"],
  ["underscore", "_"],
  ["equals", "="],
  ["hash", "#"],
  ["gt", ">"],
  ["pipe", "|"],
  ["plus", "+"],
  ["digit", "1"],
  ["ordered dot", "1."],
  ["ordered paren", "1)"],
];
const contexts: [string, string][] = [
  ["paragraph", "x\n"],
  ["list item", "- a\n- "],
  ["blockquote", "> a\n> "],
  ["table row", "| a | b |\n|---|---|\n| "],
];

/** The run of `marker` after `prefix`, ending with `trailing`, within the 64 KiB source limit. */
function body(prefix: string, marker: string, trailing: string): string {
  const room = LIMIT - prefix.length - trailing.length;
  return prefix + marker.repeat(Math.ceil(room / marker.length)).slice(0, room) + trailing;
}

const cases = markers.flatMap(([markerName, marker]) =>
  contexts.flatMap(([contextName, prefix]) =>
    ["", "\n"].map((trailing) => ({
      name: `${markerName} run at the end of a ${contextName}${trailing ? ", newline after" : ""}`,
      source: body(prefix, marker, trailing),
    })),
  ),
);

test.each(cases)("$name answers within a second", async ({ source }) => {
  const started = performance.now();
  let outcome = "rendered";
  try {
    await renderer().render({ body: source, data: "{}", mode: "markdown" });
  } catch (error) {
    outcome = (error as Error).message;
    // A refusal is only a budget's (D112; D54's 4 MiB emission budget, which nested quotes copy into, and
    // its nesting depth of 32); any other error fails the case.
    expect(["Work limit", "Markdown output limit", "Nesting limit", "Render limit"]).toContain(
      outcome,
    );
  }
  expect(performance.now() - started, outcome).toBeLessThan(1000);
});
