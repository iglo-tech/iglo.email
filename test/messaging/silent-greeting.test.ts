// B118a item 3: an SMTP server that accepts the connection and never greets. Nothing is written to
// it, because a client writes nothing before the greeting, so the message cannot have been accepted:
// the outcome is proven not sent, and a transactional send may retry. Real time passes here: the
// greeting timeout is nodemailer's own timer, not the injected clock.
import { expect, test } from "bun:test";
import { createEmailer } from "@/messaging/email";
import { silentServer } from "@/test/messaging/silent-server";
import { TestClock } from "@/test/server/fixture";

const message = {
  from: "sender@example.test",
  to: ["recipient@example.test"],
  subject: "silent greeting fixture",
  contentType: "plain" as const,
  body: Buffer.from("fixture"),
};

test("a server that never greets: nothing was written, so the send is proven not sent", async () => {
  const silent = await silentServer("1s");
  try {
    const emailer = createEmailer({
      settings: () => ({ smtp: [silent.server], rootUrl: "https://example.test" }),
      clock: new TestClock(),
    });
    const send = emailer.push(message);
    expect(await send.result).toMatchObject({
      messageId: send.messageId,
      status: "proven-not-accepted",
      stage: "setup",
      retry: "transient",
    });
    expect(silent.bytesReceived()).toBe(0);
    await emailer.close();
  } finally {
    await silent.close();
  }
});
