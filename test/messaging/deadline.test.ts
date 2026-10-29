import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { createEmailer, type SMTPServer } from "@/messaging/email";
import { TestClock } from "@/test/server/fixture";

const message = {
  from: "sender@example.test",
  to: ["recipient@example.test"],
  subject: "deadline fixture",
  contentType: "plain" as const,
  body: Buffer.from("fixture"),
};
async function peer() {
  const sockets = new Set<Socket>();
  let entered!: () => void;
  let disconnected!: () => void;
  let secondEntered!: () => void;
  const secondConnected = new Promise<void>((resolve) => {
    secondEntered = resolve;
  });
  const connected = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  let connections = 0;
  const listener = createServer((socket) => {
    connections++;
    if (connections === 2) secondEntered();
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => {
      sockets.delete(socket);
      disconnected();
    });
    entered();
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const server: SMTPServer = {
    name: "fixture",
    enabled: true,
    exclude_from_default: false,
    host: "127.0.0.1",
    port: address.port,
    hello_hostname: "fixture.test",
    max_conns: 1,
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
    connected,
    secondConnected,
    closed,
    connections: () => connections,
    trickle: () => {
      for (const socket of sockets) socket.write("220-");
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        listener.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

describe("messaging absolute deadlines", () => {
  test("trickling connection and queued dispatch expire at their absolute deadlines", async () => {
    const sink = await peer();
    cleanup.push(sink.close);
    const clock = new TestClock();
    const emailer = createEmailer({
      settings: () => ({ smtp: [sink.server], rootUrl: "https://example.test" }),
      clock,
    });
    const first = emailer.push(message);
    await sink.connected;
    const second = emailer.push(message);
    sink.trickle();
    clock.advance(59999);
    await Promise.resolve();
    sink.trickle();
    clock.advance(1);
    const [a, b] = await Promise.all([first.result, second.result]);
    expect(a).toMatchObject({ messageId: first.messageId, status: "ambiguous" });
    expect(b).toMatchObject({
      messageId: second.messageId,
      status: "proven-not-accepted",
      stage: "local",
    });
    await sink.closed;
    expect(sink.connections()).toBe(1);
    await emailer.close();
  });

  test("time spent capturing configuration counts against dispatch lifetime", async () => {
    const sink = await peer();
    cleanup.push(sink.close);
    const clock = new TestClock();
    const emailer = createEmailer({
      settings: () => {
        clock.advance(60000);
        return { smtp: [sink.server], rootUrl: "https://example.test" };
      },
      clock,
    });
    const send = emailer.push({ ...message, messageId: "<capture@example.test>" });
    expect(await send.result).toMatchObject({
      messageId: "<capture@example.test>",
      status: "proven-not-accepted",
      stage: "local",
    });
    expect(sink.connections()).toBe(0);
    await emailer.close();
  });

  test("configured connection cap bounds active sends and leaves excess locally queued", async () => {
    const sink = await peer();
    cleanup.push(sink.close);
    sink.server.max_conns = 2;
    const clock = new TestClock();
    const emailer = createEmailer({
      settings: () => ({ smtp: [sink.server], rootUrl: "https://example.test" }),
      clock,
    });
    const sends = [emailer.push(message), emailer.push(message), emailer.push(message)];
    await sink.secondConnected;
    expect(sink.connections()).toBe(2);
    clock.advance(60000);
    expect(
      (await Promise.all(sends.map((send) => send.result))).map((outcome) => outcome.status),
    ).toEqual(["ambiguous", "ambiguous", "proven-not-accepted"]);
    await emailer.close();
  });

  test("shutdown closes admission, drains for five seconds and cancels the held and queued operations", async () => {
    const sink = await peer();
    cleanup.push(sink.close);
    const clock = new TestClock();
    const emailer = createEmailer({
      settings: () => ({ smtp: [sink.server], rootUrl: "https://example.test" }),
      clock,
    });
    const first = emailer.push(message);
    await sink.connected;
    const queued = emailer.push(message);
    const close = emailer.close();
    expect(emailer.close()).toBe(close);
    const refused = emailer.push({ ...message, messageId: "<known@example.test>" });
    expect(refused.messageId).toBe("<known@example.test>");
    expect((await refused.result).stage).toBe("local");
    clock.advance(4999);
    await Promise.resolve();
    clock.advance(1);
    await close;
    expect((await first.result).status).toBe("ambiguous");
    expect((await queued.result).status).toBe("proven-not-accepted");
    await sink.closed;
    expect(sink.connections()).toBe(1);
  });

  test("temporary test and a retired configuration remain bounded", async () => {
    const old = await peer();
    const replacement = await peer();
    cleanup.push(old.close, replacement.close);
    const clock = new TestClock();
    let current = [old.server];
    const emailer = createEmailer({
      settings: () => ({ smtp: current, rootUrl: "https://example.test" }),
      clock,
    });
    const first = emailer.push(message);
    await old.connected;
    current = [replacement.server];
    const second = emailer.test(replacement.server, message, "https://example.test");
    await replacement.connected;
    // Trigger reconciliation while the old configuration is still in flight.
    const queued = emailer.push(message);
    clock.advance(10000);
    expect((await second.result).status).toBe("ambiguous");
    await replacement.closed;
    clock.advance(50000);
    expect((await first.result).status).toBe("ambiguous");
    await old.closed;
    expect((await queued.result).status).toBe("ambiguous");
    await emailer.close();
  });
});

test("a temporary implicit TLS connection is physically closed at its deadline", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createServer: createTLS } = await import("node:tls");
  const fixture = await readFile("test/messaging/tls-fixture.md", "utf8");
  const blocks = [...fixture.matchAll(/```pem\n([\s\S]*?)```/g)].map((match) => match[1]!);
  let entered!: () => void;
  let disconnected!: () => void;
  const connected = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const listener = createTLS({ cert: blocks[0], key: blocks[1] }, (socket) => {
    socket.on("error", () => {});
    socket.once("close", disconnected);
    entered();
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const server: SMTPServer = {
    name: "",
    enabled: true,
    exclude_from_default: false,
    host: "127.0.0.1",
    port: address.port,
    hello_hostname: "",
    max_conns: 1,
    idle_timeout: "2s",
    wait_timeout: "2s",
    auth_protocol: "none",
    username: "",
    tls_type: "TLS",
    tls_skip_verify: true,
    email_headers: [],
    from_addresses: [],
  };
  const clock = new TestClock();
  const emailer = createEmailer({
    settings: () => ({ smtp: [], rootUrl: "https://example.test" }),
    clock,
  });
  try {
    const send = emailer.test(server, message, "https://example.test");
    await connected;
    clock.advance(10000);
    expect((await send.result).status).toBe("ambiguous");
    await closed;
    await emailer.close();
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test("shutdown bounds an idle connection whose peer keeps its half open", async () => {
  const clock = new TestClock();
  let ended!: () => void;
  const peerEnded = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const sockets = new Set<Socket>();
  const listener = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("end", ended);
    socket.once("close", () => sockets.delete(socket));
    socket.write("220 fixture\r\n");
    let buffer = "",
      data = false;
    socket.on("data", (part) => {
      buffer += part.toString();
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") {
            data = false;
            socket.write("250 queued\r\n");
          }
        } else if (/^EHLO/.test(line)) socket.write("250 fixture\r\n");
        else if (/^DATA/.test(line)) {
          data = true;
          socket.write("354 send\r\n");
        } else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const config: SMTPServer = {
    name: "",
    enabled: true,
    exclude_from_default: false,
    host: "127.0.0.1",
    port: address.port,
    hello_hostname: "",
    max_conns: 1,
    idle_timeout: "30s",
    wait_timeout: "2s",
    auth_protocol: "none",
    username: "",
    tls_type: "none",
    tls_skip_verify: false,
    email_headers: [],
    from_addresses: [],
  };
  const emailer = createEmailer({
    settings: () => ({ smtp: [config], rootUrl: "https://example.test" }),
    clock,
  });
  try {
    expect((await emailer.push(message).result).status).toBe("accepted");
    // Let the public transport finish returning the successful connection to its pool.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const close = emailer.close();
    await peerEnded;
    clock.advance(5000);
    await close;
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});
