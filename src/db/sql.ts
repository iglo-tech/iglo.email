// Mask quoted literals/identifiers and comments while preserving character positions.
// This is only used for validation, never to rewrite SQL that SQLite executes.
export function maskSql(sql: string): string {
  let state: "normal" | "single" | "double" | "backtick" | "bracket" | "line" | "block" = "normal";
  let masked = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (state === "normal") {
      if (ch === "-" && next === "-") {
        state = "line";
        masked += "  ";
        i++;
      } else if (ch === "/" && next === "*") {
        state = "block";
        masked += "  ";
        i++;
      } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
        state = ch === "'" ? "single" : ch === '"' ? "double" : ch === "`" ? "backtick" : "bracket";
        masked += " ";
      } else masked += ch;
    } else if (state === "line") {
      if (ch === "\n") {
        state = "normal";
        masked += "\n";
      } else masked += " ";
    } else if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "normal";
        masked += "  ";
        i++;
      } else masked += ch === "\n" ? "\n" : " ";
    } else {
      const end =
        state === "single" ? "'" : state === "double" ? '"' : state === "backtick" ? "`" : "]";
      if (ch === end && next === end && state !== "bracket") {
        masked += "  ";
        i++;
      } else if (ch === end) {
        state = "normal";
        masked += " ";
      } else masked += ch === "\n" ? "\n" : " ";
    }
  }
  return masked;
}
