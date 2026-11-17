// Native client-address policy (D60). listmonk's Echo context reads no proxy configuration, and
// D26 forbids trusting forwarded headers blindly. The untrusted-forwarding attention line is D107.
import { BlockList, isIP } from "node:net";
import type { ErrorLogger } from "@/app";
import type { RequestContext } from "@/server/context";

const family = (address: string) => (isIP(address) === 6 ? "ipv6" : "ipv4");
const normalize = (address: string) =>
  (/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1] ?? address).toLowerCase();

/** An IP or CIDR entry of `security.trusted_proxies`. A zero prefix would trust every peer. */
export function parseProxy(value: string): { address: string; prefix: number } | undefined {
  const [address = "", prefix, ...rest] = value.split("/");
  const size = isIP(address) === 6 ? 128 : isIP(address) === 4 ? 32 : 0;
  if (!size || rest.length) return undefined;
  if (prefix === undefined) return { address, prefix: size };
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > size) return undefined;
  return { address, prefix: Number(prefix) };
}

/**
 * The address limits and stored opt-in IPs use. `X-Forwarded-For` counts only from a trusted
 * peer: the walk goes from the right past trusted hops to the first untrusted one, or to the
 * nearest valid hop when the chain ends or holds something that is not an address.
 *
 * A header from a peer outside the list is ignored, and the first such request is reported to
 * `logger` (D107), once until the list changes. The report names the peer, never the header.
 */
export function createClientAddress(trusted: () => string[], logger?: ErrorLogger) {
  let key: string | undefined;
  let proxies = new BlockList();
  let reported = false;
  const isTrusted = (address: string) => proxies.check(address, family(address));
  return (context: Pick<RequestContext, "peerAddress" | "request">): string => {
    const list = trusted();
    const current = list.join();
    if (current !== key) {
      key = current;
      reported = false;
      proxies = new BlockList();
      for (const entry of list) {
        const proxy = parseProxy(entry);
        if (proxy) proxies.addSubnet(proxy.address, proxy.prefix, family(proxy.address));
      }
    }
    let client = normalize(context.peerAddress);
    if (!isIP(client) || !isTrusted(client)) {
      if (!reported && logger && context.request.headers.has("x-forwarded-for")) {
        reported = true;
        report(logger, client);
      }
      return client;
    }
    const hops = context.request.headers.get("x-forwarded-for")?.split(",") ?? [];
    for (const raw of hops.reverse()) {
      const hop = normalize(raw.trim());
      if (!isIP(hop)) break;
      client = hop;
      if (!isTrusted(hop)) break;
    }
    return client;
  };
}

// Logging never changes a client address (as scheduler.ts's attention lines).
function report(logger: ErrorLogger, peer: string): void {
  const message =
    `X-Forwarded-For from ${peer} was ignored: that address is not in security.trusted_proxies. ` +
    `If it is your reverse proxy, add it there (docs/operations.md, "Deploying behind a reverse proxy or PaaS").`;
  try {
    // No `safe` text: the log buffer accepts only its fixed list, and stderr keeps this line.
    logger.error(new Error(message));
  } catch {
    /* Logging never changes an address. */
  }
}
