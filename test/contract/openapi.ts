// Production-only: the document is native. Every documented operation runs on the compiled
// executable through real HTTP, and each answer is checked against the document it was served.
import { Database } from "bun:sqlite";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { validate, type Document } from "@/test/openapi/schema";
import type { Credentials } from "@/test/contract/types";
import { assertOwnedMailpit, referenceMailpit } from "@/test/perf/runtime-compat/smtp-env";
import { startReceiver } from "@/test/webhooks/receiver";

interface Reply {
  status: number;
  body: any;
  text: string;
  type: string;
}
interface Options {
  params?: Record<string, string | number>;
  query?: string;
  body?: unknown;
  /** Sent as is: a form, or text that is not JSON. */
  raw?: BodyInit;
  headers?: Record<string, string>;
  auth?: string | null;
  expect?: number;
}

/** A real password login; the cookies and CSRF header a browser would send. */
async function session(origin: string, admin: { user: string; password: string }) {
  const page = await fetch(`${origin}/admin/login`);
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const cookie = (response: Response, name: string) =>
    response.headers
      .getSetCookie()
      .find((item) => item.startsWith(`${name}=`))
      ?.split(";", 1)[0] ?? "";
  const login = await fetch(`${origin}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie(page, "nonce"),
    },
    body: new URLSearchParams({
      username: admin.user,
      password: admin.password,
      nonce,
      next: "/api/profile",
    }),
  });
  const csrf = cookie(login, "csrf");
  return {
    cookie: `${cookie(login, "session")}; ${csrf}`,
    "x-csrf-token": csrf.slice("csrf=".length),
  };
}

const totp = (secret: string) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((part) => parseInt(part, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const value = mac.readUInt32BE(mac[19]! & 15) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, "0");
};

export async function runOpenApiContract(target: {
  baseUrl: string;
  credentials: Credentials;
  admin: { user: string; password: string };
  dataDir: string;
}) {
  const sink = referenceMailpit(process.env);
  await assertOwnedMailpit(sink);
  const receiver = startReceiver();
  // A server that refuses every recipient for good, so a send fails without a retry.
  const refusing = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: (socket) => void socket.write("220 fixture\r\n"),
      data(socket, chunk) {
        for (const line of chunk.toString().split("\r\n").filter(Boolean))
          socket.write(/^RCPT/i.test(line) ? "550 5.1.1 refused\r\n" : "250 ok\r\n");
      },
    },
  });
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL openapi-${label}`);
  };
  const basic = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;

  const send = async (
    method: string,
    path: string,
    { query = "", body, raw, headers = {}, auth = basic }: Options = {},
  ): Promise<Reply> => {
    const response = await fetch(`${target.baseUrl}${path}${query}`, {
      method,
      redirect: "manual",
      headers: {
        ...(auth === null ? {} : { authorization: auth }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined
        ? raw === undefined
          ? {}
          : { body: raw }
        : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
    return {
      status: response.status,
      body: type === "application/json" ? JSON.parse(text) : null,
      text,
      type,
    };
  };

  /** An API user with these permissions and per-list grants. */
  const credential = async (name: string, permissions: string[], lists: unknown[] = []) => {
    const role = (await send("POST", "/api/roles/users", { body: { name, permissions } })).body
      .data;
    const listRole = (await send("POST", "/api/roles/lists", { body: { name, lists } })).body.data;
    const user = (
      await send("POST", "/api/users", {
        body: {
          username: name,
          type: "api",
          status: "enabled",
          user_role_id: role.id,
          list_role_id: listRole.id,
        },
      })
    ).body.data;
    return `Basic ${btoa(`${name}:${user.password}`)}`;
  };

  const seen = new Map<string, Set<number>>();
  /** Components that met a real value: an empty array proves nothing about its items. */
  const checked = new Set<string>();
  let document!: Document;

  /** One operation by its documented path; its answer has to be what the document says. */
  const op = async (key: string, options: Options = {}): Promise<Reply> => {
    const [method, template] = key.split(" ") as [string, string];
    const path = template.replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = options.params?.[name];
      check(value !== undefined, `param-${key}-${name}`);
      return encodeURIComponent(String(value));
    });
    const declared = new Set(
      (operationOf(key).parameters as { in: string; name: string }[])
        .filter((parameter) => parameter.in === "query")
        .map(({ name }) => name),
    );
    for (const name of new URLSearchParams(options.query).keys())
      if (!declared.has(name))
        throw new Error(`FAIL openapi-query ${key}: ${name} is undocumented`);
    if (options.body !== undefined) accepted(key, options.body);
    const reply = await send(method, path, options);
    const expected = options.expect ?? 200;
    if (reply.status !== expected)
      throw new Error(`FAIL openapi-${key}: status ${reply.status}: ${reply.text.slice(0, 300)}`);
    conforms(key, reply);
    return reply;
  };

  const operationOf = (key: string) => {
    const [method, template] = key.split(" ") as [string, string];
    const operation = document.paths[template]?.[method.toLowerCase()];
    if (!operation) throw new Error(`FAIL openapi-undocumented ${key}`);
    return operation;
  };

  /** The body an operation is sent has to fit the document too. */
  const accepted = (key: string, body: unknown) => {
    const schema = operationOf(key).requestBody?.content["application/json"]?.schema;
    if (!schema) throw new Error(`FAIL openapi-request ${key}: no JSON body is documented`);
    const problems = validate(document, schema, body, "$", 0, checked);
    if (problems.length)
      throw new Error(`FAIL openapi-request ${key}: ${problems.slice(0, 8).join("; ")}`);
  };

  const conforms = (key: string, reply: Reply) => {
    const operation = operationOf(key);
    const declared = operation.responses[String(reply.status)] ?? operation.responses.default;
    if (!declared) throw new Error(`FAIL openapi-status ${key}: ${reply.status} is not documented`);
    const response = declared.$ref
      ? document.components.responses[declared.$ref.split("/").pop()]
      : declared;
    const content = response.content as Record<string, { schema?: object }> | undefined;
    if (!content) {
      if (reply.text !== "") throw new Error(`FAIL openapi-body ${key}: documented as empty`);
    } else {
      const media = content[reply.type];
      if (!media)
        throw new Error(
          `FAIL openapi-type ${key} ${reply.status}: ${reply.type} is not documented`,
        );
      if (reply.type === "application/json") {
        const problems = validate(document, media.schema ?? {}, reply.body, "$", 0, checked);
        if (problems.length)
          throw new Error(
            `FAIL openapi-schema ${key} ${reply.status}: ${problems.slice(0, 8).join("; ")}`,
          );
      }
    }
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key)!.add(reply.status);
  };

  try {
    // Mail reaches the sink, and tracked links and bounces are on.
    const settings = (await send("GET", "/api/settings")).body.data;
    check(
      (
        await send("PUT", "/api/settings/smtp", {
          body: [
            {
              ...settings.smtp[0],
              enabled: true,
              host: sink.host,
              port: sink.port,
              auth_protocol: "none",
              username: "",
              password: "",
              tls_type: "none",
              email_headers: [],
            },
          ],
        })
      ).status === 200,
      "smtp-settings",
    );
    await send("PUT", "/api/settings/app.from_email", { body: ["Fixture <noreply@fixture.test>"] });
    await send("PUT", "/api/settings/bounce.enabled", { body: true });
    await send("PUT", "/api/settings/bounce.webhooks_enabled", { body: true });
    const signingKey = "openapi-contract-key";
    await send("PUT", "/api/settings/bounce.mailgun", { body: { enabled: true, key: signingKey } });
    await send("PUT", "/api/settings/privacy.individual_tracking", { body: true });

    document = (await send("GET", "/api/openapi.json")).body as Document;
    await op("GET /api/openapi.json");
    await op("GET /health", { auth: null });

    await op("GET /api/health");
    await op("GET /api/profile");
    await op("PUT /api/profile", { body: { name: "OpenAPI contract" } });

    // Users and roles.
    const userRole = await op("POST /api/roles/users", {
      body: { name: "contract role", permissions: ["lists:get_all"] },
    });
    await op("PUT /api/roles/users/{id}", {
      params: { id: userRole.body.data.id },
      body: { name: "contract role 2", permissions: ["lists:get_all", "subscribers:get"] },
    });
    await op("GET /api/roles/users");
    const listRole = await op("POST /api/roles/lists", {
      body: { name: "contract list role", lists: [] },
    });
    await op("PUT /api/roles/lists/{id}", {
      params: { id: listRole.body.data.id },
      body: { name: "contract list role 2", lists: [] },
    });
    await op("GET /api/roles/lists");
    const human = await op("POST /api/users", {
      body: {
        username: "contract-human",
        email: "human@fixture.test",
        name: "Human",
        type: "user",
        status: "enabled",
        password: "contract-human-password",
        password_login: true,
        user_role_id: userRole.body.data.id,
        list_role_id: listRole.body.data.id,
      },
    });
    const apiUser = await op("POST /api/users", {
      body: {
        username: "contract-api",
        type: "api",
        status: "enabled",
        user_role_id: userRole.body.data.id,
      },
    });
    await op("GET /api/users");
    await op("GET /api/users/{id}", { params: { id: human.body.data.id } });
    await op("GET /api/users/{id}", { params: { id: apiUser.body.data.id } });
    await op("PUT /api/users/{id}", {
      params: { id: human.body.data.id },
      body: {
        username: "contract-human",
        email: "human@fixture.test",
        name: "Human 2",
        type: "user",
        status: "enabled",
        password_login: true,
        user_role_id: userRole.body.data.id,
      },
    });
    await op("DELETE /api/users/{id}", { params: { id: apiUser.body.data.id } });
    await op("DELETE /api/users", { query: `?id=${human.body.data.id}` });
    await op("DELETE /api/roles/{id}", { params: { id: listRole.body.data.id } });

    // Lists.
    const list = (
      await op("POST /api/lists", {
        body: {
          name: "contract",
          type: "public",
          optin: "single",
          tags: ["one"],
          description: "d",
        },
      })
    ).body.data;
    const doomed = (
      await op("POST /api/lists", { body: { name: "doomed", type: "private", optin: "double" } })
    ).body.data;
    await op("GET /api/lists");
    await op("GET /api/lists", { query: "?per_page=all&minimal=true" });
    await op("GET /api/lists/{id}", { params: { id: list.id } });
    await op("PUT /api/lists/{id}", { params: { id: doomed.id }, body: { name: "doomed 2" } });
    await op("DELETE /api/lists/{id}", { params: { id: doomed.id } });
    const doomed2 = (
      await op("POST /api/lists", { body: { name: "doomed", type: "private", optin: "single" } })
    ).body.data;
    await op("DELETE /api/lists", { query: `?id=${doomed2.id}` });

    const scoped = (
      await op("POST /api/roles/lists", {
        body: {
          name: "scoped",
          lists: [{ id: list.id, permissions: ["list:get", "list:manage"] }],
        },
      })
    ).body.data;
    await op("GET /api/roles/lists");
    await op("DELETE /api/roles/{id}", { params: { id: scoped.id } });

    // Subscribers.
    const subscriber = (
      await op("POST /api/subscribers", {
        body: {
          email: "one@fixture.test",
          name: "One",
          status: "enabled",
          lists: [list.id],
          attribs: { plan: "a" },
          preconfirm_subscriptions: true,
        },
      })
    ).body.data;
    const other = (
      await op("POST /api/subscribers", {
        body: { email: "two@fixture.test", name: "Two", status: "enabled", lists: [list.id] },
      })
    ).body.data;
    const external = (
      await op("POST /api/subscribers", {
        body: {
          email: "three@fixture.test",
          name: "Three",
          status: "enabled",
          external_id: "ext-3",
        },
      })
    ).body.data;
    await op("GET /api/subscribers");
    await op("GET /api/subscribers", { query: `?per_page=all&list_id=${list.id}` });
    await op("GET /api/subscribers/{id}", { params: { id: subscriber.id } });
    // A membership outside the caller's lists is masked, and a list made without tags has none.
    const bare = (
      await op("POST /api/lists", { body: { name: "bare", type: "public", optin: "single" } })
    ).body.data;
    const shared = (
      await op("POST /api/subscribers", {
        body: {
          email: "shared@fixture.test",
          name: "Shared",
          status: "enabled",
          lists: [list.id, bare.id],
          preconfirm_subscriptions: true,
        },
      })
    ).body.data;
    const narrow = await credential(
      "narrow",
      ["subscribers:get"],
      [{ id: list.id, permissions: ["list:get"] }],
    );
    const masked = (
      await op("GET /api/subscribers/{id}", { params: { id: shared.id }, auth: narrow })
    ).body.data.lists.find(({ id }: { id: number }) => id === bare.id);
    check(masked.restricted === true && masked.name === "*Unknown", "subscriber-masked-list");
    await op("GET /api/subscribers", { query: `?list_id=${list.id}`, auth: narrow });
    await op("GET /api/subscribers/{id}", { params: { id: shared.id } });
    await op("PUT /api/subscribers/{id}", {
      params: { id: other.id },
      body: { email: other.email, name: "Two b", status: "enabled", lists: [list.id] },
    });
    await op("PATCH /api/subscribers/{id}", { params: { id: other.id }, body: { name: "Two c" } });
    await op("GET /api/subscribers/external/{external_id}", { params: { external_id: "ext-3" } });
    await op("GET /api/subscribers/external", { query: "?external_id=ext-3" });
    await op("PUT /api/subscribers/external/{external_id}", {
      params: { external_id: "ext-3" },
      body: { email: external.email, name: "Three b", status: "enabled" },
    });
    await op("PUT /api/subscribers/external", {
      query: "?external_id=ext-3",
      body: { email: external.email, name: "Three c", status: "enabled" },
    });
    await op("GET /api/subscribers/export", { query: `?list_id=${list.id}` });
    const selected = await op("GET /api/subscribers/export", {
      query: `?id=${subscriber.id}&id=${other.id}`,
    });
    check(
      selected.text.includes(subscriber.uuid) &&
        selected.text.includes(other.uuid) &&
        !selected.text.includes(external.uuid),
      "export-by-id",
    );
    await op("PUT /api/subscribers/lists", {
      body: { ids: [other.id], action: "add", target_list_ids: [list.id], status: "confirmed" },
    });
    await op("PUT /api/subscribers/lists/{id}", {
      params: { id: other.id },
      body: { action: "add", target_list_ids: [list.id], status: "confirmed" },
    });
    await op("PUT /api/subscribers/query/lists", {
      body: {
        query: "subscribers.id = 0",
        action: "add",
        target_list_ids: [list.id],
        status: "confirmed",
      },
    });
    await op("PUT /api/subscribers/query/blocklist", { body: { query: "subscribers.id = 0" } });
    await op("POST /api/subscribers/query/delete", { body: { query: "subscribers.id = 0" } });
    await op("POST /api/subscribers/{id}/optin", { params: { id: subscriber.id } });

    // Templates.
    const txTemplate = (
      await op("POST /api/templates", {
        body: {
          name: "tx",
          type: "tx",
          subject: "Hello {{ subscriber.name }}",
          body: '<p><a href="{{ "https://example.test/t" | track_link }}">x</a></p>',
        },
      })
    ).body.data;
    const campaignTemplate = (
      await op("POST /api/templates", {
        body: { name: "campaign", type: "campaign", body: "<html>{{ content | raw }}</html>" },
      })
    ).body.data;
    await op("GET /api/templates");
    await op("GET /api/templates", { query: "?no_body=true" });
    await op("GET /api/templates/{id}", { params: { id: campaignTemplate.id } });
    await op("GET /api/templates/{id}/preview", { params: { id: campaignTemplate.id } });
    await op("POST /api/templates/preview", {
      raw: new URLSearchParams({
        template_type: "campaign",
        body: "<html>{{ content | raw }}</html>",
      }),
    });
    await op("PUT /api/templates/{id}", {
      params: { id: campaignTemplate.id },
      body: { name: "campaign 2", type: "campaign", body: "<html>{{ content | raw }}</html>" },
    });
    await op("PUT /api/templates/{id}/default", { params: { id: campaignTemplate.id } });

    // Transactional sends, sends and subscriber activity.
    const tx = await op("POST /api/tx", {
      body: {
        subscriber_email: subscriber.email,
        template_id: txTemplate.id,
        data: { a: 1 },
        content_type: "html",
      },
    });
    await op("GET /api/sends");
    const send0 = tx.body.data.sends[0];
    await op("GET /api/sends/{id}", { params: { id: send0.id } });
    await op("GET /api/subscribers/{id}/sends", { params: { id: subscriber.id } });

    // A failed send, which is what a resend takes.
    const smtpAt = (port: number) => ({
      body: [
        {
          ...settings.smtp[0],
          enabled: true,
          host: sink.host,
          port,
          auth_protocol: "none",
          username: "",
          password: "",
          tls_type: "none",
          email_headers: [],
        },
      ],
    });
    await send("PUT", "/api/settings/smtp", smtpAt(refusing.port));
    const failing = await op("POST /api/tx", {
      body: { subscriber_email: subscriber.email, template_id: txTemplate.id, async: true },
    });
    const failedId = failing.body.data.sends[0].id;
    for (const deadline = Date.now() + 15_000; ; await Bun.sleep(50)) {
      if ((await send("GET", `/api/sends/${failedId}`)).body.data.status === "failed") break;
      check(Date.now() < deadline, "failed-send-wait");
    }
    await send("PUT", "/api/settings/smtp", smtpAt(sink.port));
    await op("POST /api/sends/{id}/resend", { params: { id: failedId } });

    // Events.
    const event = await op("POST /api/subscriber-events", {
      body: {
        subscriber: { email: subscriber.email },
        name: "order_paid",
        data: { price: 1 },
        idempotency_key: "c:1",
      },
    });
    await op("POST /api/subscriber-events/batch", {
      body: {
        events: [
          {
            subscriber: { email: subscriber.email },
            name: "order_paid",
            data: {},
            idempotency_key: "c:2",
          },
        ],
      },
    });
    check(event.body.data, "event");
    await op("GET /api/subscribers/{id}/subscriber-events", { params: { id: subscriber.id } });

    // Sequences and enrollments.
    const definition = {
      name: "contract",
      status: "active",
      trigger: { event: "signup", where: { "data.plan": "a" } },
      exit_on: ["canceled"],
      reentry: "after_exit",
      list_id: list.id,
      steps: [
        { wait: "PT1H", kind: "transactional", template_id: txTemplate.id },
        {
          wait: "P3D",
          kind: "marketing",
          template_id: txTemplate.id,
          condition: { not: { event: "done", since: "trigger" } },
        },
      ],
    };
    const sequence = (await op("POST /api/sequences", { body: definition })).body.data;
    const started = await op("POST /api/subscriber-events", {
      body: {
        subscriber: { email: subscriber.email },
        name: "signup",
        data: { plan: "a" },
      },
    });
    check(started.body.data.enrollments.started.length === 1, "event-started");
    const triggered = started.body.data.enrollments.started[0];
    await op("GET /api/enrollments/{id}/timeline", {
      params: { id: triggered.id },
    });
    const ended = await op("POST /api/subscriber-events", {
      body: { subscriber: { email: subscriber.email }, name: "canceled" },
    });
    check(ended.body.data.enrollments.ended.length === 1, "event-ended");
    await op("GET /api/enrollments/{id}/timeline", {
      params: { id: triggered.id },
    });
    await op("POST /api/subscriber-events/batch", {
      body: { events: [{ subscriber: { email: subscriber.email }, name: "" }] },
    });
    await op("GET /api/sequences");
    await op("GET /api/sequences/{id}", { params: { id: sequence.id } });
    await op("PUT /api/sequences/{id}", {
      params: { id: sequence.id },
      body: { ...definition, name: "contract 2" },
    });
    await op("PUT /api/sequences/{id}/status", {
      params: { id: sequence.id },
      body: { status: "paused" },
    });
    await op("PUT /api/sequences/{id}/status", {
      params: { id: sequence.id },
      body: { status: "active" },
    });
    await op("GET /api/sequences/counts", { query: `?id=${sequence.id}` });
    const enrollment = (
      await op("POST /api/enrollments", {
        body: { sequence_id: sequence.id, subscriber_id: subscriber.id },
      })
    ).body.data;
    await op("GET /api/enrollments");
    await op("GET /api/enrollments/{id}", { params: { id: enrollment.id } });
    await op("GET /api/enrollments/{id}/timeline", { params: { id: enrollment.id } });
    await op("DELETE /api/enrollments/{id}", { params: { id: enrollment.id } });
    // An editor sends the IDs back: a step without one would be replaced, not updated.
    const stored = (await op("GET /api/sequences/{id}", { params: { id: sequence.id } })).body.data;
    const kept = (
      await op("PUT /api/sequences/{id}", {
        params: { id: sequence.id },
        body: {
          ...definition,
          steps: stored.steps.map(({ id, wait, kind, template_id }: Record<string, unknown>) => ({
            id,
            wait,
            kind,
            template_id,
          })),
        },
      })
    ).body.data;
    check(
      kept.steps.every(({ id }: { id: number }, index: number) => id === stored.steps[index].id),
      "sequence-step-ids",
    );
    const forced = (
      await op("POST /api/enrollments", {
        body: { sequence_id: sequence.id, subscriber_id: subscriber.id, force: true },
      })
    ).body.data;
    await op("POST /api/enrollments", {
      body: { sequence_id: sequence.id, subscriber_id: subscriber.id, force: true },
    });
    await op("GET /api/enrollments/{id}", { params: { id: forced.id } });
    // A step outlives its template, and then has none.
    const passing = (
      await op("POST /api/templates", {
        body: { name: "passing", type: "tx", subject: "x", body: "<p>x</p>" },
      })
    ).body.data;
    const orphan = (
      await op("POST /api/sequences", {
        body: {
          name: "orphan",
          status: "draft",
          trigger: { event: "orphan" },
          reentry: "never",
          list_id: list.id,
          steps: [{ wait: "PT1H", kind: "transactional", template_id: passing.id }],
        },
      })
    ).body.data;
    await op("DELETE /api/templates/{id}", { params: { id: passing.id } });
    check(
      (await op("GET /api/sequences/{id}", { params: { id: orphan.id } })).body.data.steps[0]
        .template_id === null,
      "sequence-step-without-template",
    );
    const immediate = (
      await op("POST /api/sequences", {
        body: {
          name: "immediate",
          status: "active",
          trigger: { event: "now" },
          reentry: "never",
          list_id: list.id,
          steps: [
            { wait: "PT0S", kind: "transactional", template_id: txTemplate.id },
            { wait: "P30D", kind: "transactional", template_id: txTemplate.id },
          ],
        },
      })
    ).body.data;
    const running = (
      await op("POST /api/enrollments", {
        body: { sequence_id: immediate.id, subscriber_id: subscriber.id },
      })
    ).body.data;
    for (const deadline = Date.now() + 15_000; ; await Bun.sleep(50)) {
      const timeline = await send("GET", `/api/enrollments/${running.id}/timeline`);
      if (timeline.body.data.entries.some(({ type }: { type: string }) => type === "step")) break;
      check(Date.now() < deadline, "sequence-step-wait");
    }
    await op("GET /api/enrollments/{id}/timeline", { params: { id: running.id } });
    await op("GET /api/sequences/counts", { query: `?id=${immediate.id}` });
    await op("GET /api/subscribers/{id}/enrollments", { params: { id: subscriber.id } });
    await op("GET /api/sends/analytics", { query: "?from=2020-01-01&to=2099-01-01" });
    await op("GET /api/sends/analytics", { query: "?from=2020-01-01&to=2099-01-01&group_by=step" });
    const empty = (
      await op("POST /api/sequences", {
        body: {
          name: "empty",
          status: "draft",
          trigger: { event: "x" },
          reentry: "never",
          list_id: list.id,
          steps: [],
        },
      })
    ).body.data;
    await op("DELETE /api/sequences/{id}", { params: { id: empty.id } });

    // Campaigns.
    const pixel = () => {
      const form = new FormData();
      form.append(
        "file",
        new File(
          [
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
              "base64",
            ),
          ],
          "pixel.png",
          { type: "image/png" },
        ),
      );
      return form;
    };
    const attachment = (await op("POST /api/media", { raw: pixel() })).body.data;
    const campaign = (
      await op("POST /api/campaigns", {
        body: {
          name: "contract",
          subject: "Hi",
          lists: [list.id],
          content_type: "richtext",
          body: '<p><a href="{{ "https://example.test/c" | track_link }}">b</a></p>',
          template_id: campaignTemplate.id,
          tags: ["a"],
        },
      })
    ).body.data;
    await op("GET /api/campaigns");
    await op("GET /api/campaigns", { query: "?no_body=true" });
    await op("GET /api/campaigns/{id}", { params: { id: campaign.id } });
    await op("GET /api/campaigns/{id}/preview", { params: { id: campaign.id } });
    await op("POST /api/campaigns/{id}/preview", {
      params: { id: campaign.id },
      raw: new URLSearchParams({
        body: "<p>x</p>",
        content_type: "richtext",
        template_id: String(campaignTemplate.id),
      }),
    });
    await op("POST /api/campaigns/{id}/text", {
      params: { id: campaign.id },
      raw: new URLSearchParams({ body: "<p>x</p>" }),
    });
    await op("POST /api/campaigns/{id}/preview/archive", {
      params: { id: campaign.id },
      raw: new URLSearchParams({ template_id: String(campaignTemplate.id), archive_meta: "{}" }),
    });
    await op("POST /api/campaigns/{id}/content", {
      params: { id: campaign.id },
      body: { body: "# t", from: "markdown", to: "html", content_type: "markdown" },
    });
    // A plain campaign previews as text, stored or posted; its archive page is still HTML.
    const plain = (
      await op("POST /api/campaigns", {
        body: {
          name: "plain",
          subject: "Plain",
          lists: [list.id],
          content_type: "plain",
          body: "plain {{ subscriber.name }}",
          template_id: campaignTemplate.id,
        },
      })
    ).body.data;
    check(
      (await op("GET /api/campaigns/{id}/preview", { params: { id: plain.id } })).type ===
        "text/plain",
      "plain-preview",
    );
    const plainForm = () => new URLSearchParams({ body: "plain", content_type: "plain" });
    check(
      (await op("POST /api/campaigns/{id}/preview", { params: { id: plain.id }, raw: plainForm() }))
        .type === "text/plain",
      "plain-posted-preview",
    );
    await op("POST /api/campaigns/{id}/text", { params: { id: plain.id }, raw: plainForm() });
    check(
      (
        await op("POST /api/campaigns/{id}/preview/archive", {
          params: { id: plain.id },
          raw: new URLSearchParams({
            template_id: String(campaignTemplate.id),
            archive_meta: "{}",
          }),
        })
      ).type === "text/html",
      "plain-archive-preview",
    );
    await op("POST /api/campaigns/{id}/test", {
      params: { id: campaign.id },
      body: {
        name: "t",
        subject: "t",
        lists: [list.id],
        messenger: "email",
        content_type: "richtext",
        template_id: campaignTemplate.id,
        body: "<p>x</p>",
        subscribers: [subscriber.email],
      },
    });
    await op("PUT /api/campaigns/{id}", {
      params: { id: campaign.id },
      body: { name: "contract 2", subject: "Hi", lists: [list.id], media: [attachment.id] },
    });
    await op("PUT /api/campaigns/{id}/archive", {
      params: { id: campaign.id },
      body: {
        archive: true,
        archive_template_id: campaignTemplate.id,
        archive_slug: "contract",
        archive_meta: {},
      },
    });
    await op("PUT /api/campaigns/{id}/status", {
      params: { id: campaign.id },
      body: { status: "running" },
    });
    await op("GET /api/campaigns/running/stats");
    for (const deadline = Date.now() + 15_000; ; await Bun.sleep(50)) {
      if ((await send("GET", `/api/campaigns/${campaign.id}`)).body.data.status === "finished")
        break;
      check(Date.now() < deadline, "campaign-finish-wait");
    }
    // A view and a click, through the real pixel and redirect.
    const db = new Database(join(target.dataDir, "iglo-email.db"), { readonly: true });
    const link = db.query("SELECT uuid FROM links ORDER BY id DESC LIMIT 1").get() as {
      uuid: string;
    };
    const sendLink = db
      .query("SELECT uuid FROM links WHERE url = 'https://example.test/t'")
      .get() as {
      uuid: string;
    };
    db.close();
    await send("GET", `/campaign/${campaign.uuid}/${subscriber.uuid}/px.png`, { auth: null });
    await send("GET", `/link/${link.uuid}/${campaign.uuid}/${subscriber.uuid}`, { auth: null });
    for (const type of ["views", "clicks", "bounces", "links"])
      await op("GET /api/campaigns/analytics/{type}", {
        params: { type },
        query: `?id=${campaign.id}&from=2020-01-01&to=2099-01-01`,
      });
    for (const type of ["views", "clicks", "bounces", "links"])
      await op("GET /api/lists/analytics/{type}", {
        params: { type },
        query: `?id=${list.id}&from=2020-01-01&to=2099-01-01`,
      });
    // A send's view and click have no campaign. Every tracked row is shown, and cleared.
    await send("GET", `/m/${send0.uuid}/px.png`, { auth: null });
    await send("GET", `/m/${send0.uuid}/link/${sendLink.uuid}`, { auth: null });
    const tracked = (
      await op("GET /api/subscribers/{id}/activity", { params: { id: subscriber.id } })
    ).body.data;
    check(
      tracked.campaign_views.some((row: { id: unknown }) => row.id === null) &&
        tracked.campaign_views.some((row: { id: unknown }) => row.id === campaign.id) &&
        tracked.link_clicks.some((row: { campaign_id: unknown }) => row.campaign_id === null) &&
        tracked.link_clicks.some(
          (row: { campaign_id: unknown }) => row.campaign_id === campaign.id,
        ),
      "activity-of-sends",
    );
    const exported = await op("GET /api/subscribers/{id}/export", {
      params: { id: subscriber.id },
    });
    check(exported.body.sends.length && exported.body.events.length, "export-native-sections");
    await op("GET /api/subscribers/{id}/activity", { params: { id: other.id } });
    for (const type of ["campaign_views", "link_clicks"])
      await op("DELETE /api/subscribers/{id}/activity/{type}", {
        params: { id: subscriber.id, type },
      });
    await op("DELETE /api/subscribers/{id}/activity/{type}", {
      params: { id: subscriber.id, type: "views" },
      expect: 400,
    });
    check(
      JSON.stringify(
        (await op("GET /api/subscribers/{id}/activity", { params: { id: subscriber.id } })).body
          .data,
      ) === '{"campaign_views":[],"link_clicks":[]}',
      "activity-cleared",
    );

    await op("GET /api/dashboard/counts");
    await op("GET /api/dashboard/charts");
    await op("GET /api/dashboard/campaigns");
    const dropped = (
      await op("POST /api/campaigns", {
        body: { name: "doomed", subject: "x", lists: [list.id], content_type: "html", body: "x" },
      })
    ).body.data;
    await op("DELETE /api/campaigns/{id}", { params: { id: dropped.id } });
    const dropped2 = (
      await op("POST /api/campaigns", {
        body: { name: "doomed", subject: "x", lists: [list.id], content_type: "html", body: "x" },
      })
    ).body.data;
    await op("DELETE /api/campaigns", { query: `?id=${dropped2.id}` });

    // Media.
    const media = (await op("POST /api/media", { raw: pixel() })).body.data;
    await op("GET /api/media");
    await op("GET /api/media/{id}", { params: { id: media.id } });
    await op("DELETE /api/media/{id}", { params: { id: media.id } });

    // Import.
    await op("GET /api/import/subscribers");
    await op("GET /api/import/subscribers/logs");
    const csv = new FormData();
    csv.append(
      "params",
      JSON.stringify({
        mode: "subscribe",
        subscription_status: "confirmed",
        delim: ",",
        lists: [list.id],
        overwrite: true,
      }),
    );
    csv.append(
      "file",
      new File(['email,name,attributes\nimported@fixture.test,Imported,"{}"\n'], "import.csv", {
        type: "text/csv",
      }),
    );
    await op("POST /api/import/subscribers", { raw: csv });
    for (const deadline = Date.now() + 10_000; ; await Bun.sleep(25)) {
      if ((await send("GET", "/api/import/subscribers")).body.data.status !== "importing") break;
      check(Date.now() < deadline, "import-wait");
    }
    await op("GET /api/import/subscribers");
    await op("DELETE /api/import/subscribers");

    // Bounces.
    await op("POST /webhooks/bounce", {
      body: {
        email: other.email,
        type: "soft",
        source: "contract",
        meta: { a: 1 },
        campaign_uuid: campaign.uuid,
      },
    });
    await op("GET /api/subscribers/{id}/bounces", { params: { id: other.id } });
    const now = Math.floor(Date.now() / 1000);
    await op("POST /webhooks/bounce/mailgun", {
      auth: null,
      body: {
        signature: {
          timestamp: String(now),
          token: "t".repeat(32),
          signature: createHmac("sha256", signingKey)
            .update(`${now}${"t".repeat(32)}`)
            .digest("hex"),
        },
        "event-data": {
          id: "e1",
          event: "failed",
          severity: "permanent",
          recipient: other.email,
          reason: "bounce",
          timestamp: now,
          "user-variables": {},
        },
      },
    });
    await op("POST /webhooks/service/{service}", {
      params: { service: "ses" },
      auth: null,
      expect: 400,
    });
    const bounces = (await op("GET /api/bounces")).body.data.results;
    await op("GET /api/bounces/{id}", { params: { id: bounces[0].id } });
    await op("DELETE /api/bounces/{id}", { params: { id: bounces[0].id } });
    await op("PUT /api/bounces/blocklist", { query: `?id=${bounces[1].id}` });
    await op("DELETE /api/bounces", { query: "?all=true" });
    await op("DELETE /api/subscribers/{id}/bounces", { params: { id: other.id } });

    // Webhooks.
    const hook = (
      await op("POST /api/webhooks", {
        body: { url: receiver.url(), events: ["subscriber.blocklisted"] },
      })
    ).body.data;
    await op("GET /api/webhooks");
    await op("PUT /api/webhooks/{id}", { params: { id: hook.id }, body: { enabled: true } });
    await op("PUT /api/subscribers/{id}/blocklist", { params: { id: other.id } });
    await op("PUT /api/subscribers/blocklist", { body: { ids: [external.id] } });
    await receiver.waitFor(1);
    await op("GET /api/webhooks/{id}/deliveries", { params: { id: hook.id } });
    await op("DELETE /api/webhooks/{id}", { params: { id: hook.id } });

    // Public.
    await op("GET /api/public/lists", { auth: null });
    await op("GET /api/public/archive", { auth: null });
    await op("POST /api/public/subscription", {
      auth: null,
      body: { name: "P", email: "public@fixture.test", list_uuids: [list.uuid] },
    });
    await op("GET /api/public/captcha/altcha", { auth: null, expect: 404 });

    // Settings and logs.
    await op("GET /api/settings");
    await op("PUT /api/settings/{key}", { params: { key: "app.site_name" }, body: "Contract" });
    await op("PUT /api/settings", { body: (await send("GET", "/api/settings")).body.data });
    await op("POST /api/settings/smtp/test", {
      body: {
        ...settings.smtp[0],
        enabled: true,
        host: sink.host,
        port: sink.port,
        auth_protocol: "none",
        username: "",
        password: "",
        tls_type: "none",
        email_headers: [],
        email: "smtp-test@fixture.test",
      },
    });
    // A configured instance: fields that exist only once set come back, with the secrets masked.
    const current = (await op("GET /api/settings")).body.data;
    const added = { ...current["bounce.mailboxes"][0] };
    delete added.uuid;
    await op("PUT /api/settings", {
      body: {
        ...current,
        smtp: [
          {
            ...current.smtp[0],
            dkim: {
              domain_name: "fixture.test",
              key_selector: "s1",
              private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
                type: "pkcs8",
                format: "pem",
              }),
            },
          },
        ],
        "upload.s3.aws_secret_access_key": "s3-secret",
        "bounce.sendgrid_key": "sendgrid-secret",
        "bounce.mailboxes": [
          { ...current["bounce.mailboxes"][0], password: "" },
          { ...added, password: "mailbox-secret" },
        ],
      },
    });
    const configured = (await op("GET /api/settings")).body.data;
    check(
      /^•+$/.test(configured.smtp[0].dkim.private_key) &&
        /^•+$/.test(configured["upload.s3.aws_secret_access_key"]) &&
        /^•+$/.test(configured["bounce.sendgrid_key"]),
      "settings-masked",
    );
    // A client leaves the masked key out of its save by blanking it.
    await op("PUT /api/settings", {
      body: {
        ...configured,
        smtp: [{ ...configured.smtp[0], dkim: { ...configured.smtp[0].dkim, private_key: "" } }],
      },
    });
    check(
      (await op("GET /api/settings")).body.data.smtp[0].dkim.domain_name === "fixture.test",
      "settings-dkim-kept",
    );
    await op("GET /api/logs");

    // Session-only: a human's second factor, then logout.
    const cookies = await session(target.baseUrl, target.admin);
    const self = (await send("GET", "/api/profile", { auth: null, headers: cookies })).body.data.id;
    await op("GET /api/profile", { auth: null, headers: cookies });
    const factor = (
      await op("GET /api/users/{id}/twofa/totp", {
        params: { id: self },
        auth: null,
        headers: cookies,
      })
    ).body.data;
    await op("PUT /api/users/{id}/twofa", {
      params: { id: self },
      auth: null,
      headers: cookies,
      body: { secret: factor.secret, code: totp(factor.secret) },
    });
    await op("DELETE /api/users/{id}/twofa", {
      params: { id: self },
      auth: null,
      headers: cookies,
      body: { password: target.admin.password },
    });
    await op("POST /api/logout", { auth: null, headers: cookies });

    // Maintenance.
    await op("DELETE /api/maintenance/subscribers/{type}", { params: { type: "orphan" } });
    await op("DELETE /api/maintenance/analytics/{type}", {
      params: { type: "views" },
      query: "?before_date=2000-01-01T00:00:00Z",
    });
    await op("GET /api/maintenance/analytics/{type}/export", {
      params: { type: "clicks" },
      query: "?since=2000-01-01T00:00:00Z",
    });
    await op("DELETE /api/maintenance/subscriptions/unconfirmed", {
      query: "?before_date=2000-01-01T00:00:00Z",
    });

    for (const external_id of ["ext-4", "ext-5"])
      await op("POST /api/subscribers", {
        body: {
          email: `${external_id}@fixture.test`,
          name: "E",
          status: "enabled",
          lists: [list.id],
          external_id,
        },
      });
    await op("DELETE /api/subscribers/external/{external_id}", {
      params: { external_id: "ext-4" },
    });
    await op("DELETE /api/subscribers/external", { query: "?external_id=ext-5" });
    await op("DELETE /api/subscribers/{id}", { params: { id: other.id } });
    await op("DELETE /api/subscribers", { query: `?id=${subscriber.id}` });
    await op("DELETE /api/templates/{id}", { params: { id: txTemplate.id } });

    // Dropped in 07: each is a plain 404, not a hidden route.
    for (const path of ["/api/config", "/api/lang/en", "/api/about", "/api/events"])
      check((await send("GET", path)).status === 404, `dropped-${path}`);

    // Every protected operation refuses without a credential, in the error envelope.
    const operations = Object.entries(document.paths).flatMap(([template, item]) =>
      Object.entries(item as Record<string, any>).map(([method, operation]) => ({
        key: `${method.toUpperCase()} ${template}`,
        operation,
      })),
    );
    const placeholders = (key: string, id: string): Options => ({
      params: Object.fromEntries(
        [...key.matchAll(/\{(\w+)\}/g)].map(([, name]) => [name!, name === "id" ? id : "x"]),
      ),
    });
    const secured = operations.filter(({ operation }) => operation.security?.length !== 0);
    for (const { key } of secured)
      await op(key, { ...placeholders(key, "999999"), auth: null, expect: 403 });

    // And names its permission to a caller without one.
    const none = (
      await send("POST", "/api/roles/users", { body: { name: "none", permissions: [] } })
    ).body.data;
    const caller = (
      await send("POST", "/api/users", {
        body: { username: "none", type: "api", status: "enabled", user_role_id: none.id },
      })
    ).body.data;
    const denied = `Basic ${btoa(`none:${caller.password}`)}`;
    for (const { key, operation } of operations) {
      const permissions = operation["x-required-permissions"] as string[] | undefined;
      if (!permissions) continue;
      const reply = await op(key, { ...placeholders(key, "999999"), auth: denied, expect: 403 });
      check(reply.body.message === `permission denied: ${permissions[0]}`, `permission-${key}`);
    }

    // A malformed ID, and a well-formed one nothing has.
    for (const { key, operation } of operations) {
      if (operation.responses["400"] && key.includes("{id}") && !key.includes("twofa"))
        await op(key, { ...placeholders(key, "not-a-number"), expect: 400 });
      if (operation.responses["404"] && key.includes("{id}") && !operation.requestBody)
        await op(key, { ...placeholders(key, "999999"), expect: 404 });
    }

    // Nothing documented went unexercised.
    for (const name of Object.keys(document.components.schemas))
      check(checked.has(name), `unchecked-schema-${name}`);
    for (const { key, operation } of operations) {
      const statuses = seen.get(key);
      check(statuses, `unexercised-${key}`);
      if (operation.responses["200"]) check(statuses!.has(200), `no-success-${key}`);
    }
  } finally {
    receiver.close();
    refusing.stop(true);
  }
}
