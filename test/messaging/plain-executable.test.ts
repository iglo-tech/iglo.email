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

setDefaultTimeout(120_000);

let build = "";
let executable = "";
beforeAll(async () => {
  build = temporaryDirectory();
  executable = await buildExecutable(build);
});
afterAll(() => removeDirectory(build));

/** Polls `read` until it returns a value, for at most 20 s of real time. */
async function waitFor<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
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
  const seeded = ((await (await call("/api/settings")).json()) as { data: any }).data;
  const smtp = seeded.smtp.map((item: Record<string, unknown>, index: number) =>
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
    const id = ((await template.json()) as { data: { id: number } }).data.id;
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
    const lists: number[] = [];
    for (const name of ["Alpha", "Beta"]) {
      const list = await s.call("/api/lists", "POST", { name, type: "public", optin: "double" });
      lists.push(((await list.json()) as { data: { id: number } }).data.id);
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
    const listId = ((await list.json()) as { data: { id: number } }).data.id;
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
    const id = ((await campaign.json()) as { data: { id: number } }).data.id;
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
    const id = ((await template.json()) as { data: { id: number } }).data.id;
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
    const text = await textTo(s, "nested@example.test");
    expect(text).toContain("t");
  } finally {
    await s.close();
  }
});

// r2 B1: the reviewer's 7 KB template that renders to about 1 MB of nested <b>. The send is in flight
// when /health is asked, and /health must answer within a second of being asked.
test("a 7 KB template that renders to 1 MB does not delay /health by more than 1 s", async () => {
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
    const id = ((await template.json()) as { data: { id: number } }).data.id;
    const sending = s.call("/api/tx", "POST", {
      subscriber_mode: "external",
      subscriber_emails: ["bold@example.test"],
      template_id: id,
    });
    await Bun.sleep(300);
    const asked = performance.now();
    const health = await s.call("/health");
    expect(health.status).toBe(200);
    expect(performance.now() - asked).toBeLessThan(1_000);
    expect((await sending).status).toBe(200);
    const text = await textTo(s, "bold@example.test");
    expect(text).toContain("t");
  } finally {
    await s.close();
  }
});

// r3 B1: the reviewer's 12 KB template of unclosed <p> elements, which renders to about 1 MB. The
// conversion gives up at its handler cap, so /health must not wait for it, and the message still
// sends its HTML with no text part.
test("a 12 KB template of unclosed <p> elements does not delay /health by more than 200 ms, and sends its HTML", async () => {
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
    const id = ((await template.json()) as { data: { id: number } }).data.id;
    const sending = s.call("/api/tx", "POST", {
      subscriber_mode: "external",
      subscriber_emails: ["unclosed@example.test"],
      template_id: id,
    });
    await Bun.sleep(300);
    const asked = performance.now();
    const health = await s.call("/health");
    expect(health.status).toBe(200);
    expect(performance.now() - asked).toBeLessThan(200);
    expect((await sending).status).toBe(200);
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

test("a fragment with self-closing SVG and MathML sends, with or without a text part", async () => {
  const s = await stack();
  try {
    const template = await s.call("/api/templates", "POST", {
      name: "svg",
      type: "tx",
      subject: "Svg",
      body: '<svg><title/></svg><svg style="display:none"/><math><a href="x"/></math>visible',
    });
    const id = ((await template.json()) as { data: { id: number } }).data.id;
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
