// Local test receiver for webhook deliveries; tests never call a real endpoint.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface Received {
  path: string;
  host: string | null;
  signature: string;
  text: string;
  body: any;
  at: number;
}

export function startReceiver(
  respond: (received: Received, count: number) => Response | Promise<Response> = () =>
    new Response("ok"),
) {
  const received: Received[] = [];
  const waiters = new Set<() => void>();
  let handler = respond;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      // Other processes on a shared host can probe a loopback port.
      if (request.method !== "POST") return new Response(null, { status: 404 });
      const text = await request.text();
      const entry: Received = {
        path: new URL(request.url).pathname,
        host: request.headers.get("host"),
        signature: request.headers.get("x-iglo-email-signature") ?? "",
        text,
        body: JSON.parse(text),
        at: Date.now(),
      };
      received.push(entry);
      for (const wake of waiters) wake();
      return handler(entry, received.length);
    },
  });
  return {
    port: server.port!,
    received,
    url: (path = "/hook") => `http://127.0.0.1:${server.port}${path}`,
    respond(next: typeof respond) {
      handler = next;
    },
    /** Resolve once `count` requests have arrived. */
    async waitFor(count: number) {
      const deadline = Date.now() + 10_000;
      while (received.length < count) {
        if (Date.now() > deadline)
          throw new Error(`Receiver got ${received.length} of ${count} requests`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 200);
          const wake = () => {
            clearTimeout(timer);
            waiters.delete(wake);
            resolve();
          };
          waiters.add(wake);
        });
      }
      return received;
    },
    close: () => server.stop(true),
  };
}
export type Receiver = ReturnType<typeof startReceiver>;

/** The documented receiver check: HMAC-SHA256 of `t.body` over the exact bytes received. */
export function signatureValid(received: Received, secret: string) {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(received.signature);
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(`${match[1]}.${received.text}`).digest();
  return timingSafeEqual(expected, Buffer.from(match[2]!, "hex"));
}
export const signatureTime = (received: Received) =>
  Number(/^t=(\d+),/.exec(received.signature)?.[1]);
