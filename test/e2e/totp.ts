import { createHmac } from "node:crypto";

const base32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// An RFC 6238 code computed here, independent of the server's verifier.
export function totp(secret: string, at = Date.now()): string {
  const bits = [...secret].map((c) => base32.indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((part) => parseInt(part, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const value = (mac.readUInt32BE(mac[19]! & 15) & 0x7fffffff) % 1000000;
  return String(value).padStart(6, "0");
}
