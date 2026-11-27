// Native (15-external-sources section 2, D122, D169 amended, D170): the server-side request guard
// for a source URL. With `webhooks.block_private_addresses` on, every connection resolves the host,
// checks every address with the webhook delivery's own rule (`blockedAddress`) and connects to a
// checked address, so a second lookup cannot rebind it; the Host header and TLS name stay the
// URL's. A host named in the instance key `sources.private_hosts` (exact, case-insensitive) may
// also resolve to a private, loopback, link-local or unique-local address; every other special
// range stays refused for it, and webhook targets never use the list. With the block off, the
// request goes out as it is.
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { blockedAddress } from "@/webhooks/address";

/** The ranges a listed host may resolve to: private, loopback, link-local, unique-local. */
const privateRanges = new BlockList();
for (const [network, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv4");
}
privateRanges.addAddress("::1", "ipv6");
privateRanges.addSubnet("fe80::", 10, "ipv6");
privateRanges.addSubnet("fc00::", 7, "ipv6");

/** An IPv4-mapped IPv6 address as its IPv4 address; anything else unchanged. */
function unmapped(address: string): string {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return match?.[1] ?? address;
}

/** Whether a listed host may connect to `address` although the block refuses it. */
export function privateAddress(address: string): boolean {
  const plain = unmapped(address.split("%", 1)[0] ?? "");
  const family = isIP(plain);
  return family !== 0 && privateRanges.check(plain, family === 4 ? "ipv4" : "ipv6");
}

export interface SourceTransport {
  /** Addresses of a host name. */
  lookup?: (hostname: string) => Promise<Array<string>>;
  /** Sends one request (`fetch` by default); a test may wrap it to observe the requests. */
  fetch?: (input: URL, init: RequestInit) => Promise<Response>;
}

export interface Guard {
  /** `webhooks.block_private_addresses`, read at every connection. */
  blockPrivate: () => boolean;
  /** `sources.private_hosts`, read at every connection. */
  privateHosts: () => ReadonlyArray<string>;
}

/**
 * The refusal text for a host the private-address block refuses: a configuration problem. An
 * address literal can never be listed (`sources.private_hosts` takes host names only, D181), so it
 * is told to use a host name instead.
 */
export const refusedMessage = (host: string) =>
  isIP(host.replace(/^\[(.*)\]$/, "$1"))
    ? `The source host ${host} is refused by webhooks.block_private_addresses (D122); sources.private_hosts takes host names only, so use a host name for this address and ask an instance admin to list it there`
    : `The source host ${host} is refused by webhooks.block_private_addresses (D122); an instance admin can list it in sources.private_hosts`;

const resolveAddresses = async (hostname: string) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);

/** A connection failure that another checked address of the same host may not have. */
function unreachable(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|ConnectionRefused|Unable to connect/i.test(
    `${code} ${String(error)}`,
  );
}

/**
 * B168 (D196): the refusal text for a host that resolves to a zoned IPv6 address (`fe80::1%eth0`).
 * A WHATWG URL cannot carry a zone, so the request could not be pinned to the checked address.
 */
const zonedMessage = (host: string) =>
  `The source host ${host} resolves to an IPv6 address with a zone, which a source request cannot be pinned to; give it an address without a zone`;

/**
 * One request to `url` under the guard, or `{ refused, message }` naming the host the block
 * refuses and why. With the block on, the addresses are resolved and checked first, then tried in
 * order: an address that refuses the connection gives way to the next, all of them checked.
 * Redirects are never followed.
 */
export async function guardedFetch(
  url: URL,
  init: RequestInit,
  guard: Guard,
  transport: SourceTransport = {},
): Promise<Response | { refused: string; message: string }> {
  const send = transport.fetch ?? fetch;
  const request: RequestInit = { ...init, redirect: "manual" };
  if (!guard.blockPrivate()) {
    return send(url, request);
  }
  const hostname = url.hostname.replaceAll(/^\[|\]$/g, "");
  const literal = isIP(hostname) !== 0;
  const listed = !literal && guard.privateHosts().includes(hostname.toLowerCase());
  const addresses = literal ? [hostname] : await (transport.lookup ?? resolveAddresses)(hostname);
  const allowed = (address: string) =>
    !blockedAddress(address) || (listed && privateAddress(address));
  if (!addresses.length || !addresses.every(allowed)) {
    return { refused: url.hostname, message: refusedMessage(url.hostname) };
  }
  // B168 (D196): assigning a zoned literal to `URL.hostname` is silently ignored, which would send
  // the request to the host name with a second, unchecked lookup: refused before anything is sent.
  if (addresses.some((address) => address.includes("%"))) {
    return { refused: url.hostname, message: zonedMessage(url.hostname) };
  }
  for (const [index, address] of addresses.entries()) {
    const target = new URL(url);
    target.hostname = isIP(address) === 6 ? `[${address}]` : address;
    const headers = new Headers(init.headers);
    headers.set("Host", url.host);
    const pinned: RequestInit & { tls?: { serverName: string } } = { ...request, headers };
    if (!literal) {
      pinned.tls = { serverName: hostname };
    }
    try {
      return await send(target, pinned);
    } catch (error) {
      if (!unreachable(error) || init.signal?.aborted || index === addresses.length - 1) {
        throw error;
      }
    }
  }
  return { refused: url.hostname, message: refusedMessage(url.hostname) };
}
