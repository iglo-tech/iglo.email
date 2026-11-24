// B120 r1 (D118), through the compiled executable and its loopback SMTP sink: the reviewer's
// reproductions. Each message is read as the sink received it, and its text part is decoded.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  apiClient,
  buildExecutable,
  provisionAuthorization,
  removeDirectory,
  startServer,
  temporaryDirectory,
} from "@/test/backup/fixture";
import { textPart } from "@/test/messaging/mime";
import { startSink } from "@/test/tx/sink";
import { asBody, readJson } from "@/test/read-body";
import { untilState } from "@/test/wait";

setDefaultTimeout(120_000);

let build = "";
let executable = "";
beforeAll(async () => {
  build = temporaryDirectory();
  executable = await buildExecutable(build);
});
afterAll(() => removeDirectory(build));

/**
 * Polls `read` until it returns a value. There is no progress signal beyond the value itself, so
 * the wait's 20 s limit is a stall window on that (B118d sweep).
 */
async function waitFor<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  let value: T | undefined;
  await untilState(async () => (value = await read()) !== undefined, {
    label: `timed out waiting for ${what}`,
    progress: () => (value === undefined ? "unread" : "read"),
    stallMs: 20_000,
    intervalMs: 25,
  });
  if (value === undefined) {
    throw new Error(`timed out waiting for ${what}`);
  }
  return value;
}

/** A running executable with its SMTP server pointed at a sink, and a client for its API. */
async function stack() {
  const base = temporaryDirectory();
  const sink = await startSink();
  const server = await startServer(executable, join(base, "data"));
  const client = apiClient(server.origin, await provisionAuthorization(server.origin));
  const call = (path: string, method = "GET", body?: unknown) =>
    body === undefined
      ? client(path, { method })
      : client(path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
  const seeded = (await readJson<{ data: Record<string, any> }>(await call("/api/settings"))).data;
  const smtp = asBody<Array<Record<string, unknown>>>(seeded.smtp).map((item, index) =>
    index === 0
      ? { ...item, host: "127.0.0.1", port: sink.port, tls_type: "none", auth_protocol: "none" }
      : item,
  );
  expect((await call("/api/settings/smtp", "PUT", smtp)).status).toBe(200);
  return {
    sink,
    call,
    origin: server.origin,
    async close() {
      await server.stop();
      await sink.close();
      removeDirectory(base);
    },
  };
}

/** The text part of the first message the sink received to `address`, once it has arrived. */
function textTo(s: Awaited<ReturnType<typeof stack>>, address: string, subject?: string) {
  return waitFor(
    async () =>
      s.sink.messages.find(
        (m) => m.to.includes(address) && (subject === undefined || m.data.includes(subject)),
      )?.data,
    `a message to ${address}`,
  ).then((data) => textPart(data));
}

test("the password reset link in the text part decodes &amp; to & (the reviewer's reset probe)", async () => {
  const s = await stack();
  try {
    const address = "reset-user@example.test";
    const created = await s.call("/api/users", "POST", {
      username: "reset-user",
      email: address,
      name: "Reset User",
      password: "reset-test-password-1",
      password_login: true,
      type: "user",
      status: "enabled",
      user_role_id: 1,
    });
    expect(created.status).toBe(200);
    const forgot = await fetch(`${s.origin}/admin/forgot`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: address }),
    });
    expect(forgot.status).toBe(200);
    const text = await textTo(s, address);
    const link = /https?:\/\/\S+\/admin\/reset\?\S+/.exec(text ?? "")?.[0] ?? "";
    expect(link).toContain("?token=");
    expect(link).toContain("&email=reset-user%40example.test");
    expect(link).not.toContain("&amp;");
  } finally {
    await s.close();
  }
});

test("a tx template link built from data keeps its & after the HTML escape: text reads Verify <URL>", async () => {
  const s = await stack();
  try {
    const template = await s.call("/api/templates", "POST", {
      name: "verify",
      type: "tx",
      subject: "Verify",
      body: '<p><a href="{{ data.url }}">Verify</a></p>',
    });
    expect(template.status).toBe(200);
    const id = (await readJson<{ data: { id: number } }>(template)).data.id;
    const sent = await s.call("/api/tx", "POST", {
      subscriber_mode: "external",
      subscriber_emails: ["verify@example.test"],
      template_id: id,
      data: { url: "https://app.example.test/verify?token=abc&email=ada%40example.test" },
    });
    expect(sent.status).toBe(200);
    const text = await textTo(s, "verify@example.test");
    expect(text).toContain(
      "Verify <https://app.example.test/verify?token=abc&email=ada%40example.test>",
    );
  } finally {
    await s.close();
  }
});

test("a multi-list double opt-in mail keeps both list parameters, with & not &amp;", async () => {
  const s = await stack();
  try {
    const lists: Array<number> = [];
    for (const name of ["Alpha", "Beta"]) {
      const list = await s.call("/api/lists", "POST", { name, type: "public", optin: "double" });
      lists.push((await readJson<{ data: { id: number } }>(list)).data.id);
    }
    const created = await s.call("/api/subscribers", "POST", {
      email: "ada-optin@example.test",
      name: "Ada",
      lists,
      status: "enabled",
    });
    expect(created.status).toBe(200);
    const text = await textTo(s, "ada-optin@example.test");
    const link = /https?:\/\/\S+\/subscription\/optin\/\S+/.exec(text ?? "")?.[0] ?? "";
    // The query carries one list parameter per list: `?l=…&l=…`.
    expect(link.match(/[?&]l=/g)?.length).toBe(2);
    expect(link).not.toContain("&amp;");
  } finally {
    await s.close();
  }
});

test("a Markdown campaign link with two query parameters reads with & in the text part", async () => {
  const s = await stack();
  try {
    const list = await s.call("/api/lists", "POST", {
      name: "News",
      type: "public",
      optin: "single",
    });
    const listId = (await readJson<{ data: { id: number } }>(list)).data.id;
    await s.call("/api/subscribers", "POST", {
      email: "ada-md@example.test",
      name: "Ada",
      lists: [listId],
      status: "enabled",
    });
    const campaign = await s.call("/api/campaigns", "POST", {
      name: "Sale",
      subject: "Sale",
      lists: [listId],
      type: "regular",
      content_type: "markdown",
      body: "[the sale](https://shop.example/sale?utm_source=news&utm_medium=email)",
    });
    const id = (await readJson<{ data: { id: number } }>(campaign)).data.id;
    const sent = await s.call(`/api/campaigns/${id}/test`, "POST", {
      name: "Sale",
      subject: "Sale",
      lists: [listId],
      messenger: "email",
      content_type: "markdown",
      body: "[the sale](https://shop.example/sale?utm_source=news&utm_medium=email)",
      subscribers: ["ada-md@example.test"],
    });
    expect(sent.status).toBe(200);
    const text = await textTo(s, "ada-md@example.test");
    expect(text).toContain("the sale <https://shop.example/sale?utm_source=news&utm_medium=email>");
  } finally {
    await s.close();
  }
});

test("a 14 KB template that renders to 840 KB converts promptly, and /health answers after it", async () => {
  const s = await stack();
  try {
    // The review's shape: 60 loops of 1000 links opened, then 60 loops of 1000 links closed.
    const body =
      "{% for i in (1..60) %}" +
      '<a href="x">'.repeat(1000) +
      "{% endfor %}t{% for i in (1..60) %}" +
      "</a>".repeat(1000) +
      "{% endfor %}";
    const template = await s.call("/api/templates", "POST", {
      name: "nested",
      type: "tx",
      subject: "Nested",
      body,
    });
    expect(template.status).toBe(200);
    const id = (await readJson<{ data: { id: number } }>(template)).data.id;
    const started = performance.now();
    const sent = await s.call("/api/tx", "POST", {
      subscriber_mode: "external",
      subscriber_emails: ["nested@example.test"],
      template_id: id,
    });
    expect(sent.status).toBe(200);
    const health = await s.call("/health");
    expect(health.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(10_000);
    // Past the 1024 cap on open elements (D118 r4): the message sends its HTML with no text part.
    expect(await textTo(s, "nested@example.test")).toBeUndefined();
  } finally {
    await s.close();
  }
});

// r2 B1: the reviewer's 7 KB template that renders to about 1 MB of nested <b>. The send is in flight
// when /health is asked, and /health must answer in less than half the time the send takes (B118j
// item 4: a comparison within the run, not a second on the host). Mutation: remove the handler cap in
// the converter; /health then waits for the conversion, and the comparison fails.
test("a 7 KB template that renders to 1 MB does not hold /health for half of its own send", async () => {
  const s = await stack();
  try {
    const body =
      "{% for i in (1..145) %}" +
      "<b>".repeat(1000) +
      "{% endfor %}t{% for i in (1..145) %}" +
      "</b>".repeat(1000) +
      "{% endfor %}";
    const template = await s.call("/api/templates", "POST", {
      name: "nested-bold",
      type: "tx",
      subject: "Nested",
      body,
    });
    expect(template.status).toBe(200);
    const id = (await readJson<{ data: { id: number } }>(template)).data.id;
    const sendStarted = performance.now();
    let sendMs = 0;
    const sending = s
      .call("/api/tx", "POST", {
        subscriber_mode: "external",
        subscriber_emails: ["bold@example.test"],
        template_id: id,
      })
      .then((response) => {
        sendMs = performance.now() - sendStarted;
        return response;
      });
    await Bun.sleep(300);
    const asked = performance.now();
    const health = await s.call("/health");
    const healthMs = performance.now() - asked;
    expect(health.status).toBe(200);
    expect((await sending).status).toBe(200);
    // B118j item 4: a comparison inside the run, as the 12 KB test below (B118c item 3). /health must
    // answer in less than half the time the same send takes.
    expect(healthMs).toBeLessThan(sendMs / 2);
    // Past the 1024 cap on open elements (D118 r4): the message sends its HTML with no text part.
    expect(await textTo(s, "bold@example.test")).toBeUndefined();
  } finally {
    await s.close();
  }
});

// r3 B1: the reviewer's 12 KB template of unclosed <p> elements, which renders to about 1 MB. The
// conversion gives up at its handler cap, so /health must not wait for it, and the message still
// sends its HTML with no text part.
// B118c item 3: the bound is a comparison inside the run, not 200 ms on the host. /health must answer
// in less than half the time the same send takes; a server that waits for the conversion answers
// only when the send is nearly over. The 300 ms wait lets the send reach its conversion first.
// Mutation: remove the handler cap in the converter; /health then waits for the conversion, and the
// comparison fails.
test("a 12 KB template of unclosed <p> elements does not hold /health for half of its own send, and sends its HTML", async () => {
  const s = await stack();
  try {
    const body = "{% for i in (1..85) %}" + "<p>x<b>y</b>".repeat(1000) + "{% endfor %}";
    const template = await s.call("/api/templates", "POST", {
      name: "unclosed-p",
      type: "tx",
      subject: "Unclosed",
      body,
    });
    expect(template.status).toBe(200);
    const id = (await readJson<{ data: { id: number } }>(template)).data.id;
    const sendStarted = performance.now();
    let sendMs = 0;
    const sending = s
      .call("/api/tx", "POST", {
        subscriber_mode: "external",
        subscriber_emails: ["unclosed@example.test"],
        template_id: id,
      })
      .then((response) => {
        sendMs = performance.now() - sendStarted;
        return response;
      });
    await Bun.sleep(300);
    const asked = performance.now();
    const health = await s.call("/health");
    const healthMs = performance.now() - asked;
    expect(health.status).toBe(200);
    expect((await sending).status).toBe(200);
    expect(healthMs).toBeLessThan(sendMs / 2);
    const mail = await waitFor(
      async () => s.sink.messages.find((m) => m.to.includes("unclosed@example.test")),
      "the unclosed-p mail",
    );
    expect(mail.data).toContain("text/html");
    expect(mail.data).not.toContain("text/plain");
  } finally {
    await s.close();
  }
});

// r4 B1: the reviewer's 11 KB template of unclosed spans with stray end tags, which renders to about
// 1 MB. Each stray end tag searched every open element, so /health waited for the conversion; now the
// cap on open elements stops it, /health answers within 200 ms, and the message sends its HTML.
test("an 11 KB template of unclosed spans with stray end tags does not delay /health by more than 200 ms", async () => {
  const s = await stack();
  try {
    const body = "{% for i in (1..95) %}" + "<span>x</q>".repeat(1000) + "{% endfor %}";
    const template = await s.call("/api/templates", "POST", {
      name: "stray-span",
      type: "tx",
      subject: "Stray",
      body,
    });
    expect(template.status).toBe(200);
    const id = (await readJson<{ data: { id: number } }>(template)).data.id;
    const sending = s.call("/api/tx", "POST", {
      subscriber_mode: "external",
      subscriber_emails: ["stray@example.test"],
      template_id: id,
    });
    await Bun.sleep(300);
    const asked = performance.now();
    const health = await s.call("/health");
    expect(health.status).toBe(200);
    expect(performance.now() - asked).toBeLessThan(200);
    expect((await sending).status).toBe(200);
    const mail = await waitFor(
      async () => s.sink.messages.find((m) => m.to.includes("stray@example.test")),
      "the stray-span mail",
    );
    expect(mail.data).toContain("text/html");
    expect(mail.data).not.toContain("text/plain");
  } finally {
    await s.close();
  }
});

test("a fragment with self-closing SVG and MathML sends, with or without a text part", async () => {
  const s = await stack();
  try {
    const template = await s.call("/api/templates", "POST", {
      name: "svg",
      type: "tx",
      subject: "Svg",
      body: '<svg><title/></svg><svg style="display:none"/><math><a href="x"/></math>visible',
    });
    const id = (await readJson<{ data: { id: number } }>(template)).data.id;
    const sent = await s.call("/api/tx", "POST", {
      subscriber_mode: "external",
      subscriber_emails: ["svg@example.test"],
      template_id: id,
    });
    expect(sent.status).toBe(200);
    await waitFor(async () => (s.sink.messages.length >= 1 ? true : undefined), "the mail");
    expect(s.sink.messages[0]!.data).toContain("text/html");
  } finally {
    await s.close();
  }
});
