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
  // Decode syntax before charset conversion, as mime.WordDecoder does. Invalid
  // encoded words remain literal; only an unsupported charset is fatal.
  const decodeWord = (word: string): { encoded: boolean; content: string; error: boolean } => {
    const match = /^=\?([^?]+)\?([bBqQ])\?([^?]*)\?=$/.exec(word);
    if (!match) return { encoded: false, content: word, error: false };
    const text = match[3]!;
    let bytes: Uint8Array;
    if (match[2]!.toLowerCase() === "b") {
      const encoded = text.replace(/[\r\n]/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
        return { encoded: false, content: word, error: false };
      bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    } else {
      const values: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (c === "=") {
          const hex = text.slice(i + 1, i + 3);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) return { encoded: false, content: word, error: false };
          values.push(parseInt(hex, 16));
          i += 2;
        } else if (c === "_") values.push(32);
        else if ((c >= " " && c <= "~") || c === "\r" || c === "\n" || c === "\t")
          values.push(c.charCodeAt(0));
        else return { encoded: false, content: word, error: false };
      }
      bytes = Uint8Array.from(values);
    }
    return {
      encoded: true,
      content:
        match[1]!.toLowerCase() === "iso-8859-1"
          ? Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")
          : match[1]!.toLowerCase() === "us-ascii"
            ? Array.from(bytes, (byte) => String.fromCharCode(byte < 128 ? byte : 0xfffd)).join("")
            : new TextDecoder().decode(bytes),
      error: !["utf-8", "iso-8859-1", "us-ascii"].includes(match[1]!.toLowerCase()),
    };
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
    let content = "";
    let depth = 1;
    while (pos < input.length && depth) {
      let c = input[pos++]!;
      if (c === "\\" && pos < input.length) c = input[pos++]!;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      if (depth) content += c;
    }
    return (
      depth === 0 && (!display || content.split(/[ \t]+/).every((word) => !decodeWord(word).error))
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
      const ip = literal.startsWith("IPv6:") ? literal.slice(5) : literal;
      const kind = ip.includes("%") ? 0 : isIP(ip);
      // To4 also recognizes IPv4-mapped IPv6, including hexadecimal spelling.
      const mapped = kind === 6 && new URL(`http://[${ip}]`).hostname.startsWith("[::ffff:");
      const valid = literal.startsWith("IPv6:") ? kind !== 0 : kind === 4 || mapped;
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
    let encodedContent = "";
    if (input[pos] !== "<") {
      while (true) {
        if (words && !cfws()) return -1;
        space();
        const before = pos;
        const isQuoted = input[pos] === '"';
        const ok = isQuoted ? quoted(true) : atom(true);
        if (!ok) {
          pos = before;
          break;
        }
        const decoded = isQuoted
          ? { encoded: false, content: "", error: false }
          : decodeWord(input.slice(before, pos));
        if (decoded.error) {
          if (!words && !encodedContent) return -1;
          break;
        }
        if (decoded.encoded) encodedContent += decoded.content;
        else {
          if (encodedContent) words++;
          encodedContent = "";
          words++;
        }
      }
      if (!words && !encodedContent) return -1;
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
