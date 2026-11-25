// A dispatcher with one project's sender, for tests and measurements that wire messaging without an
// instance (B141). Its shape is the emailer's from before the dispatcher, so a fixture that built
// `createEmailer({ settings, clock, … })` builds this instead: `push` and `test` go through the
// sender, and `close` stops the whole dispatcher and drains its pools.
import type { Clock } from "@/clock";
import { createDispatcher } from "@/messaging/dispatcher";
import type { DispatcherOptions, Grant, Sender } from "@/messaging/dispatcher";
import type { Message, SMTPServer } from "@/messaging/email";

export interface FixtureEmailerOptions {
  clock: Clock;
  /** The SMTP servers and the root URL whose host names generated Message-IDs. */
  settings: () => { smtp: Array<SMTPServer>; rootUrl: string };
  /** messaging.max_send_rate; unpaced (0) by default. */
  rate?: () => number;
  copyAllowed?: (address: string) => boolean;
  refuse?: () => void;
  select?: (count: number) => number;
  id?: () => string;
  held?: () => boolean;
  onStart?: DispatcherOptions["onStart"];
}

export function fixtureEmailer(options: FixtureEmailerOptions) {
  const dispatcher = createDispatcher({
    clock: options.clock,
    smtp: () => options.settings().smtp,
    rate: options.rate ?? (() => 0),
    ...(options.held ? { held: options.held } : {}),
    ...(options.onStart ? { onStart: options.onStart } : {}),
    ...(options.select ? { select: options.select } : {}),
    ...(options.id ? { id: options.id } : {}),
  });
  const sender: Sender = dispatcher.sender({
    rootUrl: () => options.settings().rootUrl,
    copyAllowed: options.copyAllowed ?? (() => true),
    refuse: options.refuse ?? (() => {}),
  });
  return {
    dispatcher,
    sender,
    push: (message: Message, delivery?: Parameters<Sender["push"]>[1]) =>
      sender.push(message, delivery),
    test: (server: SMTPServer, message: Message, rootUrl: string) =>
      sender.test(server, message, rootUrl),
    request: sender.request,
    get closed() {
      return sender.closed;
    },
    close: () => dispatcher.close(),
  };
}
export type FixtureEmailer = ReturnType<typeof fixtureEmailer>;

/**
 * A grant of `count` slots for a fake sender: a test that stands in for the dispatcher grants what
 * it chooses, and a push with it uses one slot.
 */
export function fixtureGrant(count: number): Grant & { use(): void } {
  let left = Math.max(0, Math.floor(count));
  return {
    get count() {
      return left;
    },
    keep(n: number) {
      left = Math.min(left, Math.max(0, Math.floor(n)));
    },
    release() {
      left = 0;
    },
    use() {
      left = Math.max(0, left - 1);
    },
  };
}

/** An SMTP server entry for the test sink on `port` (test/tx/sink.ts): loopback, no auth, no TLS. */
export function sinkServer(port: number): SMTPServer {
  return {
    name: "sink",
    enabled: true,
    exclude_from_default: false,
    host: "127.0.0.1",
    port,
    hello_hostname: "fixture.test",
    max_conns: 10,
    idle_timeout: "2s",
    wait_timeout: "2s",
    auth_protocol: "none",
    username: "",
    tls_type: "none",
    tls_skip_verify: false,
    email_headers: [],
    from_addresses: [],
  };
}

/** A one-recipient message to `to`. */
export function sinkMessage(to: string, subject = "s"): Message {
  return {
    from: "sender@example.test",
    to: [to],
    subject,
    contentType: "plain",
    body: Buffer.from("body"),
  };
}
