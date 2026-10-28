// Synthetic non-pooled baseline for listmonk internal/messenger/email/email.go.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import {
  assertOwnedMailpit,
  referenceMailpit,
  type ReferenceMailpit,
} from "@/test/perf/runtime-compat/smtp-env";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import {
  alternateBody,
  binaryBytes,
  expectHtml,
  expectPlain,
  headers,
  htmlBody,
  inlineBytes,
  plainBody,
} from "@/test/perf/runtime-compat/smtp-expect";
import { verifyFixtureDkim } from "@/test/perf/runtime-compat/dkim-check";

export async function control(reference: ReferenceMailpit, pooled = false) {
  await assertOwnedMailpit(reference);
  const marker = `m08${reference.runId.replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
  const mailpit = new Mailpit(reference, marker);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const transport = nodemailer.createTransport({
    ...(pooled ? { pool: true as const, maxConnections: 2, maxMessages: 5, maxRequeues: 0 } : {}),
    host: reference.host,
    port: reference.port,
    secure: false,
    ignoreTLS: true,
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 5000,
    socketTimeout: 10000,
  });
  const expectedPlain = `<${marker}.plain@example.test>`;
  const expectedHtml = `<${marker}.html@example.test>`;
  try {
    const common = {
      from: "Fixture <sender@example.test>",
      to: "visible@example.test",
      headers: { "X-Fixture": marker },
    };
    // Public stream plugin observes the SMTP transport's generated MIME before signing.
    let outgoingBccAbsent = false;
    transport.use("stream", (mail, done) => {
      if (mail.data.subject !== `${marker} html`) {
        done();
        return;
      }
      const chunks: Buffer[] = [];
      const stream = mail.message.createReadStream();
      stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.once("error", done);
      stream.once("end", () => {
        outgoingBccAbsent = !headers(Buffer.concat(chunks).toString()).some((line) =>
          /^bcc:/i.test(line),
        );
        done(outgoingBccAbsent ? undefined : new Error("Bcc leaked into outgoing MIME"));
      });
    });
    const plain = await transport.sendMail({
      ...common,
      subject: `${marker} plain`,
      text: plainBody,
      messageId: expectedPlain,
    });
    const html = await transport.sendMail({
      ...common,
      subject: `${marker} html`,
      text: alternateBody,
      html: htmlBody,
      cc: "copy@example.test",
      bcc: "hidden@example.test",
      envelope: {
        from: "bounce@example.test",
        to: ["visible@example.test", "copy@example.test", "hidden@example.test"],
      },
      messageId: expectedHtml,
      dkim: { domainName: "fixture.example.test", keySelector: "m08", privateKey },
      attachments: [
        { filename: "fixture.bin", content: binaryBytes, contentType: "application/octet-stream" },
        {
          filename: "inline.bin",
          content: inlineBytes,
          cid: "fixture-image",
          contentType: "image/png",
        },
      ],
    });
    const automatic = await transport.sendMail({
      ...common,
      subject: `${marker} automatic`,
      text: "Generated ID",
    });
    assert.ok(outgoingBccAbsent);
    assert.equal(plain.messageId, expectedPlain);
    assert.equal(html.messageId, expectedHtml);
    assert.deepEqual([...html.accepted].sort(), [
      "copy@example.test",
      "hidden@example.test",
      "visible@example.test",
    ]);
    assert.deepEqual(html.rejected, []);
    assert.equal(html.envelope.from, "bounce@example.test");
    assert.deepEqual([...html.envelope.to].sort(), [
      "copy@example.test",
      "hidden@example.test",
      "visible@example.test",
    ]);
    const messages = await mailpit.list();
    assert.equal(messages.length, 3);
    const bySubject = (suffix: string) => {
      const found = messages.find((message) => message.Subject === `${marker} ${suffix}`);
      assert.ok(found);
      return found;
    };
    const plainId = bySubject("plain").ID;
    const htmlId = bySubject("html").ID;
    const autoId = bySubject("automatic").ID;
    expectPlain(await mailpit.message(plainId), await mailpit.raw(plainId), expectedPlain, marker);
    const raw = await mailpit.raw(htmlId);
    await expectHtml(await mailpit.message(htmlId), raw, expectedHtml, marker, (part) =>
      mailpit.part(htmlId, part),
    );
    const crypto = await import("node:crypto");
    const key = crypto.createPublicKey(publicKey);
    assert.ok(verifyFixtureDkim(raw, key), "DKIM signature/body verification failed");
    assert.ok(
      !verifyFixtureDkim(`${raw}corruption`, key),
      "DKIM negative control unexpectedly passed",
    );
    assert.equal(
      (await mailpit.raw(autoId)).match(/^Message-ID:\s*(.+)$/im)?.[1]?.trim(),
      automatic.messageId,
    );
    assert.notEqual(automatic.messageId, expectedHtml);
    return {
      accepted: html.accepted,
      rejected: html.rejected,
      response: html.response,
      envelope: html.envelope,
      predeterminedIds: 2,
      automaticId: automatic.messageId.replace(/<.*@/, "<generated@"),
      dkim: "verified, corruption rejected",
      outgoingBcc: "absent in SMTP stream plugin; reconstructed by Mailpit",
      messages: messages.length,
    };
  } finally {
    transport.close();
    await mailpit.removeOwned();
  }
}
if (import.meta.main) console.log(JSON.stringify(await control(referenceMailpit(process.env))));
