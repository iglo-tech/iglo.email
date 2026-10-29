// Minimal loopback SMTP sink for in-process tests; never a real server.
import { createServer, type Socket } from "node:net";

export interface Captured {
  from: string;
  to: string[];
  data: string;
}
export async function startSink(options: { reject?: () => boolean } = {}) {
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
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (data) {
          if (line === ".") {
            current.data = data.join("\r\n");
            data = null;
            messages.push(current);
            socket.write("250 queued\r\n");
            current = { from: "", to: [], data: "" };
          } else data.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") socket.write("250-sink.test\r\n250 8BITMIME\r\n");
        else if (verb === "HELO") socket.write("250 sink.test\r\n");
        else if (verb === "MAIL") {
          current.from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          socket.write("250 ok\r\n");
        } else if (verb === "RCPT" && options.reject?.()) {
          socket.write("550 no such user\r\n");
        } else if (verb === "RCPT") {
          current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
          socket.write("250 ok\r\n");
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
