// Ascending order for Array#sort. Without a comparator, Array#sort orders numbers as text ("10" before "9"),
// so tests that sort ids pass this instead. Numbers compare as numbers; strings, and arrays by their text (the
// order Array#sort uses by default), compare as text. Undefined, NaN, and a number paired with text are a bug in the
// test, so they throw rather than compare as equal. Array#sort never passes undefined to a comparator, so the
// undefined throw only fires on direct calls.
export type Sortable = number | string | undefined | Array<unknown>;
export function ascending(a: Sortable, b: Sortable): number {
  if (a === undefined || b === undefined) {
    throw new Error("ascending was given undefined");
  }
  if (typeof a === "number" || typeof b === "number") {
    if (typeof a !== "number" || typeof b !== "number") {
      throw new Error("ascending does not compare a number with text");
    }
    if (Number.isNaN(a) || Number.isNaN(b)) {
      throw new Error("ascending was given NaN");
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
