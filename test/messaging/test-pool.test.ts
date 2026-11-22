// A test send has its own pool, keyed apart from real sends (B101). A stalled test send therefore
// cannot cut the real sends that share its SMTP server at the test's 60 s cut-off. The sink holds
// each held recipient's reply to DATA until the test releases it, so real sends are still in flight
// when the cut fires. Time is the injected clock; nothing sleeps.
import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { createEmailer } from "@/messaging/email";
import type { SMTPServer } from "@/messaging/email";
import { TestClock } from "@/test/server/fixture";

const STALLED = "stalled@example.test";
const REAL = "real@example.test";
const message = {
  from: "sender@example.test",
  to: [STALLED],
  subject: "test pool fixture",
  contentType: "plain" as const,
  body: Buffer.from("fixture"),
};

/**
 * A loopback SMTP sink that replies to DATA at once, except for the recipients it holds: their
 * reply waits until `release`. A held recipient that is never released stalls until its socket closes.
 */
async function holdingSink(holds: Array<string>) {
  const held = new Map<string, Socket>();
  const sockets = new Set<Socket>();
  const dataWaiters = new Map<string, Promise<void>>();
  const dataResolvers = new Map<string, () => void>();
  const dataDone = (address: string) => {
    if (!dataWaiters.has(address)) {
      dataWaiters.set(
        address,
        new Promise<void>((resolve) => {
          dataResolvers.set(address, resolve);
        }),
      );
    }
    return dataWaiters.get(address)!;
  };
  const listener = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.write("220 holding.test ESMTP\r\n");
    let buffer = "";
    let recipient = "";
    let inData = false;
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      for (let end = buffer.indexOf("\r\n"); end >= 0; end = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line !== ".") {
            continue;
          }
          inData = false;
          if (holds.includes(recipient)) {
            held.set(recipient, socket);
          } else {
            socket.write("250 queued\r\n");
          }
          // Creates the waiter if none exists yet; the resolver below settles it.
          void dataDone(recipient);
          dataResolvers.get(recipient)?.();
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") {
          socket.write("250 holding.test\r\n");
        } else if (verb === "MAIL" || verb === "RSET" || verb === "NOOP") {
          socket.write("250 ok\r\n");
        } else if (verb === "RCPT") {
          recipient = /<([^>]*)>/.exec(line)?.[1] ?? "";
          socket.write("250 ok\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 go\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 bye\r\n");
        } else {
          socket.write("502 unsupported\r\n");
        }
      }
    });
  });
  await new Promise<void>((resolve) => {
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") {
    throw new Error("missing address");
  }
  const server: SMTPServer = {
    name: "holding",
    enabled: true,
    exclude_from_default: false,
    host: "127.0.0.1",
    port: address.port,
    hello_hostname: "holding.test",
    max_conns: 2,
    idle_timeout: "2s",
    wait_timeout: "2s",
    auth_protocol: "none",
    username: "",
    tls_type: "none",
    tls_skip_verify: false,
    email_headers: [],
    from_addresses: [],
  };
  return {
    server,
    /** Resolves once the sink has read DATA for this recipient (held or not). */
    dataSeen: (address: string) => dataDone(address),
    connections: () => sockets.size,
    release(address: string) {
      const socket = held.get(address);
      held.delete(address);
      if (socket && !socket.destroyed) {
        socket.write("250 queued\r\n");
      }
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        listener.close((e) => (e ? reject(e) : resolve()));
      });
    },
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

test("a stalled test send does not cut real sends on the same server at its 60 s cut-off", async () => {
  const sink = await holdingSink([STALLED, REAL]);
  cleanup.push(sink.close);
  const clock = new TestClock();
  const emailer = createEmailer({
    settings: () => ({ smtp: [sink.server], rootUrl: "https://example.test" }),
    clock,
  });
  const stalled = emailer.push({ ...message, to: [STALLED] }, { copies: false, testPool: true });
  await sink.dataSeen(STALLED);
  // Dispatched a second later, so the real send's own 60 s cut-off is not due at the same advance.
  clock.advance(1000);
  const real = emailer.push({ ...message, to: [REAL] }, { copies: false });
  await sink.dataSeen(REAL);
  // Each kind of send has its own connection.
  expect(sink.connections()).toBe(2);
  clock.advance(59_000);
  expect(await stalled.result).toMatchObject({ status: "ambiguous", stage: "unknown" });
  // The real send is still in DATA: it settles on its reply, not on the test's cut.
  sink.release(REAL);
  expect(await real.result).toMatchObject({ status: "accepted", stage: "smtp-complete" });
  await emailer.close();
});

test("shutdown drains, then cancels a stalled test send with the real sends", async () => {
  const sink = await holdingSink([STALLED]);
  cleanup.push(sink.close);
  const clock = new TestClock();
  const emailer = createEmailer({
    settings: () => ({ smtp: [sink.server], rootUrl: "https://example.test" }),
    clock,
  });
  const stalled = emailer.push({ ...message, to: [STALLED] }, { copies: false, testPool: true });
  await sink.dataSeen(STALLED);
  const close = emailer.close();
  clock.advance(4999);
  await Promise.resolve();
  clock.advance(1);
  await close;
  expect(await stalled.result).toMatchObject({ status: "ambiguous", stage: "unknown" });
});
