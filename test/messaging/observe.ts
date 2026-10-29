// Labelled test-only caller of the production messaging owner, not a production route.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, createPublicKey } from "node:crypto";
import { createEmailer, type SMTPServer, type Message } from "@/messaging/email";
import { createRealClock } from "@/clock";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import {
  binaryBytes,
  inlineBytes,
  htmlBody,
  alternateBody,
  expectHtml,
  header,
} from "@/test/perf/runtime-compat/smtp-expect";
import { verifyFixtureDkim } from "@/test/perf/runtime-compat/dkim-check";

const reference = referenceMailpit(process.env);
await assertOwnedMailpit(reference);
const marker = `m08${reference.runId.replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
const mailpit = new Mailpit(reference, marker);
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const server: SMTPServer = {
  uuid: "fixture",
  name: "email-fixture",
  enabled: true,
  exclude_from_default: false,
  host: reference.host,
  port: reference.port,
  hello_hostname: "fixture.test",
  max_conns: 2,
  idle_timeout: "2s",
  wait_timeout: "2s",
  auth_protocol: "none",
  username: "",
  tls_type: "none",
  tls_skip_verify: false,
  email_headers: [
    JSON.parse(
      '{"X-Fixture":"overridden","__proto__":"owned-header","constructor":"own-constructor"}',
    ),
  ],
  from_addresses: ["sender@example.test"],
  dkim: { domain_name: "fixture.example.test", key_selector: "m08", private_key: privateKey },
};
let servers = [server];
const emailer = createEmailer({
  settings: () => ({ smtp: servers, rootUrl: "https://example.test" }),
  clock: createRealClock(),
  select: () => 0,
});
try {
  const body = Buffer.from(htmlBody);
  const m: Message = {
    from: "Fixture <sender@example.test>",
    to: ["visible@example.test"],
    subject: `${marker} html`,
    contentType: "html",
    body,
    altBody: Buffer.from(alternateBody),
    headers: {
      "X-Fixture": marker,
      "Return-Path": "bounce@example.test",
      Cc: "copy@example.test",
      Bcc: "hidden@example.test",
    },
    attachments: [
      {
        name: "fixture.bin",
        content: Buffer.from(binaryBytes),
        contentType: "application/octet-stream",
      },
      {
        name: "inline.bin",
        content: Buffer.from(inlineBytes),
        cid: "fixture-image",
        inline: true,
        contentType: "image/png",
      },
    ],
  };
  const dispatch = emailer.push(m);
  assert.match(dispatch.messageId, /^<[^@]+@example\.test>$/);
  body.fill(0);
  m.attachments![0]!.content.fill(0);
  m.headers!["X-Fixture"] = "changed";
  const result = await dispatch.result;
  assert.equal(result.status, "accepted");
  assert.deepEqual(result.accepted.sort(), [
    "copy@example.test",
    "hidden@example.test",
    "visible@example.test",
  ]);
  assert.deepEqual(result.rejected, []);
  const messages = await mailpit.list();
  assert.equal(messages.length, 1);
  const captured = await mailpit.message(messages[0]!.ID);
  const raw = await mailpit.raw(messages[0]!.ID);
  assert.match(raw, /(?:^|\r\n)__proto__: owned-header/i);
  assert.match(raw, /(?:^|\r\n)constructor: own-constructor/i);
  await expectHtml(captured, raw, dispatch.messageId, marker, (part) =>
    mailpit.part(messages[0]!.ID, part),
  );
  assert.equal(verifyFixtureDkim(raw, createPublicKey(publicKey)), true);
  assert.equal(verifyFixtureDkim(raw.replace("Hello", "Hella"), createPublicKey(publicKey)), false);
  servers = [
    {
      ...server,
      email_headers: [
        {
          From: "server@example.test",
          To: "server-visible@example.test",
          Subject: `${marker} server`,
          "X-Precedence": "server",
        },
      ],
    },
  ];
  const overridden = emailer.push({
    from: "envelope@example.test",
    to: ["actual@example.test"],
    subject: `${marker} input`,
    contentType: "plain",
    body: Buffer.from("precedence"),
    headers: {
      From: "message@example.test",
      To: "message-visible@example.test",
      Subject: `${marker} override`,
      "X-Precedence": "message",
    },
  });
  assert.equal((await overridden.result).status, "accepted");
  const selected = (await mailpit.list()).find((item) => item.Subject === `${marker} override`);
  assert.ok(selected);
  const overriddenRaw = await mailpit.raw(selected.ID);
  assert.match(header(overriddenRaw, "From"), /message@example\.test/);
  assert.match(header(overriddenRaw, "To"), /message-visible@example\.test/);
  assert.equal(header(overriddenRaw, "X-Precedence"), "message");
  const visible = await mailpit.message(selected.ID);
  assert.equal(visible.ReturnPath.replace(/[<>]/g, ""), "envelope@example.test");
  servers = [{ ...server, enabled: false }];
  const disabled = emailer.push({ ...m, subject: `${marker} disabled` });
  assert.equal((await disabled.result).status, "proven-not-accepted");
  servers = [{ ...server, exclude_from_default: true }];
  assert.equal(
    (await emailer.push({ ...m, subject: `${marker} excluded` }).result).status,
    "proven-not-accepted",
  );
  assert.equal(
    (await emailer.push({ ...m, messenger: "email-fixture", subject: `${marker} named` }).result)
      .status,
    "accepted",
  );
  servers = [
    { ...server, name: "fallback", from_addresses: [], email_headers: [{ "X-Route": "fallback" }] },
    {
      ...server,
      name: "domain",
      from_addresses: ["route.test"],
      email_headers: [{ "X-Route": "domain" }],
    },
    {
      ...server,
      name: "exact",
      from_addresses: ["exact@route.test"],
      email_headers: [{ "X-Route": "exact" }],
    },
    {
      ...server,
      name: "private",
      exclude_from_default: true,
      from_addresses: ["exact@route.test"],
      email_headers: [{ "X-Route": "private" }],
    },
  ];
  for (const [label, from, messenger, route] of [
    ["exact", "Exact <exact@route.test>", "", "exact"],
    ["domain", "other@route.test", "", "domain"],
    ["fallback", "other@else.test", "", "fallback"],
    ["private", "exact@route.test", "private", "private"],
  ]) {
    const sent = emailer.push({
      from: from!,
      to: ["recipient@example.test"],
      subject: `${marker} route-${label}`,
      contentType: "plain",
      body: Buffer.from("route"),
      ...(messenger ? { messenger } : {}),
    });
    assert.equal((await sent.result).status, "accepted");
    const found = (await mailpit.list()).find(
      (entry) => entry.Subject === `${marker} route-${label}`,
    );
    assert.ok(found);
    assert.equal(header(await mailpit.raw(found.ID), "X-Route"), route);
  }
  const injection = emailer.push({
    from: "sender@example.test",
    to: ["recipient@example.test"],
    subject: `${marker} injection`,
    contentType: "plain",
    body: Buffer.from("test"),
    headers: { "X-Test": "value\r\nInjected: yes" },
  });
  assert.equal((await injection.result).status, "proven-not-accepted");
  assert.equal((await mailpit.list()).length, 7);
} finally {
  await emailer.close();
  await mailpit.removeOwned();
}
