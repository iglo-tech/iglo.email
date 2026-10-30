// Native delivery loop (docs/design/04-sending.md#outbound-webhooks, 02-architecture.md).
// At-least-once: a row is claimed with a lease and settled after the request, outside any
// transaction, so a crash or a lost response repeats the same `id`.
import type { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ErrorLogger } from "@/app";
import type { Clock } from "@/clock";
import { writeTransaction } from "@/db/transaction";
import { startLoop } from "@/loops/loop";
import { blockedAddress } from "@/webhooks/address";
import type { ClaimedDelivery, WebhookStore } from "@/webhooks/store";
import { MAX_WEBHOOKS } from "@/webhooks/store";

/** Requests in flight per webhook. A slow receiver holds its own slots and nobody else's. */
export const WEBHOOK_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 10_000;
/** Longer than a request's whole deadline, so a live attempt never loses its row. */
const LEASE_MS = 60_000;
const POLL_MS = 1000;
const RESPONSE_BYTES = 64 * 1024;
/** A webhook's repeated failure is logged at most this often. */
const FAILURE_LOG_MS = 3_600_000;
const FAILURE_LOG_ATTEMPTS = 5;
/** Nothing was sent and the row is not this attempt's to settle. */
const CLAIM_GONE = "claim_gone";

export interface WebhookTransport {
  /** Addresses of a hostname. */
  lookup?: (hostname: string) => Promise<string[]>;
  blocked?: (address: string) => boolean;
  fetch?: typeof fetch;
}
const resolveAddresses = async (hostname: string) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);

class Refused extends Error {}

/**
 * With blocking on, every address of the host must be public and the request connects to the
 * one checked, so a second lookup cannot rebind it. The Host header and TLS name stay the
 * configured host's.
 */
async function pinned(url: URL, transport: WebhookTransport) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [hostname]
    : await (transport.lookup ?? resolveAddresses)(hostname);
  const blocked = transport.blocked ?? blockedAddress;
  if (!addresses.length || addresses.some(blocked)) throw new Refused();
  const address = addresses[0]!;
  const target = new URL(url);
  target.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return {
    url: target,
    headers: { Host: url.host },
    tls: isIP(hostname) ? {} : { tls: { serverName: hostname } },
  };
}

async function drain(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    for (let read = 0; read < RESPONSE_BYTES;) {
      const { done, value } = await reader.read();
      if (done) return;
      read += value.length;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export const signature = (secret: string, unix: number, body: string) =>
  `t=${unix},v1=${createHmac("sha256", secret).update(`${unix}.${body}`).digest("hex")}`;

export function startWebhookDelivery(options: {
  db: Database;
  clock: Clock;
  logger: ErrorLogger;
  webhooks: WebhookStore;
  blockPrivate: () => boolean;
  transport?: WebhookTransport;
}) {
  const { clock, webhooks } = options;
  const transport = options.transport ?? {};
  const send = transport.fetch ?? fetch;
  const active = new Map<bigint, number>();
  const running = new Set<Promise<void>>();
  const logged = new Map<bigint, number>();
  const abandon = new AbortController();
  writeTransaction(options.db, () => webhooks.recover());
  /** Finished attempts, settled together in the next claim's commit. */
  const finished: { delivery: ClaimedDelivery; error: string | null }[] = [];
  const settleFinished = () => {
    for (const { delivery, error } of finished.splice(0))
      report(delivery, webhooks.settle(delivery, error), error);
  };

  /** One attempt; its whole time is bounded. An error code is safe to store and show. */
  async function attempt(delivery: ClaimedDelivery): Promise<string | null> {
    const controller = new AbortController();
    let timedOut = false;
    void clock.sleep(REQUEST_TIMEOUT_MS, controller.signal).then(
      () => {
        timedOut = true;
        controller.abort();
      },
      () => {},
    );
    /** A resolver can outlast the deadline and cannot be cancelled. */
    const beforeAbort = <T>(work: Promise<T>) =>
      Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("Aborted")), {
            once: true,
          });
        }),
      ]);
    try {
      const url = new URL(delivery.target.url);
      const route = options.blockPrivate() ? await beforeAbort(pinned(url, transport)) : null;
      // Read after the last wait: a deletion during DNS must not leave the claim's body to send.
      const payload = webhooks.claimedPayload(delivery);
      if (payload === null) return CLAIM_GONE;
      const unix = Math.floor(clock.now().getTime() / 1000);
      const response = await send(route?.url ?? url, {
        method: "POST",
        redirect: "manual",
        decompress: false,
        signal: AbortSignal.any([controller.signal, abandon.signal]),
        headers: {
          ...route?.headers,
          "Content-Type": "application/json",
          "User-Agent": "iglo.email",
          "X-Iglo-Email-Signature": signature(delivery.target.secret, unix, payload),
        },
        body: payload,
        ...route?.tls,
      });
      if (response.status >= 200 && response.status < 300) {
        // The status decided it; a stalled or broken body does not undo a success.
        await drain(response).catch(() => {});
        return null;
      }
      void response.body?.cancel().catch(() => {});
      return response.status >= 300 && response.status < 400
        ? `redirect_${response.status}`
        : `http_${response.status}`;
    } catch (error) {
      if (timedOut) return "timeout";
      if (error instanceof Refused) return "blocked_address";
      return "network_error";
    } finally {
      controller.abort();
    }
  }

  function report(delivery: ClaimedDelivery, status: string | null, error: string | null) {
    const id = delivery.target.id;
    if (error === null) return void logged.delete(id);
    if (status !== "failed" && delivery.attempts < FAILURE_LOG_ATTEMPTS) return;
    const now = clock.now().getTime(),
      last = logged.get(id);
    if (last !== undefined && now - last < FAILURE_LOG_MS) return;
    logged.set(id, now);
    // Only the webhook's ID and a safe code: its URL can hold a token and bodies are foreign.
    options.logger.error(new Error(`Webhook ${id} deliveries are failing: ${error}`));
  }

  const loop = startLoop<ClaimedDelivery>({
    db: options.db,
    clock,
    logger: { error: () => options.logger.error(new Error("Webhook delivery failed")) },
    intervalMs: POLL_MS,
    leaseMs: LEASE_MS,
    batchSize: MAX_WEBHOOKS * WEBHOOK_CONCURRENCY,
    claim(now, lease) {
      settleFinished();
      return webhooks.claim(lease, now, (id) => WEBHOOK_CONCURRENCY - (active.get(id) ?? 0));
    },
    // Requests run beside the loop, so it keeps claiming for receivers with free slots.
    process(delivery) {
      const id = delivery.target.id;
      active.set(id, (active.get(id) ?? 0) + 1);
      const run = attempt(delivery)
        .then((error) => {
          if (!abandon.signal.aborted && error !== CLAIM_GONE) finished.push({ delivery, error });
        })
        .finally(() => {
          const left = active.get(id)! - 1;
          if (left) active.set(id, left);
          else active.delete(id);
          running.delete(run);
          loop.wake();
        });
      running.add(run);
    },
  });
  webhooks.onWake(() => loop.wake());
  return {
    done: loop.done,
    wake: () => loop.wake(),
    /** Stop claiming and abandon attempts in flight, whose rows keep only their lease. */
    async halt() {
      webhooks.onWake(() => {});
      abandon.abort();
      await loop.stop();
      await Promise.allSettled(running);
    },
    /** Stop claiming; attempts in flight finish or time out, so their rows settle. */
    async stop() {
      webhooks.onWake(() => {});
      try {
        await loop.stop();
      } finally {
        await Promise.allSettled(running);
        if (finished.length) writeTransaction(options.db, settleFinished);
      }
    },
  };
}
