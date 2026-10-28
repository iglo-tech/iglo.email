// Address syntax adapted from Go 1.27.2 net/mail/message.go, Copyright The Go Authors.
// The complete BSD notice is embedded from assets/licenses/go-1.27.2-BSD.txt.
import { isIP } from "node:net";

export function validFromAddress(input: string): boolean {
  let pos = 0;
  const space = () => {
    while (input[pos] === " " || input[pos] === "\t") pos++;
  };
  const visible = (c: string) => !!c && ((c >= "!" && c <= "~") || c.codePointAt(0)! >= 128);
  const atext = (c: string) => visible(c) && !'()<>[]:;@\\,"'.includes(c);
  const decodable = (word: string) => {
    const match = /^=\?([^?]+)\?([bBqQ])\?([^?]*)\?=$/.exec(word);
    if (!match) return true;
    const encoded = match[3]!;
    const valid =
      match[2]!.toLowerCase() === "b"
        ? /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
        : !/=(?![0-9A-Fa-f]{2})/.test(encoded);
    return !valid || ["utf-8", "iso-8859-1", "us-ascii"].includes(match[1]!.toLowerCase());
  };
  const quoted = (allowEmpty = false) => {
    if (input[pos] !== '"') return false;
    pos++;
    let count = 0;
    while (pos < input.length) {
      const c = input[pos++]!;
      if (c === '"') return allowEmpty || count > 0;
      if (c === "\\") {
        const next = input[pos++];
        if (!next || !(visible(next) || next === " " || next === "\t")) return false;
      } else if (!(visible(c) || c === " " || c === "\t")) return false;
      count++;
    }
    return false;
  };
  const atom = (permissive: boolean) => {
    const start = pos;
    while (pos < input.length && atext(input[pos]!)) pos++;
    const value = input.slice(start, pos);
    return (
      !!value &&
      (permissive || (!value.startsWith(".") && !value.endsWith(".") && !value.includes("..")))
    );
  };
  const comment = (display = false) => {
    if (input[pos] !== "(") return false;
    pos++;
    const start = pos;
    let depth = 1;
    while (pos < input.length && depth) {
      const c = input[pos++]!;
      if (c === "\\" && pos < input.length) pos++;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    return (
      depth === 0 &&
      (!display ||
        input
          .slice(start, pos - 1)
          .split(/[ \t]+/)
          .every(decodable))
    );
  };
  const cfws = () => {
    space();
    while (input[pos] === "(") {
      if (!comment()) return false;
      space();
    }
    return true;
  };
  const spec = () => {
    const start = pos;
    space();
    if (!(input[pos] === '"' ? quoted() : atom(false)) || input[pos++] !== "@") {
      pos = start;
      return false;
    }
    space();
    if (input[pos] === "[") {
      const end = input.indexOf("]", pos + 1);
      if (end < 0) {
        pos = start;
        return false;
      }
      const literal = input.slice(pos + 1, end);
      const valid = literal.startsWith("IPv6:")
        ? isIP(literal.slice(5)) !== 0
        : isIP(literal) === 4;
      if (!valid) {
        pos = start;
        return false;
      }
      pos = end + 1;
    } else if (!atom(false)) {
      pos = start;
      return false;
    }
    return true;
  };
  const address = (group: boolean): number => {
    space();
    if (spec()) {
      space();
      if (input[pos] === "(" && !comment(true)) return -1;
      return 1;
    }
    let words = 0;
    if (input[pos] !== "<") {
      while (true) {
        if (words && !cfws()) return -1;
        space();
        const before = pos;
        const ok = input[pos] === '"' ? quoted(true) : atom(true);
        if (!ok) {
          pos = before;
          break;
        }
        if (input[before] !== '"' && !decodable(input.slice(before, pos))) return -1;
        words++;
      }
      if (!words) return -1;
    }
    space();
    if (group && input[pos] === ":") {
      pos++;
      space();
      if (input[pos] === ";") {
        pos++;
        return cfws() ? 0 : -1;
      }
      let count = 0;
      while (true) {
        const n = address(false);
        if (n < 0 || !cfws()) return -1;
        count += n;
        if (input[pos] === ";") {
          pos++;
          return cfws() ? count : -1;
        }
        if (input[pos++] !== ",") return -1;
      }
    }
    if (input[pos++] !== "<" || !spec() || input[pos++] !== ">") return -1;
    return 1;
  };
  const count = address(true);
  return count === 1 && cfws() && pos === input.length;
}
