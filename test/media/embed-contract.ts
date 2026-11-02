// Compiled-executable contract for the `data-embed` media path and caller attachments, end to
// end (B6): a stored image is uploaded, a transactional template and a campaign embed it by
// name, and the message arriving at a loopback SMTP sink carries it as an inline part whose
// decoded bytes are the stored file. Run after `bun run build`: `bun test/media/embed-contract.ts`.
// Mail goes only to the loopback sink below.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";
import { imagePng } from "@/test/media/images";

const repository = resolve(import.meta.dir, "../..");
const fixtures = await readFile(resolve(repository, "test/users/fixtures.md"), "utf8");
const admin = {
  user: /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(fixtures)![1]!,
  password: /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(fixtures)![1]!,
};

async function startSink() {
  const messages: Array<{ to: string; data: string }> = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("latin1");
    let buffer = "";
    let data: string[] | null = null;
    let to = "";
    socket.write("220 sink.test ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (data) {
          if (line === ".") {
            messages.push({ to, data: data.join("\r\n") });
            data = null;
            socket.write("250 queued\r\n");
          } else data.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") socket.write("250-sink.test\r\n250 8BITMIME\r\n");
        else if (verb === "RCPT") {
          to = /<([^>]*)>/.exec(line)?.[1] ?? "";
          socket.write("250 ok\r\n");
        } else if (verb === "DATA") {
          data = [];
          socket.write("354 go\r\n");
        } else if (verb === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("sink address");
  return {
    port: address.port,
    messages,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** The parts of a captured message that carry `Content-ID` or an attachment name, decoded. */
function parts(raw: string) {
  const boundaries = [...raw.matchAll(/boundary="?([^"\r\n;]+)"?/gi)].map((m) => m[1]!);
  const found: Array<{ headers: string; body: Buffer }> = [];
  for (const boundary of boundaries)
    for (const section of raw.split(`--${boundary}`)) {
      const split = section.indexOf("\r\n\r\n");
      if (split < 0) continue;
      const headers = section.slice(0, split);
      if (!/^Content-Transfer-Encoding:\s*base64/im.test(headers)) continue;
      const body = Buffer.from(section.slice(split + 4).replace(/\s+/g, ""), "base64");
      found.push({ headers, body });
    }
  return found;
}

const sink = await startSink();
const executable = resolve(repository, "dist/iglo.email");
try {
  await withProduction(
    executable,
    AbortSignal.timeout(120_000),
    async (origin) => {
      const credentials = await provisionApiUser(origin, admin);
      const authorization = `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`;
      const call = async (path: string, method = "GET", body?: unknown) => {
        const form = body instanceof FormData;
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: {
            authorization,
            ...(body === undefined || form ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null, text };
      };
      const settings = (await call("/api/settings")).body.data;
      const updated = await call("/api/settings", "PUT", {
        ...settings,
        "app.from_email": ["Embed <embed@example.test>"],
        "app.concurrency": 1,
        smtp: [
          {
            ...settings.smtp[0],
            enabled: true,
            host: "127.0.0.1",
            port: sink.port,
            max_conns: 2,
            auth_protocol: "none",
            username: "",
            password: "",
            tls_type: "none",
            email_headers: [],
          },
        ],
      });
      assert.equal(updated.status, 200, updated.text);
      for (let i = 0; i < 100; i++) {
        // A settings save restarts the SMTP pool in place; wait for the next request to answer.
        if ((await fetch(`${origin}/health`)).ok) break;
        await Bun.sleep(50);
      }

      const upload = new FormData();
      upload.append("file", new File([imagePng], "embed-logo.png", { type: "image/png" }));
      const stored = await call("/api/media", "POST", upload);
      assert.equal(stored.status, 200, stored.text);
      const filename: string = stored.body.data.filename;

      // 1. A transactional template embeds the image by its stored name.
      const template = await call("/api/templates", "POST", {
        name: "embed",
        type: "tx",
        subject: "Embed tx",
        body: `<p>Hello</p><img src="${filename}" data-embed="true"><img src="https://cdn.example.test/x.png" data-embed="true">`,
      });
      assert.equal(template.status, 200, template.text);
      const sent = await call("/api/tx", "POST", {
        subscriber_email: "tx-embed@example.test",
        subscriber_mode: "external",
        template_id: template.body.data.id,
      });
      assert.equal(sent.status, 200, sent.text);
      assert.equal(sent.body.data.sends[0].status, "sent");
      const message = sink.messages.find((m) => m.to === "tx-embed@example.test")!;
      assert.ok(message, "tx message arrived");
      const text = message.data.replace(/=\r\n/g, "").replace(/=3D/g, "=");
      const cid = /^Content-ID: <([^>]+)>/im.exec(text)?.[1];
      assert.ok(cid, "inline part has a Content-ID");
      assert.ok(text.includes(`src="cid:${cid}"`), "the body points at the inline part");
      assert.ok(text.includes('src="https://cdn.example.test/x.png"'), "a remote image is left");
      assert.match(text, /^Content-Disposition: inline/im);
      const inline = parts(message.data).find((p) => /^Content-ID:/im.test(p.headers));
      assert.ok(inline, "inline part found");
      assert.ok(Buffer.from(imagePng).equals(inline.body), "inline bytes are the stored file");

      // 2. A caller attachment on the same endpoint, as a multipart request.
      const multipart = new FormData();
      multipart.set(
        "data",
        JSON.stringify({
          subscriber_email: "tx-attached@example.test",
          subscriber_mode: "external",
          template_id: template.body.data.id,
        }),
      );
      multipart.append("file", new File([new Uint8Array([0, 255, 10, 13])], "dir/note.bin"));
      const attached = await call("/api/tx", "POST", multipart);
      assert.equal(attached.status, 200, attached.text);
      const second = sink.messages.find((m) => m.to === "tx-attached@example.test")!;
      assert.ok(second, "attachment message arrived");
      assert.match(second.data, /filename="?note\.bin"?/i);
      assert.ok(
        parts(second.data).some((p) => Buffer.from([0, 255, 10, 13]).equals(p.body)),
        "attachment bytes arrive intact",
      );

      // 3. A campaign body embeds the image the same way.
      const list = await call("/api/lists", "POST", { name: "embed", type: "public" });
      assert.equal(list.status, 200, list.text);
      const subscriber = await call("/api/subscribers", "POST", {
        email: "campaign-embed@example.test",
        name: "Embed",
        status: "enabled",
        lists: [list.body.data.id],
        preconfirm_subscriptions: true,
      });
      assert.equal(subscriber.status, 200, subscriber.text);
      const campaign = await call("/api/campaigns", "POST", {
        name: "embed",
        subject: "Embed campaign",
        lists: [list.body.data.id],
        content_type: "html",
        body: `<p>Hi</p><img src="${filename}" data-embed="true">`,
        messenger: "email",
      });
      assert.equal(campaign.status, 200, campaign.text);
      const running = await call(`/api/campaigns/${campaign.body.data.id}/status`, "PUT", {
        status: "running",
      });
      assert.equal(running.status, 200, running.text);
      for (let i = 0; i < 400; i++) {
        if (sink.messages.some((m) => m.to === "campaign-embed@example.test")) break;
        await Bun.sleep(50);
      }
      const delivered = sink.messages.find((m) => m.to === "campaign-embed@example.test");
      assert.ok(delivered, "campaign message arrived");
      const campaignInline = parts(delivered.data).find((p) => /^Content-ID:/im.test(p.headers));
      assert.ok(campaignInline, "campaign inline part found");
      assert.ok(Buffer.from(imagePng).equals(campaignInline.body), "campaign inline bytes match");

      // 4. Deleting the file stops the embedding at once: no cached copy is sent.
      assert.equal((await call(`/api/media/${stored.body.data.id}`, "DELETE")).status, 200);
      const after = await call("/api/tx", "POST", {
        subscriber_email: "tx-after@example.test",
        subscriber_mode: "external",
        template_id: template.body.data.id,
      });
      assert.equal(after.status, 200, after.text);
      const gone = sink.messages.find((m) => m.to === "tx-after@example.test")!;
      assert.ok(!/^Content-ID:/im.test(gone.data), "a deleted file is not embedded");
      process.stdout.write("PASS data-embed and attachment compiled contract\n");
    },
    admin,
    120_000,
  );
} finally {
  await sink.close();
}
