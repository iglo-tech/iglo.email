// Bare address parsing adapted from Go 1.27.2 src/net/mail/message.go,
// and listmonk internal/utils/utils.go at 6fcd95f. Copyright 2009 The Go
// Authors. See assets/licenses/go-1.27.2-BSD.txt for the complete license.
import { isIP } from "node:net";
import { trimSpace } from "@/lists/store";
import { simpleLower } from "@/subscribers/unicode-lower";

function atom(value: string): boolean {
  if (!value || value.startsWith(".") || value.endsWith(".") || value.includes("..")) return false;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 128 && (code < 33 || code > 126 || '()<>[]:;@\\,"'.includes(char))) return false;
  }
  return true;
}

// Go net.ParseIP(...).To4() also accepts IPv4-mapped IPv6 literals.
function mappedIPv4(value: string): boolean {
  if (isIP(value) !== 6) return false;
  const [left, right] = value.split("::");
  const parse = (part: string) =>
    part
      ? part.split(":").flatMap((x) => {
          if (!x.includes(".")) return [parseInt(x, 16)];
          const bytes = x.split(".").map(Number);
          return [bytes[0]! * 256 + bytes[1]!, bytes[2]! * 256 + bytes[3]!];
        })
      : [];
  const a = parse(left ?? ""),
    b = parse(right ?? "");
  const words = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill(0), ...b];
  return words.length === 8 && words.slice(0, 5).every((x) => x === 0) && words[5] === 0xffff;
}

export function sanitizeEmail(value: string): string | undefined {
  const address = simpleLower(trimSpace(value));
  const at = address.indexOf("@");
  if (at < 0 || address.indexOf("@", at + 1) >= 0 || !atom(address.slice(0, at))) return;
  const domain = address.slice(at + 1);
  if (domain.startsWith("[")) {
    if (!domain.endsWith("]")) return;
    const literal = domain.slice(1, -1);
    if (isIP(literal) !== 4 && !mappedIPv4(literal)) return;
  } else if (!atom(domain)) return;
  return address;
}
