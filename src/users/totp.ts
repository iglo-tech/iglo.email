// TOTP parameters adapted from github.com/pquerna/otp v1.5.0 and listmonk cmd/auth.go at 6fcd95f.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newSecret(): string {
  const bytes = randomBytes(20);
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  return (bits.match(/.{5}/g) ?? []).map((part) => alphabet[parseInt(part, 2)]).join("");
}
function decode(secret: string): Buffer | null {
  const clean = secret.toUpperCase().replace(/=+$/, "");
  if (
    !clean ||
    !/^[A-Z2-7]+$/.test(clean) ||
    clean.length > 256 ||
    [1, 3, 6].includes(clean.length % 8)
  )
    return null;
  let bits = "";
  for (const char of clean) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = (bits.match(/.{8}/g) ?? []).map((part) => parseInt(part, 2));
  return bytes.length ? Buffer.from(bytes) : null;
}
export function verifyTOTP(secret: string, code: string, now: Date): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const key = decode(secret);
  if (!key) return false;
  const counter = Math.floor(now.getTime() / 30_000);
  for (const offset of [0, 1, -1]) {
    if (counter + offset < 0) continue;
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(counter + offset));
    const mac = createHmac("sha1", key).update(buffer).digest();
    const index = mac[19]! & 15;
    const value = String((mac.readUInt32BE(index) & 0x7fffffff) % 1_000_000).padStart(6, "0");
    if (timingSafeEqual(Buffer.from(value), Buffer.from(code))) return true;
  }
  return false;
}
