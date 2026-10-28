// Representative HTTP binding cases shared with the pinned reference.
import type { Credentials, Mode } from "@/test/contract/types";
import { settingsFetch } from "@/test/contract/settings-reference-fetch";

export async function runSettingsBinding(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
}) {
  const auth = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const request = (path: string, init: RequestInit) =>
    settingsFetch(target.baseUrl + path, init, target.mode === "reference");
  const get = async () =>
    (
      (await (await request("/api/settings", { headers: { Authorization: auth } })).json()) as {
        data: Record<string, any>;
      }
    ).data;
  const put = (path: string, body: string, type = "application/json") =>
    request(path, { method: "PUT", headers: { Authorization: auth, "Content-Type": type }, body });
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL settings-binding-${label}`);
  };
  const original = await get();
  const base = `<Settings><AppFromEmail>a@example.invalid</AppFromEmail><SMTP><Enabled>true</Enabled></SMTP><SecuritySessionDuration>7d</SecuritySessionDuration>`;
  const xml = (contents: string) => base + contents + "</Settings>";
  for (const [label, contents, expected] of [
    ["empty-scalars", "<AppBatchSize/><EnablePublicArchive/>", 0],
    ["nel-padding", "<AppBatchSize>\u0085 42 \u0085</AppBatchSize>", 42],
  ] as const) {
    check((await put("/api/settings", xml(contents), "application/xml")).status === 200, label);
    const result = await get();
    check(
      result["app.batch_size"] === expected && result["app.enable_public_archive"] === false,
      `${label}-projection`,
    );
  }
  check(
    (
      await put(
        "/api/settings",
        xml("<AppNotifyEmails/><AppNotifyEmails>x</AppNotifyEmails>"),
        "application/xml",
      )
    ).status === 200,
    "repeated-slice",
  );
  check(
    JSON.stringify((await get())["app.notify_emails"]) === '["","x"]',
    "repeated-slice-projection",
  );
  check(
    (await put("/api/settings", xml("") + "<broken", "application/xml")).status === 200,
    "unconsumed-suffix",
  );
  const suffixBytes = new Uint8Array([...new TextEncoder().encode(xml("")), 255]);
  check(
    (
      await request("/api/settings", {
        method: "PUT",
        headers: { Authorization: auth, "Content-Type": "application/xml" },
        body: suffixBytes,
      })
    ).status === 200,
    "unconsumed-invalid-utf8",
  );
  const badBytes = new Uint8Array([
    ...new TextEncoder().encode(base + "<AppSiteName>"),
    255,
    ...new TextEncoder().encode("</AppSiteName></Settings>"),
  ]);
  const beforeBytes = await get();
  check(
    (
      await request("/api/settings", {
        method: "PUT",
        headers: { Authorization: auth, "Content-Type": "application/xml" },
        body: badBytes,
      })
    ).status === 400,
    "consumed-invalid-utf8",
  );
  check(
    JSON.stringify(await get()) === JSON.stringify(beforeBytes),
    "consumed-invalid-utf8-no-write",
  );
  check(
    (await put("/api/settings", "<!DOCTYPE Settings>" + xml(""), "application/xml")).status === 200,
    "doctype",
  );
  check(
    (
      await put(
        "/api/settings",
        '<?xml version="1.0" encoding="UTF-8"?>' + xml("<Unknown><Thing/></Unknown>"),
        "text/xml",
      )
    ).status === 200,
    "declaration-metadata",
  );
  check(
    (await put("/api/settings", xml("<OIDC><DefaultUserRoleID/></OIDC>"), "application/xml"))
      .status === 200,
    "empty-nullable-role",
  );
  check(
    (await get())["security.oidc"].default_user_role_id === null,
    "empty-nullable-role-projection",
  );
  check(
    (
      await put(
        "/api/settings",
        xml("<OIDC><Roles><Claim>x</Claim><Match>y</Match></Roles></OIDC>"),
        "application/xml",
      )
    ).status === 200,
    "omitted-pointer-role",
  );
  for (const [label, body] of [
    ["bom-scalar", xml("<AppBatchSize>\ufeff42\ufeff</AppBatchSize>")],
    ["unsupported-map", xml("<BounceActions><x><Count>1</Count></x></BounceActions>")],
    ["incomplete", xml("").slice(0, -8)],
    ["unknown-entity", xml("<AppSiteName>&bad;</AppSiteName>")],
    [
      "empty-pointer-role",
      xml("<OIDC><Roles><Claim>x</Claim><Match>y</Match><UserRoleID/></Roles></OIDC>"),
    ],
  ] as const) {
    const before = await get();
    check((await put("/api/settings", body, "application/xml")).status === 400, label);
    check(JSON.stringify(await get()) === JSON.stringify(before), `${label}-no-write`);
  }
  const longS: Record<string, unknown> = { ...original, "app.ſite_name": "folded" };
  delete longS["app.site_name"];
  check((await put("/api/settings", JSON.stringify(longS))).status === 200, "long-s");
  check((await get())["app.site_name"] === "folded", "long-s-projection");
  const sharpS: Record<string, unknown> = { ...original, "app.ßite_name": "ignored" };
  delete sharpS["app.site_name"];
  check((await put("/api/settings", JSON.stringify(sharpS))).status === 200, "sharp-s");
  check((await get())["app.site_name"] === "", "sharp-s-projection");
  const addMembers = (members: string) =>
    JSON.stringify(original).slice(0, -1) + "," + members + "}";
  for (const [label, members, field, expected] of [
    [
      "root-duplicate-null",
      '"app.site_name":"first","APP.SITE_NAME":null',
      "app.site_name",
      "first",
    ],
    [
      "nested-alias",
      '"security.captcha":{"hcaptcha":{"key":"a"},"HCAPTCHA":{"KEY":"b","secret":null}}',
      "security.captcha.hcaptcha.key",
      "b",
    ],
    [
      "slice-reset",
      '"app.notify_emails":["a"],"APP.NOTIFY_EMAILS":null,"app.notify_emails":["b",null]',
      "app.notify_emails",
      ["b", ""],
    ],
    [
      "map-duplicate",
      '"bounce.actions":{"bounce":{"count":1,"action":"a"}},"BOUNCE.ACTIONS":{"bounce":{"count":2}}',
      "bounce.actions.bounce",
      { count: 2, action: "" },
    ],
    [
      "nullable",
      '"security.oidc":{"roles":[{"claim":"x","match":"y","user_role_id":null}]}',
      "security.oidc.roles",
      [{ claim: "x", match: "y" }],
    ],
  ] as const) {
    check((await put("/api/settings", addMembers(members))).status === 200, label);
    let value: any = await get();
    if (label === "nested-alias") value = value["security.captcha"].hcaptcha.key;
    else if (label === "map-duplicate") value = value["bounce.actions"].bounce;
    else if (label === "nullable") value = value["security.oidc"].roles;
    else value = value[field];
    check(JSON.stringify(value) === JSON.stringify(expected), `${label}-projection`);
  }
  for (const members of ['"app.batch_size":1e999', '"app.batch_size":1.0', '"unknown":{"x":}']) {
    const before = await get();
    check((await put("/api/settings", addMembers(members))).status === 400, "bad-json-or-number");
    check(JSON.stringify(await get()) === JSON.stringify(before), "bad-json-or-number-no-write");
  }
  check(
    (await put("/api/settings", addMembers('"unknown":{"x":1e999}'))).status === 200,
    "unused-large-metadata",
  );
  for (const [label, type, body, message] of [
    [
      "form-valid",
      "application/x-www-form-urlencoded",
      "AppFromEmail=a%40b",
      "at least one `from` address is required",
    ],
    ["form-escape", "application/x-www-form-urlencoded", "x=%zz", "Bad Request"],
    ["form-semicolon", "application/x-www-form-urlencoded", "a=b;c=d", "Bad Request"],
    ["multipart-boundary", "multipart/form-data", "--a\r\n", "Bad Request"],
    ["multipart-malformed", "multipart/form-data; boundary=x", "--x\r\nnope\r\n", "Bad Request"],
    [
      "multipart-valid",
      "multipart/form-data; boundary=x",
      '--x\r\nContent-Disposition: form-data; name="AppFromEmail"\r\n\r\na@example.invalid\r\n--x--\r\n',
      "at least one `from` address is required",
    ],
  ] as const) {
    const before = await get();
    const result = await put("/api/settings", body, type);
    check(result.status === 400 && ((await result.json()) as any).message === message, label);
    check(JSON.stringify(await get()) === JSON.stringify(before), `${label}-no-write`);
  }
  check(
    (await put("/api/settings/app.site_name", "<value>hello</value>", "application/xml")).status ===
      (target.mode === "reference" ? 500 : 400),
    "key-xml-raw-invalid",
  );
  for (const address of [
    '"quoted local"@example.invalid',
    "A (comment) <a@example.invalid>",
    "a@example.invalid (comment)",
    "Group: a@example.invalid;",
    "=?UTF-8?Q?M=C3=BCller?= <a@example.invalid>",
    "=?ISO-8859-1?Q?Andr=E9?= <a@example.invalid>",
    "a@[IPv6:::1]",
    "a@[127.0.0.1]",
    "a@[IPv6:127.0.0.1]",
    "üñî@example.invalid",
  ]) {
    check(
      (await put("/api/settings", JSON.stringify({ ...original, "app.from_email": [address] })))
        .status === 200,
      "address-valid",
    );
    check((await get())["app.from_email"][0] === address, "address-projection");
  }
  for (const address of [
    '""@example.invalid',
    "Group: a@example.invalid, b@example.invalid;",
    "=?x-bad?Q?foo?= <a@example.invalid>",
    "a@[::1]",
    "a..b@example.invalid",
    "a@example.invalid, b@example.invalid",
    '"unclosed <a@example.invalid>',
  ]) {
    const before = await get();
    check(
      (await put("/api/settings", JSON.stringify({ ...original, "app.from_email": [address] })))
        .status === 400,
      "address-invalid",
    );
    check(JSON.stringify(await get()) === JSON.stringify(before), "address-invalid-no-write");
  }
  for (const cron of [
    "@daily",
    "@every 1s",
    "TZ=UTC 0 0 * * *",
    "CRON_TZ=Europe/Warsaw 0 0 * * *",
    "0,,5 0 * * *",
    "*/5 0-23/2 1,15 JAN,MAR MON-FRI",
    "0 0 L * *",
    "0 0 L-2 * *",
    "0 0 15W * *",
    "0 0 LW * *",
    "0 0 * * MON#2",
    "0 0 * * 5L",
    "0 0 ? * SUN",
  ])
    check(
      (
        await put(
          "/api/settings",
          JSON.stringify({
            ...original,
            "app.cache_slow_queries": true,
            "app.cache_slow_queries_interval": cron,
          }),
        )
      ).status === 200,
      "cron-valid",
    );
  for (const cron of [
    "@every 1500ms",
    "@reboot",
    "TZ=No/Such 0 0 * * *",
    "0 0 * *",
    "0 0 * JAN/DEC *",
    "0 0 * * 7",
    "0 0 * * * trailing",
  ]) {
    const before = await get();
    check(
      (
        await put(
          "/api/settings",
          JSON.stringify({
            ...original,
            "app.cache_slow_queries": true,
            "app.cache_slow_queries_interval": cron,
          }),
        )
      ).status === 400,
      "cron-invalid",
    );
    check(JSON.stringify(await get()) === JSON.stringify(before), "cron-invalid-no-write");
  }
  const descriptor = await put(
    "/api/settings",
    JSON.stringify({
      ...original,
      "app.cache_slow_queries": true,
      "app.cache_slow_queries_interval": "@reboot",
    }),
  );
  check(
    descriptor.status === 400 &&
      ((await descriptor.json()) as any).message ===
        "Invalid data: slow query cron: unrecognized descriptor: @reboot",
    "cron-error-envelope",
  );
  const fractional = await put(
    "/api/settings",
    JSON.stringify({
      ...original,
      "app.cache_slow_queries": true,
      "app.cache_slow_queries_interval": "@every 1500ms",
    }),
  );
  check(
    fractional.status === 400 &&
      ((await fractional.json()) as any).message ===
        "Invalid data: slow query cron: delay must be a multiple of one second but was 1.5s",
    "cron-duration-envelope",
  );
  check((await put("/api/settings", JSON.stringify(original))).status === 200, "restore");
}
