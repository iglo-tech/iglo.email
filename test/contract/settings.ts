// Reference: listmonk cmd/settings.go, models/settings.go and queries/misc.sql at 6fcd95f.
import { runSettingsCouncilParser } from "@/test/contract/settings-council-parser";
import { runSettingsNul } from "@/test/contract/settings-nul";
import { runSettingsCouncilSmall } from "@/test/contract/settings-council-small";
import { runSettingsCouncilFinal } from "@/test/contract/settings-council-final";
import { runSettingsBinding } from "@/test/contract/settings-binding";
import { settingsFetch } from "@/test/contract/settings-reference-fetch";
import type { Credentials, Mode } from "@/test/contract/types";

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
  function check(condition: unknown, label: string): asserts condition {
    if (!condition) throw new Error(`FAIL settings-${label}`);
  }
  check((await request("/api/settings", "GET", undefined, "")).status === 403, "unauthenticated");
  const response = await request("/api/settings");
  check(response.status === 200, "get");
  const snapshot = ((await response.json()) as { data: Record<string, any> }).data;
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
      JSON.stringify(await bad.json()) ===
        JSON.stringify({ message: "at least one `from` address is required" }),
    "empty-full",
  );
  const malformed = await request("/api/settings", "PUT", "{");
  check(malformed.status === 400, "malformed");
  const after = ((await (await request("/api/settings")).json()) as { data: Record<string, any> })
    .data;
  check(JSON.stringify(after) === JSON.stringify(snapshot), "invalid-no-write");
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
      JSON.stringify(await form.json()) ===
        JSON.stringify({ message: "at least one `from` address is required" }),
    "form-no-tags",
  );
  const xml = await settingsFetch(
    `${target.baseUrl}/api/settings`,
    {
      method: "PUT",
      headers: { Authorization: authorization, "Content-Type": "application/xml" },
      body: "<Settings><AppFromEmail>sender@example.invalid</AppFromEmail><AppBatchSize>9223372036854775807</AppBatchSize><SMTP><Enabled>true</Enabled></SMTP><SecuritySessionDuration>7d</SecuritySessionDuration></Settings>",
    },
    target.mode === "reference",
  );
  check(xml.status === 200, "xml-full-write");
  check(
    JSON.stringify(
      ((await (await request("/api/settings")).json()) as { data: Record<string, any> }).data[
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
  candidate.smtp = candidate.smtp.map((item: Record<string, unknown>, index: number) => ({
    ...item,
    name: index === 0 ? " My Server " : "",
    password: "",
    host: ` ${item.host} `,
  }));
  candidate["bounce.mailboxes"] = candidate["bounce.mailboxes"].map(
    (item: Record<string, unknown>) => ({ ...item, password: "" }),
  );
  const write = await request("/api/settings", "PUT", JSON.stringify(candidate));
  check(
    write.status === 200 && JSON.stringify(await write.json()) === '{"data":true}',
    "full-write",
  );
  const updated = ((await (await request("/api/settings")).json()) as { data: Record<string, any> })
    .data;
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
  const addressCandidate = structuredClone(updated);
  addressCandidate["app.from_email"] = ['"Display, Name" <"quoted local"@example.invalid>'];
  check(
    (await request("/api/settings", "PUT", JSON.stringify(addressCandidate))).status === 200,
    "quoted-from-address",
  );
  check(
    ((await (await request("/api/settings")).json()) as { data: Record<string, any> }).data[
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
      ((await (await request("/api/settings")).json()) as { data: Record<string, any> }).data[
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
    ((await (await request("/api/settings")).json()) as { data: Record<string, any> }).data[
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
    ((await (await request("/api/settings")).json()) as { data: Record<string, any> }).data[
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
    formKey.status === 400 && JSON.stringify(await formKey.json()) === '{"message":"Bad Request"}',
    "key-form-bad-request",
  );
  check(
    (await request("/api/settings/app.site_name", "PUT", JSON.stringify("Synthetic settings")))
      .status === 200,
    "key-restore",
  );
  check(
    ((await (await request("/api/settings")).json()) as { data: Record<string, any> }).data[
      "app.site_name"
    ] === "Synthetic settings",
    "key-read",
  );
  const unknown = await request("/api/settings/unknown.setting", "PUT", "true");
  check(unknown.status === (target.mode === "reference" ? 200 : 400), "unknown-key-d44");
  const malformedKey = await request("/api/settings/app.batch_size", "PUT", '"not-an-integer"');
  check(malformedKey.status === (target.mode === "reference" ? 200 : 400), "invalid-key-d44");
  const finalGet = await request("/api/settings");
  check(finalGet.status === (target.mode === "reference" ? 500 : 200), "invalid-key-read-d44");
  if (target.mode === "normal") {
    check(
      ((await finalGet.json()) as { data: Record<string, any> }).data["app.batch_size"] ===
        snapshot["app.batch_size"],
      "invalid-key-rollback",
    );
    if (target.restart) {
      await target.restart();
      const persisted = (
        (await (await request("/api/settings")).json()) as { data: Record<string, any> }
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
    if (process.argv[2] !== "reference") throw new Error("Invalid mode");
    const {
      REFERENCE_URL: baseUrl,
      REFERENCE_API_USER: user,
      REFERENCE_API_TOKEN: token,
    } = process.env;
    if (!baseUrl || !user || !token) throw new Error("Missing reference credentials");
    await runSettingsContract({ mode: "reference", baseUrl, credentials: { user, token } });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^FAIL [a-zA-Z0-9-]+$/.test(error.message) ? error.message : "Settings contract failed"}\n`,
    );
    process.exitCode = 1;
  }
}
