// D50 is a native-only extension; pinned listmonk has no DKIM SMTP field.
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { faultRelay } from "@/test/messaging/fault-relay";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { verifyFixtureDkim } from "@/test/perf/runtime-compat/dkim-check";
import type { Credentials } from "@/test/contract/types";

export async function runDKIMSettings(target: {
  baseUrl: string;
  credentials: Credentials;
  restart: () => Promise<void>;
  dataDir: string;
}) {
  const sink = referenceMailpit(process.env);
  await assertOwnedMailpit(sink);
  const marker = `m08${sink.runId.replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
  const mailpit = new Mailpit(sink, marker);
  const credentials = { user: "m21-fixture-user", password: "m21-fixture-password" };
  const relay = await faultRelay(sink, "auth", credentials);
  try {
    const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
    const request = (path: string, method = "GET", body?: unknown) =>
      fetch(`${target.baseUrl}${path}`, {
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
    const read = async () =>
      ((await (await request("/api/settings")).json()) as { data: Record<string, any> }).data;
    const initial = await read();
    assert.equal(Object.hasOwn(initial.smtp[0], "dkim"), false);
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const servers = structuredClone(initial.smtp);
    for (const item of servers) item.password = "";
    servers[0] = {
      ...servers[0],
      host: sink.host,
      port: relay.port,
      enabled: true,
      exclude_from_default: false,
      auth_protocol: "plain",
      username: credentials.user,
      password: credentials.password,
      tls_type: "none",
      max_conns: 1,
      email_headers: [null],
      dkim: { domain_name: "fixture.example.test", key_selector: "m08", private_key: privateKey },
    };
    const send = async (suffix: string, signed: boolean, verificationKey = publicKey) => {
      for (const mode of ["bun", "compiled"] as const) {
        const subject = `${marker} ${suffix} ${mode}`;
        const child = spawn(
          mode === "bun" ? process.execPath : resolve("dist/messaging-stored-caller"),
          mode === "bun" ? [resolve("test/messaging/stored-caller.ts")] : [],
          {
            env: { PATH: "", M21_DATA_DIR: target.dataDir, M21_SUBJECT: subject },
            stdio: "ignore",
          },
        );
        const code = await new Promise<number | null>((done, reject) => {
          child.once("error", reject);
          child.once("exit", (value) => done(value));
        });
        assert.equal(code, 0);
        const found = (await mailpit.list()).filter((entry) => entry.Subject === subject);
        assert.equal(found.length, 1);
        const raw = await mailpit.raw(found[0]!.ID);
        assert.equal(verifyFixtureDkim(raw, createPublicKey(verificationKey)), signed);
        if (signed)
          assert.equal(
            verifyFixtureDkim(
              raw.replace("retained settings fixture", "tampered settings fixture"),
              createPublicKey(verificationKey),
            ),
            false,
          );
      }
    };
    assert.equal((await request("/api/settings/smtp", "PUT", servers)).status, 200);
    await send("initial", true);
    const saved = await read();
    assert.deepEqual(saved.smtp[0].email_headers, [null]);
    assert.match(saved.smtp[0].dkim.private_key, /^•+$/u);
    assert.notEqual(saved.smtp[0].dkim.private_key, privateKey);
    const retaining = structuredClone(saved.smtp);
    for (const item of retaining) {
      item.password = "";
      if (item.dkim) item.dkim.private_key = "";
    }
    assert.equal((await request("/api/settings/smtp", "PUT", retaining)).status, 200);
    await target.restart();
    assert.deepEqual((await read()).smtp[0].dkim, saved.smtp[0].dkim);
    await send("retained-after-restart", true);
    const invalid = structuredClone(retaining);
    invalid[0].dkim.private_key = "invalid";
    const bad = await request("/api/settings/smtp", "PUT", invalid);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { message: "Invalid DKIM configuration." });
    assert.deepEqual((await read()).smtp[0].dkim, saved.smtp[0].dkim);
    const full = await read();
    for (const key of ["smtp", "messengers", "bounce.mailboxes"])
      for (const item of full[key]) {
        item.password = "";
        if (item.dkim) item.dkim.private_key = "";
      }
    for (const key of ["upload.s3.aws_secret_access_key", "bounce.sendgrid_key"]) full[key] = "";
    for (const [key, field] of [
      ["bounce.azure", "shared_secret"],
      ["bounce.postmark", "password"],
      ["bounce.forwardemail", "key"],
      ["bounce.lettermint", "key"],
      ["security.oidc", "client_secret"],
    ] as const)
      full[key][field] = "";
    full["security.captcha"].hcaptcha.secret = "";
    const baseline = await read();
    const shortKey = generateKeyPairSync("rsa", {
      modulusLength: 1024,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const ecKey = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const encrypted = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: "synthetic-fixture",
      },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const valid = {
      domain_name: "fixture.example.test",
      key_selector: "m08",
      private_key: privateKey,
    };
    const candidates: unknown[] = [
      [],
      "invalid",
      { domain_name: "fixture.example.test" },
      { ...valid, domain_name: "bad domain" },
      { ...valid, key_selector: "-bad" },
      { ...valid, private_key: "not a key" },
      { ...valid, private_key: encrypted },
      { ...valid, private_key: ecKey },
      { ...valid, private_key: shortKey },
      { ...valid, private_key: "x".repeat(16385) },
      { ...valid, private_key: null },
    ];
    for (const candidate of candidates) {
      for (const kind of ["key", "full"]) {
        const snapshot = structuredClone(full);
        snapshot.smtp[0].dkim = candidate;
        snapshot["app.site_name"] = "candidate that must roll back";
        const response = await request(
          kind === "key" ? "/api/settings/smtp" : "/api/settings",
          "PUT",
          kind === "key" ? snapshot.smtp : snapshot,
        );
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { message: "Invalid DKIM configuration." });
        assert.deepEqual(await read(), baseline);
      }
    }
    for (const kind of ["key", "full"]) {
      const snapshot = structuredClone(full);
      snapshot.smtp[0].uuid = crypto.randomUUID();
      snapshot.smtp[0].dkim.private_key = "";
      const response = await request(
        kind === "key" ? "/api/settings/smtp" : "/api/settings",
        "PUT",
        kind === "key" ? snapshot.smtp : snapshot,
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { message: "Invalid DKIM configuration." });
      assert.deepEqual(await read(), baseline);
    }
    full["app.site_name"] = "candidate that must roll back";
    full.smtp[0].dkim.key_selector = "invalid selector";
    const invalidFull = await request("/api/settings", "PUT", full);
    assert.equal(invalidFull.status, 400);
    assert.deepEqual(await invalidFull.json(), { message: "Invalid DKIM configuration." });
    const afterInvalid = await read();
    assert.equal(afterInvalid["app.site_name"], saved["app.site_name"]);
    assert.deepEqual(afterInvalid.smtp[0].dkim, saved.smtp[0].dkim);
    retaining[0].dkim = null;
    assert.equal((await request("/api/settings/smtp", "PUT", retaining)).status, 200);
    assert.equal(Object.hasOwn((await read()).smtp[0], "dkim"), false);
    await send("cleared", false);
    // The final saved entry with a duplicate UUID supplies the retained secret.
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const duplicate = structuredClone(saved.smtp[0]);
    duplicate.password = "";
    duplicate.dkim.private_key = other.privateKey;
    duplicate.enabled = false;
    duplicate.name = "duplicate-secret";
    const first = structuredClone(saved.smtp[0]);
    first.password = "";
    first.dkim.private_key = privateKey;
    assert.equal((await request("/api/settings/smtp", "PUT", [first, duplicate])).status, 200);
    const retainingLast = structuredClone((await read()).smtp[0]);
    retainingLast.password = "";
    retainingLast.dkim.private_key = "";
    assert.equal((await request("/api/settings/smtp", "PUT", [retainingLast])).status, 200);
    await send("last-duplicate", true, other.publicKey);
    assert.equal(relay.authenticated(), 8);
  } finally {
    await relay.close();
    await mailpit.removeOwned();
  }
}
