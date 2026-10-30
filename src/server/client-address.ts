// Native client-address policy (D60). listmonk's Echo context reads no proxy configuration, and
// D26 forbids trusting forwarded headers blindly.
import { BlockList, isIP } from "node:net";
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
 */
export function createClientAddress(trusted: () => string[]) {
  let key: string | undefined;
  let proxies = new BlockList();
  const isTrusted = (address: string) => proxies.check(address, family(address));
  return (context: Pick<RequestContext, "peerAddress" | "request">): string => {
    const list = trusted();
    const current = list.join();
    if (current !== key) {
      key = current;
      proxies = new BlockList();
      for (const entry of list) {
        const proxy = parseProxy(entry);
        if (proxy) proxies.addSubnet(proxy.address, proxy.prefix, family(proxy.address));
      }
    }
    let client = normalize(context.peerAddress);
    if (!isIP(client) || !isTrusted(client)) return client;
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
