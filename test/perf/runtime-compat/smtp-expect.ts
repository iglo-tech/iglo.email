// Expected observable Mailpit responses for the synthetic SMTP probe.
// Comparison: listmonk internal/messenger/email/email.go and models/messages.go.
import assert from "node:assert/strict";

export const binaryBytes = Buffer.from([0, 1, 2, 13, 10, 127, 128, 255]);
export const inlineBytes = Buffer.from([137, 80, 78, 71, 0, 42, 255]);
export const plainBody = "Plain fixture: Zażółć & hello.\r\n";
export const htmlBody = '<p>Hello Zażółć &amp; world</p><img src="cid:fixture-image">';
export const alternateBody = "Alternative: Zażółć & world";
export interface CapturedMessage {
  ID: string;
  MessageID: string;
  Subject: string;
  Text: string;
  HTML: string;
  ReturnPath: string;
  To: Array<{ Address: string }>;
  Cc: Array<{ Address: string }>;
  Attachments: Array<{ FileName: string; PartID: string }>;
  Inline: Array<{ FileName: string; PartID: string; ContentID: string }>;
}
export function headers(raw: string) {
  const header = raw.split("\r\n\r\n", 1)[0];
  assert.ok(header, "missing RFC 5322 header block");
  return header.replace(/\r\n[ \t]+/g, " ").split("\r\n");
}
export function header(raw: string, name: string) {
  const matches = headers(raw).filter((line) =>
    line.toLowerCase().startsWith(`${name.toLowerCase()}:`),
  );
  assert.equal(matches.length, 1, `expected exactly one ${name} header`);
  return matches[0]!.slice(matches[0]!.indexOf(":") + 1).trim();
}
export function expectMessageId(raw: string, expected: string) {
  assert.equal(header(raw, "Message-ID"), expected);
}
export function expectPlain(message: CapturedMessage, raw: string, id: string, marker: string) {
  expectMessageId(raw, id);
  assert.equal(message.Subject, `${marker} plain`);
  assert.equal(message.Text.replace(/\r?\n/g, "\r\n"), plainBody);
  assert.equal(header(raw, "X-Fixture"), marker);
  assert.match(header(raw, "Content-Type"), /^text\/plain/i);
}
export async function expectHtml(
  message: CapturedMessage,
  raw: string,
  id: string,
  marker: string,
  readPart: (partId: string) => Promise<Buffer>,
) {
  expectMessageId(raw, id);
  assert.equal(message.Subject, `${marker} html`);
  assert.equal(message.Text.trim(), alternateBody);
  assert.equal(message.HTML.trim(), htmlBody);
  assert.equal(message.ReturnPath.replace(/[<>]/g, ""), "bounce@example.test");
  assert.deepEqual(
    message.To.map((x) => x.Address),
    ["visible@example.test"],
  );
  assert.deepEqual(
    message.Cc.map((x) => x.Address),
    ["copy@example.test"],
  );
  assert.equal(header(raw, "X-Fixture"), marker);
  assert.match(header(raw, "Content-Type"), /^multipart\/mixed/i);
  // Mailpit v1.32.0 synthesizes Bcc from envelope-only recipients when storing.
  assert.equal(header(raw, "Bcc"), "hidden@example.test");
  const attachment = message.Attachments.find((item) => item.FileName === "fixture.bin");
  const inline = message.Inline.find((item) => item.FileName === "inline.bin");
  assert.ok(attachment, "binary attachment missing");
  assert.ok(inline, "inline attachment missing");
  assert.equal(inline.ContentID.replace(/[<>]/g, ""), "fixture-image");
  assert.deepEqual(await readPart(attachment.PartID), binaryBytes);
  assert.deepEqual(await readPart(inline.PartID), inlineBytes);
}
