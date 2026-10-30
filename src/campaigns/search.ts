// Campaign search case matching. Upstream (listmonk queries/campaigns.sql query-campaigns)
// compares with `ILIKE`, which lowercases both sides. So a query character matches every
// character with the same simple lowercase form: `i` matches `I` and `İ`, `ß` matches `ẞ`.
// Subscriber search uses a regex rule instead (src/subscribers/query-filter.ts).

/** The single-character lowercase form, as the reference database's lower() returns it. */
function simpleLower(char: string): string {
  const lower = char.toLowerCase();
  const points = [...lower];
  if (points.length === 1) return lower;
  // Full case mapping adds combining marks (İ → i̇); the simple mapping keeps the base letter.
  if (points.slice(1).every((point) => /\p{M}/u.test(point))) return points[0]!;
  return char;
}

let classes: Map<string, string[]> | undefined;
/** Every character grouped by its simple lowercase form. Built once on first non-ASCII use. */
function lowerClasses(): Map<string, string[]> {
  if (classes) return classes;
  classes = new Map();
  for (let code = 0; code <= 0x1ffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const char = String.fromCodePoint(code);
    const key = simpleLower(char);
    if (key === char && char.toUpperCase() === char) continue;
    const members = classes.get(key) ?? [key];
    if (!members.includes(char)) members.push(char);
    classes.set(key, members);
  }
  return classes;
}

/** A GLOB pattern that matches `search` anywhere, with ILIKE's case-insensitivity. */
export function lowercaseGlob(search: string): string {
  let pattern = "*";
  for (const char of search) {
    const members = lowerClasses().get(simpleLower(char)) ?? [char];
    if (members.length > 1) pattern += `[${members.join("")}]`;
    else pattern += "*?[".includes(char) ? `[${char}]` : char;
  }
  return `${pattern}*`;
}
