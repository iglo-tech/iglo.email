// A test-only stand-in for AWS's SNS certificate endpoint, for the compiled executable. The
// process reaches `sns.eu-west-1.amazonaws.com` only through HTTPS_PROXY:
// this loopback proxy accepts CONNECT for that host alone, terminates TLS with a certificate
// issued for it here (trusted through NODE_EXTRA_CA_CERTS), and serves the signing certificate
// that test/bounces/ses-fixture.ts signs with. Every other destination is refused, so nothing
// leaves the machine.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import { CERT, good } from "@/test/bounces/ses-fixture";

const { hostname: host, pathname: certPath } = new URL(CERT);

export interface SnsTunnel {
  /** Added to the compiled process's environment. */
  environment: Record<string, string>;
  close(): Promise<void>;
}

/**
 * `certificateHost` issues the certificate for another name, so a client that verifies the host
 * must refuse it (test/bounces/sns-tunnel.test.ts). The CONNECT target stays the SNS host.
 */
export async function startSnsTunnel(
  options: { certificateHost?: string } = {},
): Promise<SnsTunnel> {
  const certificateHost = options.certificateHost ?? host;
  const dir = mkdtempSync(join(tmpdir(), "iglo-sns-tunnel-"));
  const keyPath = join(dir, "tls.key");
  const certFile = join(dir, "tls.pem");
  try {
    const issued = Bun.spawnSync(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certFile,
        "-subj",
        `/CN=${certificateHost}`,
        "-addext",
        `subjectAltName=DNS:${certificateHost}`,
        "-days",
        "2",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (issued.exitCode !== 0) throw new Error(issued.stderr.toString());
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const key = readFileSync(keyPath);
  const cert = readFileSync(certFile);
  const sockets = new Set<Socket | TLSSocket>();

  const server = createServer((client) => {
    sockets.add(client);
    client.on("error", () => {});
    client.once("data", (request) => {
      const [line] = request.toString("latin1").split("\r\n");
      if (line !== `CONNECT ${host}:443 HTTP/1.1`) {
        client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const secure = new TLSSocket(client, { isServer: true, key, cert });
      sockets.add(secure);
      secure.on("error", () => {});
      let head = "";
      let answered = false;
      secure.on("data", (chunk: Buffer) => {
        head += chunk.toString("latin1");
        if (answered || !head.includes("\r\n\r\n")) return;
        answered = true;
        const found = head.startsWith(`GET ${certPath} HTTP/1.1\r\n`);
        const payload = Buffer.from(found ? good.pem : "no");
        const headers = [
          found ? "HTTP/1.1 200 OK" : "HTTP/1.1 404 Not Found",
          "content-type: application/x-pem-file",
          `content-length: ${payload.length}`,
          "connection: close",
        ].join("\r\n");
        secure.end(Buffer.concat([Buffer.from(`${headers}\r\n\r\n`), payload]));
      });
    });
    client.on("close", () => sockets.delete(client));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    environment: {
      HTTPS_PROXY: `http://127.0.0.1:${port}`,
      NO_PROXY: "127.0.0.1,localhost",
      NODE_EXTRA_CA_CERTS: certFile,
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
