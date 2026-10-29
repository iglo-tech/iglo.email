// Reference first: pinned upstream TX/template API; then the separately compiled owner caller.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { header } from "@/test/perf/runtime-compat/smtp-expect";
const sink = referenceMailpit(process.env);
await assertOwnedMailpit(sink);
const base = process.env.REFERENCE_URL!,
  user = process.env.REFERENCE_API_USER!,
  token = process.env.REFERENCE_API_TOKEN!;
const auth = `Basic ${btoa(`${user}:${token}`)}`;
const marker = `m08${sink.runId.replaceAll("-", "")}${randomBytes(4).toString("hex")}`;
const mailpit = new Mailpit(sink, marker);
const binary = Buffer.from([0, 1, 2, 13, 10, 127, 128, 255]);
const inline = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>`);
const cases = [
  {
    name: "plain",
    contentType: "plain",
    body: "Plain fixture: Zażółć & hello.",
    alt: "",
    binary: false,
  },
  {
    name: "html",
    contentType: "html",
    body: "<p>Hello Zażółć &amp; world</p>",
    alt: "Alternative: Zażółć & world",
    binary: false,
  },
  { name: "binary", contentType: "html", body: "<p>Attachment</p>", alt: "", binary: true },
  { name: "headers", contentType: "plain", body: "Header fixture", alt: "", binary: false },
  {
    name: "inline",
    contentType: "html",
    body: '<p>Inline</p><img data-embed src="/uploads/fixture.svg">',
    alt: "",
    binary: false,
  },
] as const;
async function getOne(subject: string) {
  // Upstream TX queues asynchronously; polling is bounded observation, not time-policy testing.
  const deadline = Date.now() + 5000;
  do {
    const found = (await mailpit.list()).filter((m) => m.Subject === subject);
    if (found.length === 1) return found[0]!;
    assert.equal(found.length, 0);
    await Bun.sleep(20);
  } while (Date.now() < deadline);
  throw new Error("Reference message was not received");
}
async function snapshot(id: string) {
  const message = await mailpit.message(id),
    raw = await mailpit.raw(id);
  const attachment = message.Attachments?.find((a) => a.FileName === "fixture.bin");
  return {
    subject: message.Subject,
    text: message.Text?.trim() ?? "",
    html: message.HTML?.trim() ?? "",
    sender: message.ReturnPath.replace(/[<>]/g, ""),
    to: message.To.map((a) => a.Address),
    cc: (message.Cc ?? []).map((a) => a.Address),
    bcc: header(raw, "Bcc"),
    id: header(raw, "Message-ID"),
    fixture: header(raw, "X-Fixture"),
    server: header(raw, "X-Server"),
    attachment: attachment ? (await mailpit.part(id, attachment.PartID)).toString("hex") : "",
    inline: await Promise.all(
      (message.Inline ?? []).map(async (part) => ({
        name: part.FileName,
        cid: part.ContentID.replace(/[<>]/g, ""),
        bytes: (await mailpit.part(id, part.PartID)).toString("hex"),
      })),
    ),
  };
}
try {
  for (const item of cases) {
    const subject = `${marker} ${item.name}`,
      messageId = `<${marker}.${item.name}@example.test>`;
    let media: { id: number; filename: string } | undefined;
    let bodyText: string = item.body;
    if (item.name === "inline") {
      const form = new FormData();
      form.set("file", new File([inline], "fixture.svg", { type: "image/svg+xml" }));
      const uploaded = await fetch(`${base}/api/media`, {
        method: "POST",
        headers: { authorization: auth },
        body: form,
      });
      assert.equal(uploaded.status, 200);
      media = ((await uploaded.json()) as { data: { id: number; filename: string } }).data;
      bodyText = item.body.replace("fixture.svg", media.filename);
    }
    const templateResponse = await fetch(`${base}/api/templates`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ name: subject, type: "tx", subject, body: bodyText }),
    });
    assert.equal(templateResponse.status, 200);
    const template = ((await templateResponse.json()) as { data: { id: number } }).data;
    const headers = [
      {
        "Message-ID": messageId,
        "X-Fixture": marker,
        "Return-Path": "bounce@example.test",
        Cc: "copy@example.test",
        Bcc: "hidden@example.test",
      },
    ];
    const tx = {
      subscriber_mode: "external",
      subscriber_emails: ["visible@example.test"],
      template_id: template.id,
      from_email: "sender@example.test",
      content_type: item.contentType,
      subject,
      altbody: item.alt,
      headers,
    };
    let body: BodyInit;
    const requestHeaders: Record<string, string> = { authorization: auth };
    if (item.binary) {
      const form = new FormData();
      form.set("data", JSON.stringify(tx));
      form.set("file", new File([binary], "fixture.bin", { type: "application/octet-stream" }));
      body = form;
    } else {
      body = JSON.stringify(tx);
      requestHeaders["content-type"] = "application/json";
    }
    const response = await fetch(`${base}/api/tx`, {
      method: "POST",
      headers: requestHeaders,
      body,
    });
    assert.equal(response.status, 200);
    const reference = await getOne(subject);
    const expected = await snapshot(reference.ID);
    assert.equal(expected.fixture, marker);
    assert.equal(expected.server, "server-only");
    await mailpit.removeOwned();
    const message = {
      from: tx.from_email,
      to: ["visible@example.test"],
      subject,
      contentType: item.contentType,
      body: item.name === "inline" ? expected.html : item.body,
      inline: item.name === "inline" ? expected.inline[0] : undefined,
      ...(item.alt ? { altBody: undefined } : {}),
      messageId,
      headers: headers[0],
      binary: item.binary,
    };
    // Buffers are materialized in the compiled driver.
    const environment = {
      ...process.env,
      M21_MESSAGE: JSON.stringify({ ...message, alt: item.alt }),
    };
    const child = spawn(resolve("dist/messaging-corpus-caller"), [], {
      env: environment,
      stdio: "inherit",
    });
    const code = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("exit", done);
    });
    assert.equal(code, 0);
    const native = await getOne(subject);
    const actual = await snapshot(native.ID);
    assert.deepEqual(actual, expected, item.name);
    if (item.binary) assert.equal(actual.attachment, binary.toString("hex"));
    if (item.name === "inline") {
      assert.equal(actual.inline.length, 1);
      assert.equal(actual.inline[0]!.bytes, inline.toString("hex"));
    }
    await mailpit.removeOwned();
    assert.equal(
      (
        await fetch(`${base}/api/templates/${template.id}`, {
          method: "DELETE",
          headers: { authorization: auth },
        })
      ).status,
      200,
    );
    if (media)
      assert.equal(
        (
          await fetch(`${base}/api/media/${media.id}`, {
            method: "DELETE",
            headers: { authorization: auth },
          })
        ).status,
        200,
      );
    console.log(`paired ${item.name} passed`);
  }
} finally {
  await mailpit.removeOwned();
}
