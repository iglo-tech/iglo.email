// B104 measurement helper (not a CI test). Times the Markdown stage through the production renderer.
//   bun test/templates/measure-markdown.ts                      each family at 1..64 KiB, one child per size
//   bun test/templates/measure-markdown.ts --one <family> <KiB>  one case (used by the family run)
//   bun test/templates/measure-markdown.ts --enum <KiB> <length> every repeating unit of up to <length>
//                                                                characters over ENUM_ALPHABET; prints units over 100 ms
//   bun test/templates/measure-markdown.ts --normal <KiB> <runs> median render time of an ordinary campaign body
import { createRealClock } from "@/clock";
import { createTranslation } from "@/i18n/i18n";
import { createRenderer } from "@/templates/renderer";

/** Each family repeats its unit until the source reaches the requested size. */
export const families: Record<string, string> = {
  "link-empty": "[](",
  "link-open": "[x](",
  "link-href": "[x](y",
  "link-title": '[x](y "',
  "link-title-single": "[x](y '",
  "link-angle": "[x](<",
  "link-spaced": "[x]( ",
  "link-glued-quote": '[x](y"',
  "link-glued-paren": "[x](y(",
  "image-empty": "![](",
  "bracket-open": "[",
  "bracket-nested": "[a [b ",
  "bracket-close": "](",
  "reflink-open": "[x][",
  "reflink-empty": "[x][]",
  "reflink-defined": "[x][r]",
  "reflink-def": "[r]: /u\n",
  "emphasis-star": "*",
  "emphasis-under": "_",
  "emphasis-pairs": "*a ",
  "emphasis-under-pairs": "_a ",
  "strong-open": "**a ",
  backtick: "`",
  "backtick-run": "`a ",
  "autolink-open": "<",
  "autolink-tag": "<a ",
  "autolink-url": "<http://x ",
  "autolink-mail": "<a@b ",
  "html-comment": "<!-- ",
  "html-tag": "<span ",
  escape: "\\[",
  "paren-open": "(",
  "link-valid": "[a](b) ",
  "table-row": "|a|\n",
  blockquote: "> [",
  "list-link": "- [x](",
};

export const sizesKiB = [1, 2, 4, 8, 16, 32, 64];
const TIMEOUT_MS = 8_000;

export function source(family: string, kib: number): string {
  const unit = families[family];
  if (unit === undefined) throw new Error(`unknown family ${family}`);
  return unit.repeat(Math.ceil((kib * 1024) / unit.length)).slice(0, kib * 1024);
}

const renderer = () => createRenderer(createRealClock(), createTranslation());

/** Renders one body; a refusal is an outcome, and only its time is measured. */
async function timed(body: string, mode: "markdown" | "plain" = "markdown") {
  const started = performance.now();
  let status = "200";
  try {
    await renderer().render({ body, data: "{}", mode });
  } catch (error) {
    status = `error ${(error as Error).message}`;
  }
  return `${(performance.now() - started).toFixed(1)} ms ${status}`;
}

const mode = Bun.argv[2];
if (mode === "--one") {
  console.log(await timed(source(Bun.argv[3]!, Number(Bun.argv[4]))));
} else if (mode === "--enum") {
  const kib = Number(Bun.argv[3]);
  const maxLength = Number(Bun.argv[4]);
  const alphabet = process.env.ENUM_ALPHABET ?? "[]()!`*_<>\"'~|:\\ \n&#-.@w";
  const units: string[] = [];
  const grow = (prefix: string) => {
    if (prefix.length > 0) units.push(prefix);
    if (prefix.length === maxLength) return;
    for (const c of alphabet) grow(prefix + c);
  };
  grow("");
  let slowest = 0;
  for (const unit of units) {
    const body = unit.repeat(Math.ceil((kib * 1024) / unit.length)).slice(0, kib * 1024);
    const started = performance.now();
    await timed(body);
    const ms = performance.now() - started;
    slowest = Math.max(slowest, ms);
    if (ms > 100) console.log(`${JSON.stringify(unit)} ${kib} KiB ${ms.toFixed(0)} ms`);
  }
  console.log(`units ${units.length} at ${kib} KiB, slowest ${slowest.toFixed(1)} ms`);
} else if (mode === "--normal") {
  // An ordinary newsletter-sized campaign body; the median of repeated renders.
  const kib = Number(Bun.argv[3]);
  const runs = Number(Bun.argv[4]);
  const section =
    '## Section title\n\nSome **bold** words, *emphasis*, and a [link](https://example.com/read?ref=news&id=7 "Read more").\n\n' +
    "- first point with [a source](https://example.com/source-a)\n- second point\n\n";
  const body = section.repeat(Math.ceil((kib * 1024) / section.length)).slice(0, kib * 1024);
  const samples: number[] = [];
  let outcome = "200";
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    try {
      await renderer().render({ body, data: "{}", mode: "markdown" });
    } catch (error) {
      outcome = `error ${(error as Error).message}`;
    }
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  console.log(
    `normal ${kib} KiB (${outcome}), ${runs} runs: median ${samples[Math.floor(runs / 2)]!.toFixed(2)} ms, min ${samples[0]!.toFixed(2)} ms`,
  );
} else if (mode === undefined || mode === "") {
  for (const family of Object.keys(families)) {
    const row: string[] = [];
    for (const kib of sizesKiB) {
      const child = Bun.spawn([process.execPath, import.meta.path, "--one", family, String(kib)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
      const out = await new Response(child.stdout).text();
      await child.exited;
      clearTimeout(timer);
      if (child.signalCode !== null || child.exitCode !== 0) {
        row.push(`${kib} KiB > ${TIMEOUT_MS / 1000} s`);
        break;
      }
      row.push(`${kib} KiB ${out.trim()}`);
    }
    console.log(`${family.padEnd(22)} ${row.join(" | ")}`);
  }
} else {
  throw new Error(`unknown mode ${mode}`);
}
