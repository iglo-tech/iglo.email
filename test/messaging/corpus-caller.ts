// Compiled test-only driver of the production messaging owner, not a TX endpoint.
import assert from "node:assert/strict";
import { createRealClock } from "@/clock";
import { createEmailer, type SMTPServer, type Message } from "@/messaging/email";
const server: SMTPServer = {
  name: "",
  enabled: true,
  exclude_from_default: false,
  host: process.env.MAILPIT_SMTP_HOST!,
  port: Number(process.env.MAILPIT_SMTP_PORT),
  hello_hostname: "",
  max_conns: 1,
  idle_timeout: "2s",
  wait_timeout: "2s",
  auth_protocol: "none",
  username: "",
  tls_type: "none",
  tls_skip_verify: false,
  email_headers: [{ "X-Fixture": "server-default", "X-Server": "server-only" }],
  from_addresses: [],
};
const message = JSON.parse(process.env.M21_MESSAGE!) as Message & {
  binary?: boolean;
  alt?: string;
  inline?: { name: string; cid: string; bytes: string };
};
message.body = Buffer.from(message.body as unknown as string);
if (message.alt) message.altBody = Buffer.from(message.alt);
if (message.binary)
  message.attachments = [
    {
      name: "fixture.bin",
      content: Buffer.from([0, 1, 2, 13, 10, 127, 128, 255]),
      contentType: "application/octet-stream",
    },
  ];
if (message.inline)
  message.attachments = [
    {
      name: message.inline.name,
      content: Buffer.from(message.inline.bytes, "hex"),
      cid: message.inline.cid,
      inline: true,
      contentType: "image/svg+xml",
    },
  ];
const emailer = createEmailer({
  settings: () => ({
    smtp: process.env.M21_SERVERS
      ? (JSON.parse(process.env.M21_SERVERS) as SMTPServer[])
      : [server],
    rootUrl: "https://example.test",
  }),
  clock: createRealClock(),
  select: () => 0,
});
try {
  assert.equal((await emailer.push(message).result).status, "accepted");
} finally {
  await emailer.close();
}
