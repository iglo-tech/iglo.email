// SMTP test reference: listmonk cmd/settings.go and internal/messenger/email/email.go at 6fcd95f.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { faultRelay } from "@/test/messaging/fault-relay";
import { listmonkEnvelope } from "@/test/contract/envelope";
import { asBody } from "@/test/read-body";
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
      signal: AbortSignal.timeout(15_000),
    });
  assert.equal((await request("{}", "")).status, 403);
  const missing = await request("{}");
  assert.equal(missing.status, 400);
  assert.deepEqual(listmonkEnvelope(await missing.json(), target.mode, missing.status), {
    message: "Missing field(s): email",
  });
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
  const envelope = asBody<{ data: unknown }>(await response.json());
  assert.ok(Array.isArray(envelope.data));
  if (target.mode === "normal") {
    assert.deepEqual(envelope.data, []);
  } // D49
  const query = new URLSearchParams({ query: `to:${recipient}`, limit: "100" });
  const list = await fetch(`${sink.api}/api/v1/search?${query}`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(list.status, 200);
  const found = asBody<{ messages: Array<{ ID: string; Subject: string }> }>(await list.json());
  assert.equal(found.messages.length, 1);
  assert.equal(found.messages[0]!.Subject, "Test connection");
  const message = await fetch(`${sink.api}/api/v1/message/${found.messages[0]!.ID}`, {
    signal: AbortSignal.timeout(5000),
  });
  const captured = asBody<{ To: Array<{ Address: string }>; HTML: string }>(await message.json());
  assert.deepEqual(
    captured.To.map((item) => item.Address),
    [recipient],
  );
  assert.match(captured.HTML, /Test connection/);
  for (const email of [`one-${recipient}, two-${recipient}`, "invalid-local-only"]) {
    const invalid = await request(
      JSON.stringify({
        email,
        host: sink.host,
        port: sink.port,
        auth_protocol: "none",
        tls_type: "none",
      }),
    );
    assert.equal(invalid.status, 500);
    if (target.mode === "normal") {
      assert.deepEqual(listmonkEnvelope(await invalid.json(), target.mode, invalid.status), {
        message: "SMTP test failed.",
      });
    }
    const query = new URLSearchParams({ query: `to:one-${recipient}`, limit: "100" });
    assert.equal(
      asBody<{ messages: Array<unknown> }>(
        await (await fetch(`${sink.api}/api/v1/search?${query}`)).json(),
      ).messages.length,
      0,
    );
  }
  const nullHeaders = await request(
    JSON.stringify({
      email: `null-${recipient}`,
      host: sink.host,
      port: sink.port,
      auth_protocol: "none",
      tls_type: "none",
      email_headers: [null],
    }),
  );
  assert.equal(nullHeaders.status, 200);
  const quoted = await request(
    JSON.stringify({
      email: `"One, Named" <quoted-${recipient}>`,
      host: sink.host,
      port: sink.port,
      auth_protocol: "none",
      tls_type: "none",
    }),
  );
  assert.equal(quoted.status, 200);
  const quotedQuery = new URLSearchParams({ query: `to:quoted-${recipient}`, limit: "100" });
  const quotedIntake = asBody<{ messages: Array<{ ID: string }> }>(
    await (await fetch(`${sink.api}/api/v1/search?${quotedQuery}`)).json(),
  );
  assert.equal(quotedIntake.messages.length, 1);
  const quotedMessage = asBody<{ To: Array<{ Address: string }> }>(
    await (await fetch(`${sink.api}/api/v1/message/${quotedIntake.messages[0]!.ID}`)).json(),
  );
  assert.deepEqual(
    quotedMessage.To.map((value) => value.Address),
    [`quoted-${recipient}`],
  );
  const plainRelay = await faultRelay(
    sink,
    "auth",
    {
      user: "m21-fixture-user",
      password: "m21-fixture-password",
    },
    "127.0.0.2",
  );
  try {
    const insecure = await request(
      JSON.stringify({
        email: `insecure-${recipient}`,
        host: "127.0.0.2",
        port: plainRelay.port,
        auth_protocol: "plain",
        username: "m21-fixture-user",
        password: "m21-fixture-password",
        tls_type: "none",
      }),
    );
    assert.equal(insecure.status, 500);
    if (target.mode === "normal") {
      assert.deepEqual(listmonkEnvelope(await insecure.json(), target.mode, insecure.status), {
        message: "SMTP test failed.",
      });
    }
    assert.equal(plainRelay.authAttempts(), 0);
    const query = new URLSearchParams({ query: `to:insecure-${recipient}`, limit: "100" });
    assert.equal(
      asBody<{ messages: Array<unknown> }>(
        await (await fetch(`${sink.api}/api/v1/search?${query}`)).json(),
      ).messages.length,
      0,
    );
  } finally {
    await plainRelay.close();
  }
  for (const prompts of [["Password:", "Username:"], ["Unknown:"]]) {
    const reverse = prompts.length === 2;
    const to = `${reverse ? "reverse" : "unknown"}-${recipient}`;
    const relay = await faultRelay(sink, "auth", {
      user: "m21-fixture-user",
      password: "m21-fixture-password",
      loginPrompts: prompts,
    });
    try {
      const response = await request(
        JSON.stringify({
          email: to,
          host: sink.host,
          port: relay.port,
          auth_protocol: "login",
          username: "m21-fixture-user",
          password: "m21-fixture-password",
          tls_type: "none",
        }),
      );
      assert.equal(response.status, reverse ? 200 : 500);
      if (target.mode === "normal") {
        const body = await response.json();
        assert.deepEqual(
          reverse ? body : listmonkEnvelope(body, target.mode, response.status),
          reverse ? { data: [] } : { message: "SMTP test failed." },
        );
      }
      assert.equal(relay.authenticated(), reverse ? 1 : 0);
      assert.equal(relay.loginReplies(), reverse ? 2 : 0);
      const query = new URLSearchParams({ query: `to:${to}`, limit: "100" });
      const intake = asBody<{ messages: Array<unknown> }>(
        await (await fetch(`${sink.api}/api/v1/search?${query}`)).json(),
      );
      assert.equal(intake.messages.length, reverse ? 1 : 0);
    } finally {
      await relay.close();
    }
  }
  // Source-first AUTH regression: configured authentication cannot become a send without login.
  for (const protocol of ["plain", "login", "cram"]) {
    const to = `${protocol}-${recipient}`;
    const failed = await request(
      JSON.stringify({
        email: to,
        host: sink.host,
        port: sink.port,
        auth_protocol: protocol,
        username: "m21-fixture-user",
        password: "m21-fixture-password",
        tls_type: "none",
      }),
    );
    assert.equal(failed.status, 500);
    if (target.mode === "normal") {
      assert.deepEqual(listmonkEnvelope(await failed.json(), target.mode, failed.status), {
        message: "SMTP test failed.",
      });
    }
    const query = new URLSearchParams({ query: `to:${to}`, limit: "100" });
    const intake = asBody<{ messages: Array<unknown> }>(
      await (await fetch(`${sink.api}/api/v1/search?${query}`)).json(),
    );
    assert.equal(intake.messages.length, 0);
    // D51 also refuses an unadvertised selected method, even if the peer would accept it.
    const relay = await faultRelay(sink, "auth", {
      user: "m21-fixture-user",
      password: "m21-fixture-password",
      authMethods: [protocol === "plain" ? "LOGIN" : "PLAIN"],
    });
    try {
      const to = `unsupported-${protocol}-${recipient}`;
      const unsupported = await request(
        JSON.stringify({
          email: to,
          host: sink.host,
          port: relay.port,
          auth_protocol: protocol,
          username: "m21-fixture-user",
          password: "m21-fixture-password",
          tls_type: "none",
        }),
      );
      assert.equal(unsupported.status, target.mode === "normal" ? 500 : 200);
      if (target.mode === "normal") {
        assert.deepEqual(
          listmonkEnvelope(await unsupported.json(), target.mode, unsupported.status),
          {
            message: "SMTP test failed.",
          },
        );
      }
      const query = new URLSearchParams({ query: `to:${to}`, limit: "100" });
      const intake = asBody<{ messages: Array<unknown> }>(
        await (await fetch(`${sink.api}/api/v1/search?${query}`)).json(),
      );
      assert.equal(intake.messages.length, target.mode === "normal" ? 0 : 1);
      assert.equal(relay.authAttempts(), target.mode === "normal" ? 0 : 1);
      assert.equal(relay.authenticated(), target.mode === "normal" ? 0 : 1);
    } finally {
      await relay.close();
    }
  }
  // D51 explicitly pairs upstream's before-DATA abort with native partial acceptance.
  for (const header of ["Cc", "Bcc"]) {
    const relay = await faultRelay(sink, "partial-rcpt");
    const to = `${header.toLowerCase()}-${recipient}`;
    try {
      const partial = await request(
        JSON.stringify({
          email: to,
          host: sink.host,
          port: relay.port,
          auth_protocol: "none",
          tls_type: "none",
          email_headers: [{ [header]: "rejected@example.test" }],
        }),
      );
      assert.equal(partial.status, 500);
      if (target.mode === "normal") {
        assert.deepEqual(listmonkEnvelope(await partial.json(), target.mode, partial.status), {
          message: "SMTP test was accepted for some recipients only.",
        });
      }
      const query = new URLSearchParams({ query: `to:${to}`, limit: "100" });
      const intake = asBody<{ messages: Array<unknown> }>(
        await (await fetch(`${sink.api}/api/v1/search?${query}`)).json(),
      );
      assert.equal(intake.messages.length, target.mode === "normal" ? 1 : 0);
      assert.equal(relay.connections(), 1);
    } finally {
      await relay.close();
    }
  }
  if (target.mode === "normal") {
    const malformed = await request("{");
    assert.equal(malformed.status, 400);
    assert.deepEqual(listmonkEnvelope(await malformed.json(), target.mode, malformed.status), {
      message: "Invalid data.",
    });
    const invalid = await request(JSON.stringify({ email: recipient, host: "", port: 0 }));
    assert.equal(invalid.status, 400);
    assert.deepEqual(listmonkEnvelope(await invalid.json(), target.mode, invalid.status), {
      message: "Invalid SMTP configuration.",
    });
    const refusedSocket = createServer();
    await new Promise<void>((resolve, reject) => {
      refusedSocket.once("error", reject);
      refusedSocket.listen(0, "127.0.0.1", resolve);
    });
    const address = refusedSocket.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing refusal port");
    }
    const refusedPort = address.port;
    await new Promise<void>((resolve, reject) => {
      refusedSocket.close((error) => (error ? reject(error) : resolve()));
    });
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
    assert.deepEqual(listmonkEnvelope(await refused.json(), target.mode, refused.status), {
      message: "SMTP test failed.",
    });
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
        assert.deepEqual(listmonkEnvelope(await failed.json(), target.mode, failed.status), {
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
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Held SMTP tests did not connect")), 4000);
        }),
      ]);
      const overflow = await request(body);
      assert.equal(overflow.status, 429);
      assert.deepEqual(listmonkEnvelope(await overflow.json(), target.mode, overflow.status), {
        message: "Too many SMTP tests in progress.",
      });
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
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("SMTP final barrier failed")), 4000);
          }),
        ]);
        const restarting = target.restart();
        const outcome = await pending;
        assert.equal(outcome.status, 500);
        assert.deepEqual(listmonkEnvelope(await outcome.json(), target.mode, outcome.status), {
          message: "SMTP test outcome is unknown.",
        });
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
    if (process.argv[2] !== "reference") {
      throw new Error("Invalid mode");
    }
    const {
      REFERENCE_URL: baseUrl,
      REFERENCE_API_USER: user,
      REFERENCE_API_TOKEN: token,
    } = process.env;
    if (!baseUrl || !user || !token) {
      throw new Error("Missing reference credentials");
    }
    await runMessagingContract({ mode: "reference", baseUrl, credentials: { user, token } });
  } catch {
    process.stderr.write("Messaging contract failed\n");
    process.exitCode = 1;
  }
}
