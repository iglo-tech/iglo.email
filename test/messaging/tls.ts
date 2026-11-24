// A second invocation-owned Mailpit tests real TLS handshakes, never external endpoints.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRealClock } from "@/clock";
import { createEmailer } from "@/messaging/email";
import type { SMTPServer } from "@/messaging/email";
import { mailpitBinaryPath } from "@/test/reference/prepare";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { readJson } from "@/test/read-body";
import { untilState } from "@/test/wait";

const reference = referenceMailpit(process.env);
await assertOwnedMailpit(reference);
const directory = await mkdtemp(join(tmpdir(), "m21-tls-"));
/**
 * The loopback TCP ports process `pid` itself listens on, read from /proc (the pinned Mailpit is
 * Linux-only). Mailpit started on port 0 logs the address it was given, ":0", not the port it bound,
 * so the ports are read from the sockets the process holds: no port is chosen before Mailpit binds
 * it, and no other process can hold a port this lists.
 */
function listeningPorts(pid: number): Array<number> {
  const inodes = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (match) {
        inodes.add(match[1]!);
      }
    } catch {
      // A descriptor that closed after the listing is skipped.
    }
  }
  const ports: Array<number> = [];
  for (const line of readFileSync("/proc/net/tcp", "utf-8").split("\n").slice(1)) {
    const [, local, , state, , , , , , inode] = line.trim().split(/\s+/);
    if (state === "0A" && local?.startsWith("0100007F:") && inode && inodes.has(inode)) {
      ports.push(Number.parseInt(local.slice(9), 16));
    }
  }
  return ports;
}
try {
  const fixture = await readFile(resolve("test/messaging/tls-fixture.md"), "utf-8");
  const blocks = [...fixture.matchAll(/```pem\n([\s\S]*?)```/g)].map((match) => match[1]!);
  if (blocks.length !== 2) {
    throw new Error("Invalid TLS fixture");
  }
  const cert = join(directory, "cert.pem"),
    key = join(directory, "key.pem");
  await writeFile(cert, blocks[0]!);
  await writeFile(key, blocks[1]!, { mode: 0o600 });
  for (const mode of ["STARTTLS", "TLS"] as const) {
    const runId = randomUUID();
    const binary = mailpitBinaryPath();
    const child = spawn(
      binary,
      [
        "--listen",
        "127.0.0.1:0",
        "--smtp",
        "127.0.0.1:0",
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
    // A binary that cannot be spawned emits "error" and never "exit", so either event ends the wait.
    const spawnFailure: { error?: Error } = {};
    child.once("error", (error) => {
      spawnFailure.error = error;
    });
    const exited = new Promise<void>((resolveExit) => {
      child.once("exit", () => resolveExit());
      child.once("error", () => resolveExit());
    });
    const sink = { api: "", host: "127.0.0.1", port: 0, runId };
    try {
      let observed = "starting";
      // Mailpit binds both ports itself (port 0). Ready is when this process listens on two loopback
      // ports and the HTTP one answers as the owned sink; the other one is its SMTP port. The wait
      // fails by name after 5 s with no change in what it saw, and says what that was.
      await untilState(
        async () => {
          if (spawnFailure.error) {
            throw new Error(
              `Mailpit cannot start from ${binary}: ${spawnFailure.error.message}. Run bun run reference:prepare for this host.`,
            );
          }
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`Mailpit (${mode}) exited before it was ready`);
          }
          const ports = listeningPorts(child.pid!);
          if (ports.length !== 2) {
            observed = `listening on ${ports.length} loopback ports`;
            return false;
          }
          const owned: Array<number> = [];
          for (const candidate of ports) {
            try {
              await assertOwnedMailpit({ ...sink, api: `http://127.0.0.1:${candidate}` });
              owned.push(candidate);
            } catch (error) {
              observed = String(error);
            }
          }
          if (owned.length !== 1) {
            return false;
          }
          sink.api = `http://127.0.0.1:${owned[0]}`;
          sink.port = ports.find((candidate) => candidate !== owned[0])!;
          return true;
        },
        {
          label: `Mailpit (${mode}) was not ready within 5 s`,
          progress: () => observed,
          stallMs: 5000,
          intervalMs: 25,
        },
      );
      const smtpPort = sink.port;
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
        await new Promise<void>((done) => {
          proxy.listen(0, "127.0.0.2", done);
        });
        const proxyAddress = proxy.address();
        if (!proxyAddress || typeof proxyAddress === "string") {
          throw new Error("Missing proxy port");
        }
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
          await new Promise<void>((done) => {
            proxy.close(() => done());
          });
        }
        const response = await fetch(`${sink.api}/api/v1/messages`, {
          signal: AbortSignal.timeout(5000),
        });
        const list = await readJson<{ messages: Array<{ Subject: string }> }>(response);
        assert.equal(list.messages.filter((entry) => entry.Subject === message.subject).length, 1);
      } finally {
        await emailer.close();
      }
    } finally {
      if (!spawnFailure.error) {
        child.kill("SIGTERM");
      }
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolveExit) => {
          forceTimer = setTimeout(() => {
            child.kill("SIGKILL");
            resolveExit();
          }, 3000);
        }),
      ]);
      clearTimeout(forceTimer);
      await exited;
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
