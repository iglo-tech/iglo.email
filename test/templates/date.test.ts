// The `date` filter's format and input rules (B135 items 5 and 6, docs/design/06-templates.md),
// observed through POST /api/tx into the loopback SMTP sink.
import { afterEach, expect, test } from "bun:test";
import { txFixture } from "@/test/tx/fixture";
import type { JsonObject } from "@/test/json-object";
import type { TxFixture } from "@/test/tx/fixture";
import { asBody } from "@/test/read-body";

const fixtures: Array<TxFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function open() {
  const f = await txFixture();
  fixtures.push(f);
  return f;
}

/** Send `body` to a fresh address; the message text is decoded from quoted-printable. */
async function render(f: TxFixture, body: string, data: JsonObject = {}) {
  const template = await f.template(`<p>${body}</p>`);
  const email = `t-${crypto.randomUUID().slice(0, 12)}@example.test`;
  const response = await f.tx({ subscriber_emails: [email], template_id: template, data });
  const row = response.body?.data?.sends?.[0];
  const raw = f.mailTo(email)[0]?.data ?? "";
  const at = raw.indexOf("\r\n\r\n");
  const bytes = raw
    .slice(at + 4)
    .replaceAll("=\r\n", "")
    .replaceAll(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  const message = Buffer.from(bytes, "latin1").toString("utf-8");
  return { http: response.status, status: asBody<string | undefined>(row?.status), message };
}

test("a double percent sign in a format is a literal percent sign", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ '2026-01-02' | date: '100%% %Y' }}] [{{ '2026-01-02' | date: '%%Y' }}] " +
      "[{{ '2026-01-02' | date: '%%%Y' }}]",
    {},
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[100% 2026] [%Y] [%2026]");
});

test("the existing directives keep their values in UTC", async () => {
  const f = await open();
  const sent = await render(
    f,
    "[{{ '2026-01-02T03:04:05Z' | date: '%Y-%m-%d %H:%M:%S' }}] [{{ '2026-07-09' | date: '%d.%m.%Y' }}]",
    {},
  );
  expect(sent.status).toBe("sent");
  expect(sent.message).toContain("[2026-01-02 03:04:05] [09.07.2026]");
});

test("a calendar date that does not exist is invalid, and a real one renders", async () => {
  const f = await open();
  const template = await f.template('<p>[{{ data.d | date: "%Y-%m-%d" }}]</p>');
  const send = async (d: string) => {
    const email = `i-${crypto.randomUUID().slice(0, 12)}@example.test`;
    const response = await f.tx({
      subscriber_emails: [email],
      template_id: template,
      data: { d },
    });
    return response.status;
  };
  // Rolled over, these would have printed 2026-03-02 and 2026-05-01; each is refused at send.
  expect(await send("2026-02-30")).toBe(400);
  expect(await send("2026-04-31")).toBe(400);
  expect(await send("2026-02-31T10:00:00Z")).toBe(400);
  // A leap day and an ordinary date render as written.
  expect(await send("2028-02-29")).toBe(200);
  const sent = await render(f, "[{{ data.d | date: '%Y-%m-%d' }}]", { d: "2026-02-28" });
  expect(sent.message).toContain("[2026-02-28]");
});

test("a lone percent sign, or an unknown directive, is refused at save", async () => {
  const f = await open();
  for (const format of ["100% %Y", "%q", "%Y%"]) {
    const saved = await f.json("/api/templates", "POST", {
      name: "date",
      type: "tx",
      subject: "s",
      body: `<p>{{ '2026-01-02' | date: '${format}' }}</p>`,
    });
    expect(saved.status, format).toBe(400);
    expect(saved.body.message, format).toContain(
      "it fails to render: a date format has an unsupported directive",
    );
  }
});
