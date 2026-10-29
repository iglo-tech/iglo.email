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
      dkim: { domain_name: "fixture.example.test", key_selector: "m08", private_key: privateKey },
    };
    const send = async (suffix: string, signed: boolean) => {
      const subject = `${marker} ${suffix}`;
      const child = spawn(resolve("dist/messaging-stored-caller"), [], {
        env: { PATH: "", M21_DATA_DIR: target.dataDir, M21_SUBJECT: subject },
        stdio: "ignore",
      });
      const code = await new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("exit", (value) => done(value));
      });
      assert.equal(code, 0);
      const found = (await mailpit.list()).filter((entry) => entry.Subject === subject);
      assert.equal(found.length, 1);
      const raw = await mailpit.raw(found[0]!.ID);
      assert.equal(verifyFixtureDkim(raw, createPublicKey(publicKey)), signed);
      if (signed)
        assert.equal(
          verifyFixtureDkim(
            raw.replace("retained settings fixture", "tampered settings fixture"),
            createPublicKey(publicKey),
          ),
          false,
        );
    };
    assert.equal((await request("/api/settings/smtp", "PUT", servers)).status, 200);
    await send("initial", true);
    const saved = await read();
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
    assert.equal(relay.authenticated(), 3);
  } finally {
    await relay.close();
    await mailpit.removeOwned();
  }
}
