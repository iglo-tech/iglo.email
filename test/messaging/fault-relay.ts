// Invocation-owned loopback relay for SMTP failure boundaries; forwards only to verified Mailpit.
import { createServer, createConnection, type Socket } from "node:net";
import { createHmac } from "node:crypto";
import type { ReferenceMailpit } from "@/test/perf/runtime-compat/smtp-env";

export type Fault =
  | "partial-rcpt"
  | "all-rcpt"
  | "before-data"
  | "during-data"
  | "lost-final"
  | "hold-final"
  | "hold"
  | "auth";
export async function faultRelay(
  sink: ReferenceMailpit,
  fault: Fault,
  credentials?: { user: string; password: string },
) {
  let connections = 0;
  let authenticated = 0;
  const greetings: string[] = [];
  let firstReady!: () => void;
  const first = new Promise<void>((resolve) => {
    firstReady = resolve;
  });
  let finalReady!: () => void;
  const atFinal = new Promise<void>((resolve) => {
    finalReady = resolve;
  });
  let closedReady!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    closedReady = resolve;
  });
  let heldReady!: () => void;
  let releaseHeld!: () => void;
  const entered = new Promise<void>((resolve) => {
    heldReady = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    connections++;
    if (connections === 1) firstReady();
    if (connections === 4) heldReady();
    const upstream = createConnection({ host: sink.host, port: sink.port });
    sockets.add(client);
    sockets.add(upstream);
    client.once("close", () => {
      sockets.delete(client);
      closedReady();
      upstream.destroy();
    });
    upstream.once("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.on("error", () => {});
    upstream.on("error", () => {});
    let fromClient = "",
      fromServer = "",
      data = false,
      finalPending = false;
    let ehlo = false,
      authState = "",
      authUser = "";
    const challenge = "<synthetic-m21@example.test>";
    const check = (user: string, password: string) => {
      if (user === credentials?.user && password === credentials.password) {
        authenticated++;
        client.write("235 2.7.0 authenticated\r\n");
      } else client.write("535 5.7.8 rejected\r\n");
      authState = "";
    };
    client.on("data", (chunk: Buffer) => {
      fromClient += chunk.toString("latin1");
      for (;;) {
        const end = fromClient.indexOf("\r\n");
        if (end < 0) break;
        const line = fromClient.slice(0, end);
        fromClient = fromClient.slice(end + 2);
        if (fault === "auth" && authState) {
          const decoded = Buffer.from(line, "base64").toString("utf8");
          if (authState === "plain") {
            const parts = decoded.split("\0");
            check(parts[1] ?? "", parts[2] ?? "");
          } else if (authState === "login-user") {
            authUser = decoded;
            authState = "login-password";
            client.write("334 UGFzc3dvcmQ6\r\n");
          } else if (authState === "login-password") check(authUser, decoded);
          else if (authState === "cram") {
            const expected = createHmac("md5", credentials?.password ?? "")
              .update(challenge)
              .digest("hex");
            const parts = decoded.split(" ");
            check(
              parts[0] ?? "",
              parts[1] === expected ? (credentials?.password ?? "") : "invalid",
            );
          }
        } else if (fault === "auth" && /^AUTH /i.test(line)) {
          const [_, method, initial] = line.split(" ");
          if (method?.toUpperCase() === "PLAIN") {
            authState = "plain";
            if (initial) {
              const parts = Buffer.from(initial, "base64").toString("utf8").split("\0");
              check(parts[1] ?? "", parts[2] ?? "");
            } else client.write("334 \r\n");
          } else if (method?.toUpperCase() === "LOGIN") {
            authState = "login-user";
            client.write("334 VXNlcm5hbWU6\r\n");
          } else if (method?.toUpperCase() === "CRAM-MD5") {
            authState = "cram";
            client.write(`334 ${Buffer.from(challenge).toString("base64")}\r\n`);
          } else client.write("504 5.5.4 unsupported\r\n");
        } else if (data) {
          if (fault === "during-data") {
            client.destroy();
            upstream.destroy();
            return;
          }
          upstream.write(`${line}\r\n`, "latin1");
          if (line === ".") {
            data = false;
            finalPending = true;
          }
        } else if (
          /^RCPT TO:/i.test(line) &&
          (fault === "all-rcpt" ||
            (fault === "partial-rcpt" && line.toLowerCase().includes("rejected@example.test")))
        ) {
          client.write("550 5.1.1 fixture rejection\r\n");
        } else if (/^DATA$/i.test(line) && fault === "before-data") {
          client.destroy();
          upstream.destroy();
          return;
        } else {
          if (/^(EHLO|HELO) /i.test(line)) greetings.push(line);
          if (/^EHLO /i.test(line)) ehlo = true;
          upstream.write(`${line}\r\n`, "latin1");
          if (/^DATA$/i.test(line)) data = true;
        }
      }
    });
    upstream.on("data", async (chunk: Buffer) => {
      if (fault === "hold") {
        await release;
        if (client.destroyed) return;
      }
      fromServer += chunk.toString("latin1");
      for (;;) {
        const end = fromServer.indexOf("\r\n");
        if (end < 0) break;
        const line = fromServer.slice(0, end);
        fromServer = fromServer.slice(end + 2);
        // Disable SMTP pipelining so synthetic replies preserve command order.
        if (/^250[- ]PIPELINING/i.test(line)) continue;
        if (finalPending && /^250 /.test(line)) {
          finalPending = false;
          if (fault === "hold-final") {
            finalReady();
            // Keep the socket active without completing an SMTP response. The
            // process test's outer guard then detects an unbounded HTTP drain.
            client.write("250-");
            const trickle = setInterval(() => client.write("x"), 250);
            try {
              await Promise.race([
                release,
                new Promise<void>((done) => client.once("close", done)),
              ]);
            } finally {
              clearInterval(trickle);
            }
            if (client.destroyed) return;
          }
          if (fault === "lost-final") {
            client.destroy();
            upstream.destroy();
            return;
          }
        }
        if (fault === "auth" && ehlo && line.startsWith("250 ")) {
          client.write("250-AUTH PLAIN LOGIN CRAM-MD5\r\n");
          ehlo = false;
        }
        client.write(`${line}\r\n`, "latin1");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Relay failed to listen");
  return {
    port: address.port,
    first,
    entered,
    atFinal,
    disconnected,
    release: releaseHeld,
    connections: () => connections,
    authenticated: () => authenticated,
    greetings: () => [...greetings],
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
