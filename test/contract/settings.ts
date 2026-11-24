// Reference: listmonk cmd/settings.go, models/settings.go and queries/misc.sql at 6fcd95f.
import { listmonkEnvelope } from "@/test/contract/envelope";
import { runSettingsCouncilParser } from "@/test/contract/settings-council-parser";
import { runSettingsNul } from "@/test/contract/settings-nul";
import { runSettingsCouncilSmall } from "@/test/contract/settings-council-small";
import { runSettingsNewItems } from "@/test/contract/settings-new-items";
import { runSettingsCouncilFinal } from "@/test/contract/settings-council-final";
import { runSettingsBinding } from "@/test/contract/settings-binding";
import {
  invalidSettingsReadEnd,
  settingsFetch,
  upstreamLogSize,
} from "@/test/contract/settings-reference-fetch";
import type { Credentials, Mode } from "@/test/contract/types";
import { asBody } from "@/test/read-body";

function check(condition: unknown, label: string): asserts condition {
  if (!condition) {
    throw new Error(`FAIL settings-${label}`);
  }
}

export async function runSettingsContract(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
  restart?: () => Promise<void>;
}) {
  const authorization = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const request = (path: string, method = "GET", body?: string, auth = authorization) =>
    settingsFetch(
      `${target.baseUrl}${path}`,
      {
        method,
        headers: {
          ...(auth ? { Authorization: auth } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
      },
      target.mode === "reference",
    );
  check((await request("/api/settings", "GET", undefined, "")).status === 403, "unauthenticated");
  const response = await request("/api/settings");
  check(response.status === 200, "get");
  const snapshot = asBody<{ data: Record<string, any> }>(await response.json()).data;
  check(
    typeof snapshot["app.site_name"] === "string" && typeof snapshot["app.batch_size"] === "number",
    "scalar-types",
  );
  check(Array.isArray(snapshot.smtp) && Array.isArray(snapshot["app.from_email"]), "array-types");
  check(typeof snapshot["security.captcha"].hcaptcha.secret === "string", "nested-projection");
  check(
    snapshot.smtp.every(
      (item: { password?: string }) => !item.password || /^•+$/.test(item.password),
    ),
    "password-mask",
  );
  const bad = await request("/api/settings", "PUT", "{}");
  check(
    bad.status === 400 &&
      JSON.stringify(listmonkEnvelope(await bad.json(), target.mode, bad.status)) ===
        JSON.stringify({ message: "at least one `from` address is required" }),
    "empty-full",
  );
  const malformed = await request("/api/settings", "PUT", "{");
  check(malformed.status === 400, "malformed");
  const after = asBody<{ data: Record<string, any> }>(
    await (await request("/api/settings")).json(),
  ).data;
  check(JSON.stringify(after) === JSON.stringify(snapshot), "invalid-no-write");
  // Order-independent: it finds its items by host and restores the snapshot it read.
  await runSettingsNewItems(target);
  await runSettingsNul(target);
  await runSettingsCouncilSmall(target);
  await runSettingsCouncilParser(target);
  await runSettingsBinding(target);
  await runSettingsCouncilFinal(target);
  const form = await settingsFetch(
    `${target.baseUrl}/api/settings`,
    {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "AppFromEmail=sender%40example.invalid",
    },
    target.mode === "reference",
  );
  check(
    form.status === 400 &&
      JSON.stringify(listmonkEnvelope(await form.json(), target.mode, form.status)) ===
        JSON.stringify({ message: "at least one `from` address is required" }),
    "form-no-tags",
  );
  const xml = await settingsFetch(
    `${target.baseUrl}/api/settings`,
    {
      method: "PUT",
      headers: { Authorization: authorization, "Content-Type": "application/xml" },
      // AppLang, UploadProvider and the SMTP pool fields stay set: upstream stores a missing one as "" and exits on the next reload
      // (app.lang panic at cmd/main.go:211, "unknown provider" fatal at cmd/init.go:852, invalid duration at cmd/init.go:747, MaxConns at cmd/init.go:777).
      body: "<Settings><AppLang>en</AppLang><UploadProvider>filesystem</UploadProvider><AppFromEmail>sender@example.invalid</AppFromEmail><AppBatchSize>9223372036854775807</AppBatchSize><SMTP><Enabled>true</Enabled><MaxConns>1</MaxConns><IdleTimeout>15s</IdleTimeout><WaitTimeout>5s</WaitTimeout></SMTP><SecuritySessionDuration>7d</SecuritySessionDuration></Settings>",
    },
    target.mode === "reference",
  );
  check(xml.status === 200, "xml-full-write");
  check(
    JSON.stringify(
      asBody<{ data: Record<string, any> }>(await (await request("/api/settings")).json()).data[
        "app.from_email"
      ],
    ) === '["sender@example.invalid"]',
    "xml-projection",
  );
  check(
    /"app.batch_size"\s*:\s*9223372036854775807(?:[,}])/.test(
      await (await request("/api/settings")).text(),
    ),
    "xml-int64-projection",
  );
  const smtpTest = await request("/api/settings/smtp/test", "POST", "{}");
  if (target.mode === "reference") {
    check(smtpTest.status === 400, "smtp-test-reference-missing-email");
  } else {
    check(smtpTest.status === 400, "smtp-test-missing-email");
  }
  const candidate = structuredClone(snapshot);
  candidate["app.from_email"] = [
    "  Example <sender@example.invalid>  ",
    "Example <sender@example.invalid>",
  ];
  candidate["privacy.domain_blocklist"] = ["  EXAMPLE.COM ", ""];
  candidate["upload.extensions"] = [" .JPG ", "PNG"];
  candidate.smtp = asBody<Array<Record<string, unknown>>>(candidate.smtp).map((item, index) => ({
    ...item,
    name: index === 0 ? " My Server " : "",
    password: "",
    host: ` ${item.host} `,
  }));
  candidate["bounce.mailboxes"] = asBody<Array<Record<string, unknown>>>(
    candidate["bounce.mailboxes"],
  ).map((item) => ({ ...item, password: "" }));
  const write = await request("/api/settings", "PUT", JSON.stringify(candidate));
  check(
    write.status === 200 && JSON.stringify(await write.json()) === '{"data":true}',
    "full-write",
  );
  const updated = asBody<{ data: Record<string, any> }>(
    await (await request("/api/settings")).json(),
  ).data;
  check(
    JSON.stringify(updated["app.from_email"]) === '["Example <sender@example.invalid>"]',
    "from-normalization",
  );
  check(
    JSON.stringify(updated["privacy.domain_blocklist"]) === '["example.com"]',
    "domain-normalization",
  );
  check(
    JSON.stringify(updated["upload.extensions"]) === '["jpg","png"]',
    "extension-normalization",
  );
  check(
    updated.smtp[0].name === "email-my-server" && updated.smtp[0].host === snapshot.smtp[0].host,
    "smtp-normalization",
  );
  check(typeof updated.smtp[0].uuid === "string" && updated.smtp[0].uuid.length > 0, "smtp-uuid");
  // A nonempty messenger list through its whole life: add, mask, keep a blank password by uuid,
  // refuse bad names, rename and remove.
  const messengerPut = async (messengers: Array<unknown>) =>
    request("/api/settings", "PUT", JSON.stringify({ ...updated, messengers }));
  const messengerGet = async () =>
    asBody<{ data: { messengers: Array<Record<string, any>> } }>(
      await (await request("/api/settings")).json(),
    ).data.messengers;
  const postback = {
    uuid: "",
    enabled: true,
    name: " My-Post_Back ",
    root_url: "http://127.0.0.1:9/postback",
    username: "hook",
    password: "secret",
    max_conns: 2,
    timeout: "5s",
    max_msg_retries: 1,
  };
  check((await messengerPut([postback])).status === 200, "messenger-add");
  let listed = await messengerGet();
  check(
    listed.length === 1 &&
      listed[0]!.name === "my-postback" &&
      typeof listed[0]!.uuid === "string" &&
      listed[0]!.uuid.length > 0 &&
      listed[0]!.password === "••••••" &&
      listed[0]!.root_url === postback.root_url &&
      listed[0]!.max_conns === 2,
    "messenger-projection",
  );
  const kept = { ...listed[0], password: "", timeout: "7s" } as Record<string, any>;
  check((await messengerPut([kept])).status === 200, "messenger-keep-password");
  listed = await messengerGet();
  check(
    listed.length === 1 &&
      listed[0]!.uuid === kept.uuid &&
      listed[0]!.password === "••••••" &&
      listed[0]!.timeout === "7s",
    "messenger-keep-password-projection",
  );
  check(
    (await messengerPut([{ ...kept, password: "longer-secret" }])).status === 200 &&
      (await messengerGet())[0]!.password === "•".repeat("longer-secret".length),
    "messenger-change-password",
  );
  for (const [label, names] of [
    ["duplicate", ["dup", "DUP"]],
    ["reserved", ["email"]],
    ["empty", ["  "]],
    ["empty-after-cleaning", ["___"]],
  ] as const) {
    check(
      (await messengerPut(names.map((name) => ({ ...postback, name })))).status === 400,
      `messenger-name-${label}`,
    );
  }
  check(
    (await messengerGet()).length === 1 && (await messengerGet())[0]!.uuid === kept.uuid,
    "messenger-refusal-atomic",
  );
  check((await messengerPut([{ ...kept, name: "Renamed" }])).status === 200, "messenger-rename");
  listed = await messengerGet();
  check(
    listed.length === 1 && listed[0]!.name === "renamed" && listed[0]!.uuid === kept.uuid,
    "messenger-rename-projection",
  );
  check((await messengerPut([])).status === 200, "messenger-remove");
  check((await messengerGet()).length === 0, "messenger-removed");
  const addressCandidate = structuredClone(updated);
  addressCandidate["app.from_email"] = ['"Display, Name" <"quoted local"@example.invalid>'];
  check(
    (await request("/api/settings", "PUT", JSON.stringify(addressCandidate))).status === 200,
    "quoted-from-address",
  );
  check(
    asBody<{ data: Record<string, any> }>(await (await request("/api/settings")).json()).data[
      "app.from_email"
    ][0] === addressCandidate["app.from_email"][0],
    "quoted-from-projection",
  );
  const addressMatrix = structuredClone(updated);
  addressMatrix["app.from_email"] = [
    '"" <sender@example.invalid>',
    "sender@example.invalid (Example)",
    "Müller <üñî@example.invalid>",
    "sender@[IPv6:::1]",
    "Group: sender@example.invalid;",
  ];
  check(
    (await request("/api/settings", "PUT", JSON.stringify(addressMatrix))).status === 200,
    "from-matrix-write",
  );
  check(
    JSON.stringify(
      asBody<{ data: Record<string, any> }>(await (await request("/api/settings")).json()).data[
        "app.from_email"
      ],
    ) === JSON.stringify(addressMatrix["app.from_email"]),
    "from-matrix-projection",
  );
  addressMatrix["app.from_email"] = ["bad..local@example.invalid"];
  check(
    (await request("/api/settings", "PUT", JSON.stringify(addressMatrix))).status === 400,
    "from-invalid",
  );
  addressMatrix["app.from_email"] = ["=?x-unknown?Q?abc?= <a@example.invalid>"];
  check(
    (await request("/api/settings", "PUT", JSON.stringify(addressMatrix))).status === 400,
    "from-unsupported-encoded-name",
  );
  // B117a (D136): the values below are refused on save by this build. Upstream stores them as sent, and
  // its reload would exit on one it cannot read, so only the compiled build is written here.
  if (target.mode !== "reference") {
    const base = structuredClone(updated);
    // Passwords are masked on read; an empty one keeps the stored secret by uuid.
    base.smtp = asBody<Array<Record<string, unknown>>>(base.smtp).map((item) => ({
      ...item,
      password: "",
    }));
    const put = (body: Record<string, unknown>) =>
      request("/api/settings", "PUT", JSON.stringify(body));
    const settingsNow = async () =>
      asBody<{ data: Record<string, any> }>(await (await request("/api/settings")).json()).data;
    for (const [label, body] of [
      ["notify-not-an-address", { ...base, "app.notify_emails": ["not-an-address"] }],
      ["notify-second-invalid", { ...base, "app.notify_emails": ["ops@example.test", "ops@"] }],
      [
        "vacuum-bad-cron",
        { ...base, "maintenance.db": { vacuum: true, vacuum_cron_interval: "bad cron" } },
      ],
      [
        "sliding-empty",
        { ...base, "app.message_sliding_window": true, "app.message_sliding_window_duration": "" },
      ],
      [
        "sliding-zero",
        { ...base, "app.message_sliding_window": true, "app.message_sliding_window_duration": "0" },
      ],
      [
        "sliding-1ms",
        {
          ...base,
          "app.message_sliding_window": true,
          "app.message_sliding_window_duration": "1ms",
        },
      ],
      [
        "sliding-word",
        { ...base, "app.message_sliding_window": true, "app.message_sliding_window_duration": "x" },
      ],
      ["s3-expiry-word", { ...base, "upload.s3.expiry": "x" }],
      ["s3-expiry-zero", { ...base, "upload.s3.expiry": "0s" }],
      ["smtp-idle-1ms", { ...base, smtp: [{ ...base.smtp[0], idle_timeout: "1ms" }] }],
      ["smtp-idle-over-5m", { ...base, smtp: [{ ...base.smtp[0], idle_timeout: "5m1s" }] }],
      ["smtp-retry-word", { ...base, smtp: [{ ...base.smtp[0], msg_retry_delay: "x" }] }],
      ["from-no-charset", { ...base, "app.from_email": ["=?Q?abc?= <a@example.invalid>"] }],
      ["from-empty-charset", { ...base, "app.from_email": ["=??Q?abc?= <a@example.invalid>"] }],
      [
        "from-unknown-encoding",
        { ...base, "app.from_email": ["=?utf-8?X?abc?= <a@example.invalid>"] },
      ],
      ["trusted-port", { ...base, "security.trusted_urls": ["https://example.invalid:99999"] }],
      [
        "trusted-userinfo",
        { ...base, "security.trusted_urls": ["https://user:pass@example.invalid"] },
      ],
    ] as const) {
      check((await put(body)).status === 400, label);
    }
    // The accepted side of each rule, then one restore of the stored settings.
    const accepted = await put({
      ...base,
      "app.notify_emails": ["ops@example.test", " "],
      "maintenance.db": { vacuum: false, vacuum_cron_interval: "bad cron" },
      "app.message_sliding_window": true,
      "app.message_sliding_window_duration": "1h",
      "upload.s3.expiry": "167h",
      smtp: [{ ...base.smtp[0], idle_timeout: "15s", msg_retry_delay: "" }],
      "security.trusted_urls": ["https://example.invalid"],
    });
    check(accepted.status === 200, "accepted-side");
    const stored = await settingsNow();
    check(
      JSON.stringify(stored["app.notify_emails"]) === '["ops@example.test",""]',
      "accepted-notify-projection",
    );
    check((await put(base)).status === 200, "restore-after-accepted-side");
    check(
      JSON.stringify((await settingsNow())["app.notify_emails"]) ===
        JSON.stringify(updated["app.notify_emails"]),
      "restore-notify-projection",
    );
  }
  const cronCandidate = structuredClone(updated);
  cronCandidate["app.cache_slow_queries"] = true;
  cronCandidate["app.cache_slow_queries_interval"] = "not a cron";
  check(
    (await request("/api/settings", "PUT", JSON.stringify(cronCandidate))).status === 400,
    "invalid-enabled-cron",
  );
  cronCandidate["app.cache_slow_queries_interval"] = "0 0 * JAN/DEC *";
  check(
    (await request("/api/settings", "PUT", JSON.stringify(cronCandidate))).status === 400,
    "invalid-cron-named-step",
  );
  cronCandidate["app.cache_slow_queries_interval"] = "0 3 L * MON-FRI";
  check(
    (await request("/api/settings", "PUT", JSON.stringify(cronCandidate))).status === 200,
    "valid-enabled-cron",
  );
  cronCandidate["app.cache_slow_queries"] = false;
  cronCandidate["app.cache_slow_queries_interval"] = "invalid but unused";
  check(
    (await request("/api/settings", "PUT", JSON.stringify(cronCandidate))).status === 200,
    "disabled-unused-cron",
  );
  check(
    (await request("/api/settings/app.check_updates", "PUT", "false")).status === 200,
    "check-updates-false",
  );
  const invalidDuration = await request("/api/settings/security.session_duration", "PUT", '"0s"');
  check(invalidDuration.status === (target.mode === "reference" ? 200 : 400), "duration-d45");
  check(
    (await request("/api/settings/security.session_duration", "PUT", '"7d"')).status === 200,
    "duration-restore",
  );
  const ordered = JSON.stringify(updated).replace(
    /"app.site_name":"[^"]*"/,
    '"app.site_name":"first","APP.SITE_NAME":"second","app.site_name":null',
  );
  check((await request("/api/settings", "PUT", ordered)).status === 200, "ordered-write");
  check(
    asBody<{ data: Record<string, any> }>(await (await request("/api/settings")).json()).data[
      "app.site_name"
    ] === "second",
    "ordered-alias-null",
  );
  const integerCandidate = JSON.stringify(updated).replace(
    /"app.batch_size":\d+/,
    '"app.batch_size":9007199254740993',
  );
  check((await request("/api/settings", "PUT", integerCandidate)).status === 200, "int64-write");
  const integerProjection = await (await request("/api/settings")).text();
  check(
    /"app.batch_size"\s*:\s*9007199254740993(?:[,}])/.test(integerProjection),
    "int64-exact-projection",
  );
  if (target.restart) {
    await target.restart();
    check(
      /"app.batch_size"\s*:\s*9007199254740993(?:[,}])/.test(
        await (await request("/api/settings")).text(),
      ),
      "int64-restart",
    );
  }
  for (const integer of ["9223372036854775807", "-9223372036854775808"]) {
    const body = integerCandidate.replace("9007199254740993", integer);
    check(
      (await request("/api/settings", "PUT", body)).status === 200,
      `int64-boundary-${integer.startsWith("-") ? "min" : "max"}`,
    );
    check(
      (await (await request("/api/settings")).text()).includes(`"app.batch_size":${integer}`),
      `int64-boundary-projection-${integer.startsWith("-") ? "min" : "max"}`,
    );
  }
  for (const integer of ["9223372036854775808", "1.0", "1e2"]) {
    const body = integerCandidate.replace("9007199254740993", integer);
    check((await request("/api/settings", "PUT", body)).status === 400, `int64-invalid-${integer}`);
  }
  check(
    (await request("/api/settings", "PUT", JSON.stringify(updated))).status === 200,
    "int64-restore",
  );
  const key = await request(
    "/api/settings/app.site_name",
    "PUT",
    JSON.stringify("Synthetic settings"),
  );
  check(key.status === 200 && JSON.stringify(await key.json()) === '{"data":true}', "key-write");
  const xmlKey = await settingsFetch(
    `${target.baseUrl}/api/settings/app.site_name`,
    {
      method: "PUT",
      headers: { Authorization: authorization, "Content-Type": "application/xml" },
      body: '<value>"XML value"</value>',
    },
    target.mode === "reference",
  );
  check(
    xmlKey.status === 200 && JSON.stringify(await xmlKey.json()) === '{"data":true}',
    "key-xml-write",
  );
  check(
    asBody<{ data: Record<string, any> }>(await (await request("/api/settings")).json()).data[
      "app.site_name"
    ] === "XML value",
    "key-xml-projection",
  );
  const formKey = await settingsFetch(
    `${target.baseUrl}/api/settings/app.site_name`,
    {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "value=form",
    },
    target.mode === "reference",
  );
  check(
    formKey.status === 400 &&
      JSON.stringify(listmonkEnvelope(await formKey.json(), target.mode, formKey.status)) ===
        '{"message":"Bad Request"}',
    "key-form-bad-request",
  );
  check(
    (await request("/api/settings/app.site_name", "PUT", JSON.stringify("Synthetic settings")))
      .status === 200,
    "key-restore",
  );
  check(
    asBody<{ data: Record<string, any> }>(await (await request("/api/settings")).json()).data[
      "app.site_name"
    ] === "Synthetic settings",
    "key-read",
  );
  const unknown = await request("/api/settings/unknown.setting", "PUT", "true");
  check(unknown.status === (target.mode === "reference" ? 200 : 400), "unknown-key-d44");
  // The reference log's size before the invalid write: its exit line is searched for after this (B114).
  const logFrom = upstreamLogSize();
  const malformedKey = await request("/api/settings/app.batch_size", "PUT", '"not-an-integer"');
  check(malformedKey.status === (target.mode === "reference" ? 200 : 400), "invalid-key-d44");
  if (target.mode === "reference") {
    // Last reference step. Upstream's accepted write schedules a reload that exits on the
    // stored invalid value, so the read is a race: accept only its two documented end states.
    const end = await invalidSettingsReadEnd(
      `${target.baseUrl}/api/settings`,
      { headers: { Authorization: authorization } },
      logFrom,
    );
    check(end !== "unexpected", "invalid-key-read-d44");
  } else {
    const finalGet = await request("/api/settings");
    check(finalGet.status === 200, "invalid-key-read-d44");
    check(
      asBody<{ data: Record<string, any> }>(await finalGet.json()).data["app.batch_size"] ===
        snapshot["app.batch_size"],
      "invalid-key-rollback",
    );
    if (target.restart) {
      await target.restart();
      const persisted = asBody<{ data: Record<string, any> }>(
        await (await request("/api/settings")).json(),
      ).data;
      check(
        persisted["app.site_name"] === "Synthetic settings" &&
          persisted.smtp[0].uuid === updated.smtp[0].uuid,
        "restart-persistence",
      );
    }
  }
}

if (import.meta.main) {
  try {
    if (process.argv[2] !== "reference") {
      throw new Error("Invalid mode");
    }
    const {
      REFERENCE_URL: baseUrl,
      REFERENCE_API_USER: user,
      REFERENCE_API_TOKEN: token,
    } = process.env;
    if (!baseUrl || !user || !token) {
      throw new Error("Missing reference credentials");
    }
    await runSettingsContract({ mode: "reference", baseUrl, credentials: { user, token } });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-]+( \([ -~]*\))?$/.test(error.message) ? error.message : "Settings contract failed"}\n`,
    );
    process.exitCode = 1;
  }
}
