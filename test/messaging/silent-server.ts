// B118a: an SMTP server that accepts connections and never sends a byte, for the greeting-timeout
// boundary. It counts the bytes a client writes, which must stay 0 for a send to be proven not sent.
import { createServer } from "node:net";
import type { Socket } from "node:net";
import type { SMTPServer } from "@/messaging/email";

export async function silentServer(waitTimeout = "1s") {
  const sockets = new Set<Socket>();
  let received = 0;
  let accepted = 0;
  const listener = createServer((socket) => {
    accepted++;
    sockets.add(socket);
    socket.on("data", (chunk) => {
      received += chunk.length;
    });
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") {
    throw new Error("missing address");
  }
  const server: SMTPServer = {
    name: "silent",
    enabled: true,
    exclude_from_default: false,
    host: "127.0.0.1",
    port: address.port,
    hello_hostname: "fixture.test",
    max_conns: 1,
    idle_timeout: "2s",
    wait_timeout: waitTimeout,
    auth_protocol: "none",
    username: "",
    tls_type: "none",
    tls_skip_verify: false,
    email_headers: [],
    from_addresses: [],
  };
  return {
    server,
    port: address.port,
    bytesReceived: () => received,
    /** Connections accepted so far: a send that is retried connects again. */
    connections: () => accepted,
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
