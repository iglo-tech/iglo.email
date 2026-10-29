// Reference: listmonk cmd/tx.go, models/messages.go (TxMessage) and
// internal/messenger/email/email.go at 6fcd95f. Messages are observed in the
// invocation-owned Mailpit; the native response body and recipient rules are
// declared differences (docs/design/07-api-and-ui.md, 04-sending.md, D58).
import { randomBytes } from "node:crypto";
import { Mailpit } from "@/test/perf/runtime-compat/mailpit";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { header } from "@/test/perf/runtime-compat/smtp-expect";
import type { Credentials, Mode } from "@/test/contract/types";

type SendRow = { id: number; uuid: string; status: string; smtp_message_id: string };

export async function runTxContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
  restart?: () => Promise<void>;
}) {
  const reference = target.mode === "reference";
  const sink = referenceMailpit(process.env);
  await assertOwnedMailpit(sink);
  const marker = `m08${randomBytes(10).toString("hex")}`;
  const mailpit = new Mailpit(sink, marker);
  const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL tx-${label}`);
  };
  const api = (path: string, method = "GET", body?: unknown) =>
    fetch(`${target.baseUrl}${path}`, {
      method,
      headers: {
        authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(70_000),
    });
  const tx = (body: unknown, auth = authorization) =>
    fetch(`${target.baseUrl}/api/tx`, {
      method: "POST",
      headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(70_000),
    });
  const form = (data: string | undefined, files: File[]) => {
    const body = new FormData();
    if (data !== undefined) body.set("data", data);
    for (const file of files) body.append("file", file);
    return fetch(`${target.baseUrl}/api/tx`, {
      method: "POST",
      headers: { authorization },
      body,
      signal: AbortSignal.timeout(70_000),
    });
  };
  // Upstream queues asynchronously; bounded polling observes intake only.
  const received = async (subject: string, count = 1) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = (await mailpit.list()).filter((m) => m.Subject === subject);
      if (found.length >= count || Date.now() > deadline) return found;
      await Bun.sleep(25);
    }
  };
  const absent = async (subject: string) => {
    // Upstream queues before SMTP; give an erroneous send time to arrive.
    await Bun.sleep(reference ? 300 : 50);
    return (await mailpit.list()).filter((m) => m.Subject.startsWith(subject)).length === 0;
  };
  const sends = async (response: Response, label: string, status = "sent") => {
    check(response.status === 200, `${label}-status`);
    const body = (await response.json()) as { data: true | { sends: SendRow[] } };
    if (reference) {
      check(body.data === true, `${label}-reference-body`);
      return [];
    }
    // Declared difference: the native response returns the created sends.
    const data = body.data as { sends: SendRow[] };
    check(Array.isArray(data.sends) && data.sends.length > 0, `${label}-sends`);
    for (const row of data.sends) {
      check(
        Number.isSafeInteger(row.id) &&
          /^[0-9a-f-]{36}$/.test(row.uuid) &&
          row.status === status &&
          /^<[^<>@\s]+@[^<>@\s]+>$/.test(row.smtp_message_id) &&
          Object.keys(row).sort().join() === "id,smtp_message_id,status,uuid",
        `${label}-row`,
      );
    }
    return data.sends;
  };
  const failed = async (response: Response, label: string, status = 400) => {
    check(response.status === status, `${label}-status`);
    const body = (await response.json()) as { message?: unknown };
    check(typeof body.message === "string" && body.message.length > 0, `${label}-message`);
  };

  const owned = { templates: [] as number[], subscribers: [] as number[], lists: [] as number[] };
  let cleanupFailed = false;
  try {
    if (!reference) {
      const current = (await (await api("/api/settings")).json()) as {
        data: { smtp: Array<Record<string, unknown>> };
      };
      const smtp = [
        {
          ...current.data.smtp[0],
          enabled: true,
          host: sink.host,
          port: sink.port,
          auth_protocol: "none",
          username: "",
          password: "",
          tls_type: "none",
          email_headers: [],
        },
      ];
      check((await api("/api/settings/smtp", "PUT", smtp)).status === 200, "smtp-settings");
    }
    const template = async (subject: string, body: string, type = "tx") => {
      const response = await api("/api/templates", "POST", {
        name: `${subject} template`,
        type,
        subject,
        body,
      });
      check(response.status === 200, "template-create");
      const id = ((await response.json()) as { data: { id: number } }).data.id;
      owned.templates.push(id);
      return id;
    };
    const subscriber = async (email: string, name: string, status = "enabled", extra = {}) => {
      const response = await api("/api/subscribers", "POST", { email, name, status, ...extra });
      check(response.status === 200, "subscriber-create");
      const id = ((await response.json()) as { data: { id: number } }).data.id;
      owned.subscribers.push(id);
      return id;
    };
    const templateId = await template(
      `${marker} tpl {{ ${reference ? ".Tx.Data.order" : "data.order"} }}`,
      reference
        ? "<p>Hello [{{ .Subscriber.Name }}] {{ .Tx.Data.order }} {{ .Subscriber.FirstName }}</p>"
        : "<p>Hello [{{ subscriber.name }}] {{ data.order }} {{ subscriber.first_name }}</p>",
    );
    const expr = (name: string) => (reference ? `.Tx.Data.${name}` : `data.${name}`);
    const subjectOf = (order: string) => `${marker} tpl ${order}`;

    // Authentication.
    check((await tx({ template_id: templateId }, "")).status === 403, "auth");

    // External mode: any address, no lookup, caller headers and from address.
    let response = await tx({
      subscriber_mode: "external",
      subscriber_emails: [`ext-${marker}@example.test`],
      template_id: templateId,
      from_email: "Fixture Sender <sender@example.test>",
      data: { order: "A1" },
      headers: [{ "X-Tx-Fixture": marker }, { "x-tx-fixture": "second" }],
    });
    const external = await sends(response, "external");
    let found = await received(subjectOf("A1"));
    check(found.length === 1, "external-mail");
    let message = await mailpit.message(found[0]!.ID);
    let raw = await mailpit.raw(found[0]!.ID);
    check(message.To.map((t) => t.Address).join() === `ext-${marker}@example.test`, "external-to");
    check(/<p>Hello \[\] A1 <\/p>/.test(message.HTML), "external-body");
    check(header(raw, "X-Tx-Fixture") === marker, "external-header-first-wins");
    check(/sender@example\.test/.test(header(raw, "From")), "external-from");
    if (!reference) check(header(raw, "Message-ID") === external[0]!.smtp_message_id, "message-id");

    // Default mode resolves an existing subscriber by normalized email.
    const ada = await subscriber(`ada-${marker}@example.test`, "Ada Lovelace");
    response = await tx({
      subscriber_email: `  ADA-${marker}@Example.test `,
      template_id: templateId,
      data: { order: "B2" },
    });
    await sends(response, "default-email");
    found = await received(subjectOf("B2"));
    check(found.length === 1, "default-email-mail");
    message = await mailpit.message(found[0]!.ID);
    check(message.To[0]!.Address === `ada-${marker}@example.test`, "default-email-to");
    check(message.HTML.includes("Hello [Ada Lovelace] B2 Ada"), "default-email-subscriber");

    // IDs, including the deprecated single ID, and multiple recipients.
    const bob = await subscriber(`bob-${marker}@example.test`, "Bob Builder");
    response = await tx({
      subscriber_ids: [ada, bob],
      template_id: templateId,
      data: { order: "C3" },
    });
    check((await sends(response, "ids")).length === (reference ? 0 : 2), "ids-count");
    found = await received(subjectOf("C3"), 2);
    check(found.length === 2, "ids-mail");
    response = await tx({ subscriber_id: bob, template_id: templateId, data: { order: "C4" } });
    await sends(response, "id");
    check((await received(subjectOf("C4"))).length === 1, "id-mail");

    // Fallback mode accepts unknown addresses in both implementations.
    response = await tx({
      subscriber_mode: "fallback",
      subscriber_emails: [`unknown-${marker}@example.test`],
      template_id: templateId,
      data: { order: "D5" },
    });
    await sends(response, "fallback");
    check((await received(subjectOf("D5"))).length === 1, "fallback-mail");

    // Subject override, plain content and alternative body.
    response = await tx({
      subscriber_emails: [`ada-${marker}@example.test`],
      template_id: templateId,
      subject: `${marker} override {{ ${expr("order")} }}`,
      content_type: "plain",
      data: { order: "E6" },
    });
    await sends(response, "plain");
    found = await received(`${marker} override E6`);
    check(found.length === 1, "plain-mail");
    message = await mailpit.message(found[0]!.ID);
    check(message.Text.includes("Hello [Ada Lovelace] E6") && !message.HTML, "plain-body");
    response = await tx({
      subscriber_emails: [`ada-${marker}@example.test`],
      template_id: templateId,
      subject: `${marker} alt`,
      altbody: `Alt {{ ${expr("order")} }}`,
      data: { order: "F7" },
    });
    await sends(response, "altbody");
    found = await received(`${marker} alt`);
    check(found.length === 1, "altbody-mail");
    message = await mailpit.message(found[0]!.ID);
    check(message.Text.trim() === "Alt F7" && message.HTML.includes("F7"), "altbody-parts");

    // Multipart: one data field plus file attachments.
    const binary = Buffer.from([0, 1, 2, 13, 10, 127, 128, 255]);
    response = await form(
      JSON.stringify({
        subscriber_mode: "external",
        subscriber_emails: [`files-${marker}@example.test`],
        template_id: templateId,
        data: { order: "G8" },
      }),
      [
        new File([binary], "fixture.bin", { type: "application/octet-stream" }),
        new File(["notes"], "notes.txt", { type: "text/plain" }),
      ],
    );
    await sends(response, "multipart");
    found = await received(subjectOf("G8"));
    check(found.length === 1, "multipart-mail");
    message = await mailpit.message(found[0]!.ID);
    const names = (message.Attachments ?? []).map((a) => a.FileName).sort();
    check(names.join() === "fixture.bin,notes.txt", "multipart-attachments");
    const part = message.Attachments.find((a) => a.FileName === "fixture.bin")!;
    check((await mailpit.part(found[0]!.ID, part.PartID)).equals(binary), "multipart-bytes");
    await failed(await form(undefined, []), "multipart-missing-data");
    await failed(await form("{", []), "multipart-invalid-data");

    // Validation: every rejected request sends nothing.
    const campaign = (
      (await (await api("/api/templates")).json()) as { data: Array<{ id: number; type: string }> }
    ).data.find((row) => row.type === "campaign")!.id;
    const invalid: Array<[string, unknown]> = [
      [
        "email-and-emails",
        { subscriber_email: "a@example.test", subscriber_emails: ["b@example.test"] },
      ],
      ["id-and-ids", { subscriber_id: ada, subscriber_ids: [bob] }],
      ["no-recipient", {}],
      ["emails-and-ids", { subscriber_emails: ["a@example.test"], subscriber_ids: [ada] }],
      ["fallback-ids", { subscriber_mode: "fallback", subscriber_ids: [ada] }],
      ["external-no-emails", { subscriber_mode: "external" }],
      ["mode", { subscriber_mode: "bogus", subscriber_emails: ["a@example.test"] }],
      ["invalid-email", { subscriber_emails: ["not-an-email"] }],
      ["missing-template", { subscriber_emails: ["a@example.test"], template_id: 2147483000 }],
      ["campaign-template", { subscriber_emails: ["a@example.test"], template_id: campaign }],
      ["messenger", { subscriber_emails: ["a@example.test"], messenger: "nope" }],
      ["unknown-id", { subscriber_ids: [2147483000] }],
      ["type", { subscriber_emails: ["a@example.test"], template_id: "1" }],
    ];
    for (const [label, body] of invalid)
      await failed(
        await tx({
          template_id: templateId,
          subject: `${marker} invalid ${label}`,
          ...(body as object),
        }),
        `invalid-${label}`,
      );
    await failed(await tx("{"), "invalid-json");
    check(await absent(`${marker} invalid`), "invalid-no-mail");

    // Declared difference: default mode sends to an address with no subscriber.
    response = await tx({
      subscriber_emails: [`stranger-${marker}@example.test`],
      template_id: templateId,
      data: { order: "H9" },
    });
    if (reference) {
      await failed(response, "default-unknown");
      check(await absent(subjectOf("H9")), "default-unknown-no-mail");
    } else {
      await sends(response, "default-unknown");
      check((await received(subjectOf("H9"))).length === 1, "default-unknown-mail");
    }

    // Declared difference: a blocklisted subscriber never receives mail.
    const blocked = await subscriber(`blocked-${marker}@example.test`, "Blocked", "blocklisted");
    response = await tx({
      subscriber_id: blocked,
      template_id: templateId,
      data: { order: "I10" },
    });
    if (reference) {
      await sends(response, "blocklisted");
      check((await received(subjectOf("I10"))).length === 1, "blocklisted-reference-mail");
    } else {
      await sends(response, "blocklisted", "skipped");
      check(await absent(subjectOf("I10")), "blocklisted-no-mail");
    }

    if (!reference) {
      const journal = async (id: number) =>
        ((await (await api(`/api/sends/${id}`)).json()) as { data: Record<string, unknown> }).data;
      const row = await journal(external[0]!.id);
      check(
        row.source === "tx" &&
          row.kind === "transactional" &&
          row.template_id === templateId &&
          row.subscriber_id === null &&
          row.status === "sent",
        "journal",
      );

      // New field: async queues and returns before the outbox delivers.
      response = await tx({
        subscriber_emails: [`async-${marker}@example.test`],
        template_id: templateId,
        data: { order: "J11" },
        async: true,
      });
      const queued = await sends(response, "async", "queued");
      check((await received(subjectOf("J11"))).length === 1, "async-mail");
      for (let i = 0; i < 200 && (await journal(queued[0]!.id)).status !== "sent"; i++)
        await Bun.sleep(25);
      check((await journal(queued[0]!.id)).status === "sent", "async-journal");

      // New field: idempotency, sequential and concurrent.
      const key = `key-${marker}`;
      const first = {
        subscriber_emails: [`idem-${marker}@example.test`],
        template_id: templateId,
        data: { order: "K12" },
        idempotency_key: key,
      };
      const one = await sends(await tx(first), "idempotent-first");
      const two = await sends(await tx(first), "idempotent-repeat");
      check(JSON.stringify(one) === JSON.stringify(two), "idempotent-same");
      await failed(await tx({ ...first, data: { order: "K13" } }), "idempotent-conflict", 409);
      const parallel = { ...first, data: { order: "K14" }, idempotency_key: `${key}-parallel` };
      const results = await Promise.all([tx(parallel), tx(parallel), tx(parallel)]);
      const rows = await Promise.all(
        results.map(async (r) => (await r.json()) as { data: { sends: SendRow[] } }),
      );
      check(
        results.every((r) => r.status === 200) &&
          new Set(rows.map((r) => r.data.sends.map((s) => s.id).join())).size === 1,
        "idempotent-concurrent",
      );
      await Bun.sleep(200);
      check((await received(subjectOf("K12"))).length === 1, "idempotent-one-mail");
      check((await received(subjectOf("K14"))).length === 1, "idempotent-concurrent-one-mail");
      check(await absent(subjectOf("K13")), "idempotent-conflict-no-mail");

      // New fields: external ID resolution.
      const linked = await subscriber(`extid-${marker}@example.test`, "Ext Id", "enabled", {
        external_id: `ext-${marker}`,
      });
      response = await tx({
        subscriber_external_id: `ext-${marker}`,
        template_id: templateId,
        data: { order: "L15" },
      });
      const byExternal = await sends(response, "external-id");
      check((await journal(byExternal[0]!.id)).subscriber_id === linked, "external-id-link");
      await failed(
        await tx({ subscriber_external_id: `missing-${marker}`, template_id: templateId }),
        "external-id-missing",
      );

      // D58: marketing is journaled as skipped until M2.4.
      const listResponse = await api("/api/lists", "POST", {
        name: `${marker} list`,
        type: "public",
        optin: "single",
      });
      check(listResponse.status === 200, "list-create");
      const list = ((await listResponse.json()) as { data: { id: number } }).data.id;
      owned.lists.push(list);
      response = await tx({
        subscriber_id: ada,
        template_id: templateId,
        kind: "marketing",
        list_id: list,
        data: { order: "M16" },
      });
      const marketing = await sends(response, "marketing", "skipped");
      const marketingRow = await journal(marketing[0]!.id);
      check(
        marketingRow.kind === "marketing" &&
          marketingRow.list_id === list &&
          marketingRow.skip_reason === "policy_unavailable",
        "marketing-journal",
      );
      await failed(
        await tx({ subscriber_id: ada, template_id: templateId, kind: "marketing" }),
        "marketing-list",
      );
      await failed(
        await tx({ subscriber_id: ada, template_id: templateId, list_id: list }),
        "transactional-list",
      );
      await failed(await tx({ subscriber_id: ada, template_id: templateId, kind: "bulk" }), "kind");
      check(await absent(subjectOf("M16")), "marketing-no-mail");

      // Atomicity: a missing ID among valid ones creates no rows and sends nothing.
      const before = ((await (await api("/api/sends")).json()) as { data: { total: number } }).data
        .total;
      await failed(
        await tx({
          subscriber_ids: [ada, 2147483000],
          template_id: templateId,
          data: { order: "N17" },
        }),
        "atomic",
      );
      const after = ((await (await api("/api/sends")).json()) as { data: { total: number } }).data
        .total;
      check(before === after && (await absent(subjectOf("N17"))), "atomic-no-rows");

      if (target.restart) {
        await target.restart();
        check(
          (await sends(await tx(first), "idempotent-restart"))[0]!.id === one[0]!.id,
          "idempotent-restart-same",
        );
        check((await received(subjectOf("K12"))).length === 1, "idempotent-restart-one-mail");
      }
    }
  } finally {
    for (const id of owned.subscribers)
      if ((await api(`/api/subscribers/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    for (const id of owned.lists)
      if ((await api(`/api/lists/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    for (const id of owned.templates)
      if ((await api(`/api/templates/${id}`, "DELETE")).status !== 200) cleanupFailed = true;
    await mailpit.removeOwned();
  }
  if (cleanupFailed) throw new Error("FAIL tx-cleanup");
}

if (import.meta.main) {
  try {
    if (process.argv[2] !== "reference") throw new Error("Invalid mode");
    const {
      REFERENCE_URL: baseUrl,
      REFERENCE_API_USER: user,
      REFERENCE_API_TOKEN: token,
    } = process.env;
    if (!baseUrl || !user || !token) throw new Error("Missing reference credentials");
    await runTxContract({ mode: "reference", baseUrl, credentials: { user, token } });
    process.stdout.write("PASS tx reference contract\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-]+$/.test(error.message) ? error.message : `Tx contract failed: ${error instanceof Error ? error.message : ""}`}\n`,
    );
    process.exitCode = 1;
  }
}
