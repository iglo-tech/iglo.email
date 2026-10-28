// Deliberately narrow RFC 6376 relaxed/relaxed RSA-SHA256 verifier for this fixture.
// It never resolves DNS and does not attempt general mail authentication.
import { createHash, createVerify, type KeyObject } from "node:crypto";

function relaxedValue(field: string) {
  return field
    .slice(field.indexOf(":") + 1)
    .replace(/\r\n[ \t]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}
function bodyHash(body: string) {
  const lines = body
    .split("\r\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/[ \t]+/g, " "));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const canonical = `${lines.join("\r\n")}\r\n`;
  return createHash("sha256").update(canonical, "latin1").digest("base64");
}
export function verifyFixtureDkim(raw: string, publicKey: KeyObject) {
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0) return false;
  const fields = raw.slice(0, split).split(/\r\n(?=[^ \t])/);
  const dkim = fields.find((field) => /^dkim-signature:/i.test(field));
  if (!dkim) return false;
  const tags = Object.fromEntries(
    relaxedValue(dkim)
      .split(";")
      .map((part) => {
        const index = part.indexOf("=");
        return index < 0
          ? [part.trim(), ""]
          : [part.slice(0, index).trim(), part.slice(index + 1).replace(/[ \t]/g, "")];
      }),
  );
  if (
    tags.a !== "rsa-sha256" ||
    tags.c !== "relaxed/relaxed" ||
    tags.d !== "fixture.example.test" ||
    tags.s !== "m08" ||
    !tags.b ||
    !tags.bh ||
    !tags.h ||
    tags.bh !== bodyHash(raw.slice(split + 4))
  )
    return false;
  const selected: string[] = [];
  const used = new Set<number>();
  for (const name of tags.h.split(":")) {
    let index = fields.length - 1;
    while (
      index >= 0 &&
      (used.has(index) || !fields[index]!.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    )
      index--;
    if (index < 0) return false;
    used.add(index);
    selected.push(`${name.toLowerCase()}:${relaxedValue(fields[index]!)}`);
  }
  // The fixture signs one header; b= is the last tag emitted by the selected library.
  const unsignedDkim = dkim.replace(/(\bb=)[A-Za-z0-9+/=\r\n \t]+$/i, "$1");
  const canonical = `${selected.join("\r\n")}\r\ndkim-signature:${relaxedValue(unsignedDkim)}`;
  return createVerify("RSA-SHA256").update(canonical, "latin1").verify(publicKey, tags.b, "base64");
}
