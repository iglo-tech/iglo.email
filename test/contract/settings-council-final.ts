// Public round-3 regressions for pinned listmonk/Go/cron; D48 is explicitly paired.
import { settingsFetch } from "@/test/contract/settings-reference-fetch";
import type { Credentials, Mode } from "@/test/contract/types";

export async function runSettingsCouncilFinal(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
}) {
  const auth = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const request = (body?: string | Uint8Array, path = "/api/settings") =>
    settingsFetch(
      target.baseUrl + path,
      {
        method: body === undefined ? "GET" : "PUT",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: body as BodyInit }),
      },
      target.mode === "reference",
    );
  function check(value: unknown, label: string): asserts value {
    if (!value) throw new Error(`FAIL settings-council-final-${label}`);
  }
  async function read() {
    const response = await request();
    check(response.status === 200, "read");
    return (await response.json()).data as Record<string, any>;
  }
  const original = await read();
  function candidate() {
    const out = structuredClone(original);
    for (const key of ["smtp", "messengers", "bounce.mailboxes"])
      for (const item of out[key]) item.password = "";
    return out;
  }
  for (const [label, address] of [
    ["bom-base64", "=?utf-8?b?77u/?= <a@example.invalid>"],
    ["bom-q", "=?utf-8?q?=EF=BB=BF?= <a@example.invalid>"],
    ["bom-fallback", "=?utf-8?b?77u/?= =?x-bad?b?YQ==?= <a@example.invalid>"],
    ["fold-ascii", "=?uſ-aſcii?b?YQ==?= <a@example.invalid>"],
    ["fold-latin", "=?iſo-8859-1?b?YQ==?= <a@example.invalid>"],
    ["ordinary-case", "=?UtF-8?b?YQ==?= <a@example.invalid>"],
  ]) {
    const out = candidate();
    out["app.from_email"] = [address];
    check((await request(JSON.stringify(out))).status === 200, `${label}-status`);
    check((await read())["app.from_email"][0] === address, `${label}-stored`);
  }
  const beforeAlias = await read();
  const badAlias = candidate();
  const address = "=?uß-aßcii?b?YQ==?= <a@example.invalid>";
  badAlias["app.from_email"] = [address];
  const aliasResponse = await request(JSON.stringify(badAlias));
  check(aliasResponse.status === 400, "no-fold-expansion-status");
  check(
    JSON.stringify(await aliasResponse.json()) ===
      JSON.stringify({ message: `invalid from email address: ${address}` }),
    "no-fold-expansion-error",
  );
  check(JSON.stringify(await read()) === JSON.stringify(beforeAlias), "no-fold-expansion-rollback");

  for (const [label, expression, error] of [
    ["minute-rewrite", "60/2 0 * * *", "60-59/2: value 60 out of valid range [0, 59]"],
    ["day-rewrite", "0 0 32/2 * *", "32-31/2: value 32 out of valid range [1, 31]"],
    ["negative-step", "*/-1 0 * * *", "negative number (-1) not allowed: -1"],
    ["negative-zero", "*/-0 0 * * *", "step should be > 0, got 0"],
    ["negative-leading-zero", "*/-01 0 * * *", "negative number (-1) not allowed: -01"],
    [
      "negative-overflow",
      "*/-9223372036854775809 0 * * *",
      'failed to parse int from -9223372036854775809: strconv.Atoi: parsing "-9223372036854775809": value out of range',
    ],
  ]) {
    const before = await read();
    const out = candidate();
    out["app.cache_slow_queries"] = true;
    out["app.cache_slow_queries_interval"] = expression;
    out["app.site_name"] = "round-three rollback sentinel";
    const response = await request(JSON.stringify(out));
    check(response.status === 400, `${label}-status`);
    check(
      JSON.stringify(await response.json()) ===
        JSON.stringify({ message: `Invalid data: slow query cron: ${error}` }),
      `${label}-error`,
    );
    check(JSON.stringify(await read()) === JSON.stringify(before), `${label}-rollback`);
  }

  const encoder = new TextEncoder();
  for (const [label, bytes, expected] of [
    ["broken-prefix", [0xe1, 0x80, 0x41], "��A"],
    ["truncated-prefix", [0xe1, 0x80], "��"],
    ["surrogate", [0xed, 0xa0, 0x80], "���"],
    ["overlong", [0xf0, 0x80, 0x80, 0xaf], "����"],
    ["valid-rune", [0xc3, 0xa9], "é"],
  ] as const) {
    const out = candidate();
    out["app.site_name"] = "ROUND_THREE_UTF8";
    const text = JSON.stringify(out);
    const index = text.indexOf("ROUND_THREE_UTF8");
    const body = Uint8Array.from([
      ...encoder.encode(text.slice(0, index)),
      ...bytes,
      ...encoder.encode(text.slice(index + "ROUND_THREE_UTF8".length)),
    ]);
    check((await request(body)).status === 200, `${label}-status`);
    check((await read())["app.site_name"] === expected, `${label}-stored`);
    const keyBody = Uint8Array.from([34, ...bytes, 34]);
    const beforeKey = await read();
    // D44 binds a typed candidate; upstream forwards RawMessage bytes to PG.
    const referenceRawFailure = target.mode === "reference" && label !== "valid-rune";
    check(
      (await request(keyBody, "/api/settings/app.site_name")).status ===
        (referenceRawFailure ? 500 : 200),
      `${label}-key-status`,
    );
    const afterKey = await read();
    if (referenceRawFailure)
      check(JSON.stringify(afterKey) === JSON.stringify(beforeKey), `${label}-D44-key-no-write`);
    else check(afterKey["app.site_name"] === expected, `${label}-key-stored`);
  }

  for (const firstEnabled of [false, true]) {
    const before = await read();
    const out = candidate();
    delete out.smtp;
    const body =
      JSON.stringify(out).slice(0, -1) +
      ',"smtp":[' +
      JSON.stringify({ enabled: firstEnabled }) +
      ',{"enabled":true,"name":"second","host":"retained.example","port":25}],' +
      '"smtp":[{}],"smtp":[{},{}]}';
    const response = await request(body);
    const allowed = firstEnabled || target.mode === "reference";
    check(response.status === (allowed ? 200 : 400), `D48-${firstEnabled}-status`);
    const after = await read();
    if (!allowed) {
      check(
        JSON.stringify(await response.json()) ===
          JSON.stringify({
            message:
              "At least one enabled SMTP server must be included in the default 'email' messenger.",
          }),
        "D48-error",
      );
      check(JSON.stringify(after) === JSON.stringify(before), "D48-rollback");
    } else {
      const second = after.smtp[1];
      const retained = target.mode === "reference";
      check(
        second.enabled === retained &&
          second.name === (retained ? "email-second" : "") &&
          second.host === (retained ? "retained.example" : "") &&
          second.port === (retained ? 25 : 0),
        `D48-${firstEnabled}-projection`,
      );
    }
  }
  check((await request(JSON.stringify(candidate()))).status === 200, "restore");
}
