// A second invocation-owned Mailpit tests real TLS handshakes, never external endpoints.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRealClock } from "@/clock";
import { createEmailer, type SMTPServer } from "@/messaging/email";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";

const reference = referenceMailpit(process.env);
await assertOwnedMailpit(reference);
const directory = await mkdtemp(join(tmpdir(), "m21-tls-"));
async function port() {
  const server = createServer();
  await new Promise<void>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePort);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local port");
  await new Promise<void>((resolvePort, reject) =>
    server.close((error) => (error ? reject(error) : resolvePort())),
  );
  return address.port;
}
try {
  const fixture = await readFile(resolve("test/messaging/tls-fixture.md"), "utf8");
  const blocks = [...fixture.matchAll(/```pem\n([\s\S]*?)```/g)].map((match) => match[1]!);
  if (blocks.length !== 2) throw new Error("Invalid TLS fixture");
  const cert = join(directory, "cert.pem"),
    key = join(directory, "key.pem");
  await writeFile(cert, blocks[0]!);
  await writeFile(key, blocks[1]!, { mode: 0o600 });
  for (const mode of ["STARTTLS", "TLS"] as const) {
    const smtpPort = await port(),
      httpPort = await port(),
      runId = randomUUID();
    const binary = resolve("upstream/reference/mailpit-linux-amd64.tar.gz-mailpit");
    const child = spawn(
      binary,
      [
        "--listen",
        `127.0.0.1:${httpPort}`,
        "--smtp",
        `127.0.0.1:${smtpPort}`,
        "--label",
        runId,
        "--disable-version-check",
        "--smtp-disable-rdns",
        "--quiet",
        "--smtp-auth-accept-any",
        "--smtp-tls-cert",
        cert,
        "--smtp-tls-key",
        key,
        ...(mode === "TLS" ? ["--smtp-require-tls"] : ["--smtp-require-starttls"]),
      ],
      { cwd: directory, env: { PATH: "", HOME: directory, TMPDIR: directory }, stdio: "ignore" },
    );
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    const sink = { api: `http://127.0.0.1:${httpPort}`, host: "127.0.0.1", port: smtpPort, runId };
    try {
      let ready = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !ready) {
        try {
          await assertOwnedMailpit(sink);
          ready = true;
        } catch {
          await Bun.sleep(25);
        }
      }
      assert.equal(ready, true);
      const server: SMTPServer = {
        name: "",
        enabled: true,
        exclude_from_default: false,
        host: sink.host,
        port: sink.port,
        hello_hostname: "fixture.test",
        max_conns: 1,
        idle_timeout: "2s",
        wait_timeout: "2s",
        auth_protocol: "none",
        username: "",
        tls_type: mode,
        tls_skip_verify: false,
        email_headers: [],
        from_addresses: [],
      };
      let current = [server];
      const emailer = createEmailer({
        settings: () => ({ smtp: current, rootUrl: "https://example.test" }),
        clock: createRealClock(),
      });
      try {
        const message = {
          from: "sender@example.test",
          to: ["recipient@example.test"],
          subject: `m21-${mode}-${runId}`,
          contentType: "plain" as const,
          body: Buffer.from("TLS fixture"),
        };
        assert.notEqual((await emailer.push(message).result).status, "accepted");
        current = [{ ...server, tls_skip_verify: true }];
        assert.equal((await emailer.push(message).result).status, "accepted");
        // A loopback proxy provides a different IP identity for the same certificate.
        const proxy = createServer((incoming) => {
          const upstream = createConnection({ host: "127.0.0.1", port: smtpPort });
          incoming.on("error", () => {});
          upstream.on("error", () => {});
          incoming.pipe(upstream).pipe(incoming);
          incoming.once("close", () => upstream.destroy());
          upstream.once("close", () => incoming.destroy());
        });
        await new Promise<void>((done) => proxy.listen(0, "127.0.0.2", done));
        const proxyAddress = proxy.address();
        if (!proxyAddress || typeof proxyAddress === "string")
          throw new Error("Missing proxy port");
        try {
          for (const [host, testPort, expected] of [
            ["127.0.0.1", smtpPort, "accept"],
            ["127.0.0.2", proxyAddress.port, "reject"],
          ] as const) {
            const probe = spawn(process.execPath, [resolve("test/messaging/tls-client.ts")], {
              env: {
                ...process.env,
                NODE_EXTRA_CA_CERTS: cert,
                M21_TLS_HOST: host,
                M21_TLS_PORT: String(testPort),
                M21_TLS_MODE: mode,
                M21_TLS_EXPECT: expected,
              },
              stdio: "inherit",
            });
            const code = await new Promise<number | null>((done, reject) => {
              probe.once("error", reject);
              probe.once("exit", done);
            });
            assert.equal(code, 0);
          }
        } finally {
          await new Promise<void>((done) => proxy.close(() => done()));
        }
        const response = await fetch(`${sink.api}/api/v1/messages`, {
          signal: AbortSignal.timeout(5000),
        });
        const list = (await response.json()) as { messages: Array<{ Subject: string }> };
        assert.equal(list.messages.filter((entry) => entry.Subject === message.subject).length, 1);
      } finally {
        await emailer.close();
      }
    } finally {
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise<void>((resolveExit) =>
          setTimeout(() => {
            child.kill("SIGKILL");
            resolveExit();
          }, 3000),
        ),
      ]);
      await exited;
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
