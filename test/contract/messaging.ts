// SMTP test reference: listmonk cmd/settings.go and internal/messenger/email/email.go at 6fcd95f.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { faultRelay } from "@/test/messaging/fault-relay";
import type { Credentials, Mode } from "@/test/contract/types";

export async function runMessagingContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
  restart?: () => Promise<void>;
}) {
  const sink = referenceMailpit(process.env);
  await assertOwnedMailpit(sink);
  const recipient = `m21-${sink.runId}@example.test`;
  const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const request = (body: string, auth = authorization) =>
    fetch(`${target.baseUrl}/api/settings/smtp/test`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body,
      signal: AbortSignal.timeout(15000),
    });
  assert.equal((await request("{}", "")).status, 403);
  const missing = await request("{}");
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { message: "Missing field(s): email" });
  const response = await request(
    JSON.stringify({
      email: recipient,
      host: sink.host,
      port: sink.port,
      auth_protocol: "none",
      tls_type: "none",
      email_headers: [{ "X-M21-Fixture": "smtp-test" }],
    }),
  );
  assert.equal(response.status, 200);
  const envelope = (await response.json()) as { data: unknown };
  assert.ok(Array.isArray(envelope.data));
  if (target.mode === "normal") assert.deepEqual(envelope.data, []); // D49
  const query = new URLSearchParams({ query: `to:${recipient}`, limit: "100" });
  const list = await fetch(`${sink.api}/api/v1/search?${query}`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(list.status, 200);
  const found = (await list.json()) as { messages: Array<{ ID: string; Subject: string }> };
  assert.equal(found.messages.length, 1);
  assert.equal(found.messages[0]!.Subject, "Test connection");
  const message = await fetch(`${sink.api}/api/v1/message/${found.messages[0]!.ID}`, {
    signal: AbortSignal.timeout(5000),
  });
  const captured = (await message.json()) as { To: Array<{ Address: string }>; HTML: string };
  assert.deepEqual(
    captured.To.map((item) => item.Address),
    [recipient],
  );
  assert.match(captured.HTML, /Test connection/);
  if (target.mode === "normal") {
    const malformed = await request("{");
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { message: "Invalid data." });
    const invalid = await request(JSON.stringify({ email: recipient, host: "", port: 0 }));
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { message: "Invalid SMTP configuration." });
    const refusedSocket = createServer();
    await new Promise<void>((resolve, reject) => {
      refusedSocket.once("error", reject);
      refusedSocket.listen(0, "127.0.0.1", resolve);
    });
    const address = refusedSocket.address();
    if (!address || typeof address === "string") throw new Error("Missing refusal port");
    const refusedPort = address.port;
    await new Promise<void>((resolve, reject) =>
      refusedSocket.close((error) => (error ? reject(error) : resolve())),
    );
    const refused = await request(
      JSON.stringify({
        email: recipient,
        host: sink.host,
        port: refusedPort,
        auth_protocol: "none",
        tls_type: "none",
      }),
    );
    assert.equal(refused.status, 500);
    assert.deepEqual(await refused.json(), { message: "SMTP test failed." });
    for (const fault of ["all-rcpt", "before-data", "during-data", "lost-final", "auth"] as const) {
      const faulted = await faultRelay(sink, fault, {
        user: "m21-fixture-user",
        password: "m21-fixture-password",
      });
      try {
        const failed = await request(
          JSON.stringify({
            email: recipient,
            host: sink.host,
            port: faulted.port,
            auth_protocol: fault === "auth" ? "plain" : "none",
            username: "m21-fixture-user",
            password: "synthetic-wrong",
            tls_type: "none",
          }),
        );
        assert.equal(failed.status, 500);
        assert.deepEqual(await failed.json(), {
          message:
            fault === "all-rcpt" || fault === "auth"
              ? "SMTP test failed."
              : "SMTP test outcome is unknown.",
        });
        assert.equal(faulted.connections(), 1);
      } finally {
        await faulted.close();
      }
    }
    const relay = await faultRelay(sink, "hold");
    try {
      const body = JSON.stringify({
        email: recipient,
        host: sink.host,
        port: relay.port,
        auth_protocol: "none",
        tls_type: "none",
      });
      const held = Array.from({ length: 4 }, () => request(body));
      await Promise.race([
        relay.entered,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Held SMTP tests did not connect")), 4000),
        ),
      ]);
      const overflow = await request(body);
      assert.equal(overflow.status, 429);
      assert.deepEqual(await overflow.json(), { message: "Too many SMTP tests in progress." });
      assert.equal(relay.connections(), 4);
      relay.release();
      assert.deepEqual(
        (await Promise.all(held)).map((r) => r.status),
        [200, 200, 200, 200],
      );
    } finally {
      relay.release();
      await relay.close();
    }
    if (target.restart) {
      const heldFinal = await faultRelay(sink, "hold-final");
      try {
        const pending = request(
          JSON.stringify({
            email: recipient,
            host: sink.host,
            port: heldFinal.port,
            auth_protocol: "none",
            tls_type: "none",
          }),
        );
        await Promise.race([
          heldFinal.atFinal,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("SMTP final barrier failed")), 4000),
          ),
        ]);
        const restarting = target.restart();
        const outcome = await pending;
        assert.equal(outcome.status, 500);
        assert.deepEqual(await outcome.json(), { message: "SMTP test outcome is unknown." });
        await heldFinal.disconnected;
        await restarting;
        assert.equal(heldFinal.connections(), 1);
      } finally {
        heldFinal.release();
        await heldFinal.close();
      }
    }
  }
}

if (import.meta.main) {
  try {
    if (process.argv[2] !== "reference") throw new Error("Invalid mode");
    const {
      REFERENCE_URL: baseUrl,
      REFERENCE_API_USER: user,
      REFERENCE_API_TOKEN: token,
    } = process.env;
    if (!baseUrl || !user || !token) throw new Error("Missing reference credentials");
    await runMessagingContract({ mode: "reference", baseUrl, credentials: { user, token } });
  } catch {
    process.stderr.write("Messaging contract failed\n");
    process.exitCode = 1;
  }
}
