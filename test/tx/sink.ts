// Minimal loopback SMTP sink for in-process tests; never a real server.
import { createServer, type Socket } from "node:net";
import type { Clock } from "@/clock";

export interface Captured {
  from: string;
  to: string[];
  data: string;
  at?: number;
}
/**
 * `pauseMs` stops reading after each chunk: an SMTP server on a slow link. `discardData` keeps
 * no message text, so a memory measurement does not count the sink's own copy (B26).
 */
export async function startSink(
  options: {
    reject?: ((to: string) => boolean) | undefined;
    pauseMs?: number | undefined;
    discardData?: boolean | undefined;
    clock?: Clock | undefined;
  } = {},
) {
  const messages: Captured[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("latin1");
    let buffer = "";
    let data: string[] | null = null;
    let current: Captured = { from: "", to: [], data: "" };
    socket.write("220 sink.test ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      if (options.pauseMs) {
        socket.pause();
        setTimeout(() => socket.resume(), options.pauseMs);
      }
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (data) {
          if (line === ".") {
            current.data = options.discardData ? "" : data.join("\r\n");
            current.at = options.clock ? options.clock.now().getTime() : Date.now();
            data = null;
            messages.push(current);
            socket.write("250 queued\r\n");
            current = { from: "", to: [], data: "" };
          } else if (!options.discardData) data.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") socket.write("250-sink.test\r\n250 8BITMIME\r\n");
        else if (verb === "HELO") socket.write("250 sink.test\r\n");
        else if (verb === "MAIL") {
          current.from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          socket.write("250 ok\r\n");
        } else if (verb === "RCPT") {
          const to = /<([^>]*)>/.exec(line)?.[1] ?? "";
          if (options.reject?.(to)) {
            socket.write("550 no such user\r\n");
          } else {
            current.to.push(to);
            socket.write("250 ok\r\n");
          }
        } else if (verb === "DATA") {
          data = [];
          socket.write("354 go\r\n");
        } else if (verb === "RSET" || verb === "NOOP") socket.write("250 ok\r\n");
        else if (verb === "QUIT") {
          socket.end("221 bye\r\n");
        } else socket.write("502 unsupported\r\n");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing sink address");
  return {
    port: address.port,
    messages,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Greets and then never answers. */
export async function startStalledSink() {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.write("220 stalled.test ESMTP\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing sink address");
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
