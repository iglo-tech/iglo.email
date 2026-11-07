import { afterEach, describe, expect, spyOn, test } from "bun:test";
import nodemailer from "nodemailer";
import { createEmailer, type SMTPServer } from "@/messaging/email";
import { TestClock } from "@/test/server/fixture";

// The outbox treats a synchronous throw from `push` as "never reached a pool". Everything
// after the hand-off to a pool must therefore reject `result` instead of throwing.
const server: SMTPServer = {
  name: "fixture",
  enabled: true,
  exclude_from_default: false,
  host: "127.0.0.1",
  port: 9,
  hello_hostname: "fixture.test",
  max_conns: 1,
  idle_timeout: "2s",
  wait_timeout: "2s",
  auth_protocol: "none",
  username: "",
  tls_type: "none",
  tls_skip_verify: false,
  email_headers: [],
  from_addresses: [],
};
const message = {
  from: "sender@example.test",
  to: ["recipient@example.test"],
  subject: "sync throw",
  contentType: "plain" as const,
  body: Buffer.from("fixture"),
};
const restore: Array<() => void> = [];
afterEach(() => {
  for (const fn of restore.splice(0)) fn();
});

describe("emailer failure after pool hand-off", () => {
  test("a synchronous transport failure rejects into an ambiguous result, never throws", async () => {
    const prototype = Object.getPrototypeOf(nodemailer.createTransport({ jsonTransport: true }));
    const spy = spyOn(prototype, "sendMail").mockImplementation(() => {
      throw new Error("transport exploded");
    });
    restore.push(() => spy.mockRestore());
    const emailer = createEmailer({
      settings: () => ({ smtp: [server], rootUrl: "https://example.test" }),
      clock: new TestClock(),
    });
    let dispatch: ReturnType<typeof emailer.push> | undefined;
    expect(() => {
      dispatch = emailer.push(message);
    }).not.toThrow();
    expect(await dispatch!.result).toMatchObject({
      messageId: dispatch!.messageId,
      status: "ambiguous",
    });
    await emailer.close();
  });
});
