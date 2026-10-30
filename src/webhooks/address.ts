// Native: which resolved addresses `webhooks.block_private_addresses` refuses.
import { isIPv4, isIPv6 } from "node:net";

const octets = (address: string) => address.split(".").map(Number) as number[];
const inRange = (bytes: number[], prefix: number[], bits: number) =>
  prefix.every((value, index) => {
    const mask = Math.max(0, Math.min(8, bits - index * 8));
    const shift = 8 - mask;
    return bytes[index]! >> shift === value >> shift;
  });
/** Everything but public unicast: RFC 6890 special-purpose ranges. */
const blocked4: [number[], number][] = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];
const blocked6: [number[], number][] = [
  [[0x20, 0x01, 0x0d, 0xb8], 32],
  [[0x20, 0x01, 0x00, 0x00], 32],
];
const v4Blocked = (bytes: number[]) =>
  blocked4.some(([prefix, bits]) => inRange(bytes, prefix, bits));

/** The 16 bytes of a valid IPv6 address, zone removed. */
function bytes6(address: string): number[] {
  let text = address.split("%", 1)[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (dotted) {
    const [a, b, c, d] = octets(dotted) as [number, number, number, number];
    text = `${text.slice(0, -dotted.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const before = groups(head),
    after = groups(tail);
  const words =
    tail === undefined
      ? before
      : [...before, ...Array<string>(8 - before.length - after.length).fill("0"), ...after];
  return words.flatMap((word) => {
    const value = Number.parseInt(word, 16);
    return [value >> 8, value & 255];
  });
}

/** True unless the address is public unicast. Anything unparsable is refused. */
export function blockedAddress(address: string): boolean {
  if (isIPv4(address)) return v4Blocked(octets(address));
  if (!isIPv6(address)) return true;
  const bytes = bytes6(address);
  const zero = (end: number) => bytes.slice(0, end).every((byte) => byte === 0);
  // IPv4-compatible (::a.b.c.d), except the unspecified and loopback addresses themselves.
  if (zero(12)) return !bytes.slice(12, 15).some(Boolean) || v4Blocked(bytes.slice(12));
  // IPv4-mapped.
  if (zero(10) && bytes[10] === 255 && bytes[11] === 255) return v4Blocked(bytes.slice(12));
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) reach the embedded IPv4 address.
  if (inRange(bytes, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96))
    return v4Blocked(bytes.slice(12));
  if (inRange(bytes, [0x20, 0x02], 16)) return v4Blocked(bytes.slice(2, 6));
  // Global unicast is 2000::/3; link-local, ULA, multicast and the rest are outside it.
  if (!inRange(bytes, [0x20], 3)) return true;
  return blocked6.some(([prefix, bits]) => inRange(bytes, prefix, bits));
}
