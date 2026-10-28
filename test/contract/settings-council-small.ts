// Public regressions for listmonk cmd/settings.go and models.HasTplExpr at 6fcd95f.
import type { Credentials, Mode } from "@/test/contract/types";
import { settingsFetch } from "@/test/contract/settings-reference-fetch";

export async function runSettingsCouncilSmall(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
}) {
  const auth = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const request = (path = "/api/settings", method = "GET", value?: unknown) =>
    settingsFetch(
      target.baseUrl + path,
      {
        method,
        headers: { Authorization: auth, "Content-Type": "application/json" },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      },
      target.mode === "reference",
    );
  function check(value: unknown, label: string): asserts value {
    if (!value) throw new Error(`FAIL settings-council-small-${label}`);
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
      for (const entry of out[key]) entry.password = "";
    return out;
  }
  const reversed = candidate();
  reversed["app.from_email"] = ["valid@example.invalid", "}}not an address{{"];
  const rejected = await request("/api/settings", "PUT", reversed);
  check(rejected.status === 400, "reversed-template-status");
  check(
    JSON.stringify(await rejected.json()) ===
      JSON.stringify({ message: "invalid from email address: }}not an address{{" }),
    "reversed-template-error",
  );
  check(JSON.stringify(await read()) === JSON.stringify(original), "reversed-template-no-write");
  const templated = candidate();
  templated["app.from_email"] = ["valid@example.invalid", "{{ .Subscriber.Email }}"];
  check((await request("/api/settings", "PUT", templated)).status === 200, "ordered-template");

  const maps = candidate();
  maps["bounce.actions"] = JSON.parse(
    '{"__proto__":{"count":3,"action":"blocklist"},"constructor":{"count":4,"action":"none"}}',
  );
  const headers = Object.fromEntries([
    ["__proto__", "synthetic-header"],
    ["constructor", "synthetic-constructor"],
    ["toString", "synthetic-string"],
    ["X-Test", "kept"],
  ]);
  maps.smtp[0].email_headers = [headers];
  check((await request("/api/settings", "PUT", maps)).status === 200, "full-map-write");
  const saved = await read();
  check(
    Object.hasOwn(saved["bounce.actions"], "__proto__") &&
      saved["bounce.actions"].__proto__.count === 3 &&
      saved["bounce.actions"].__proto__.action === "blocklist" &&
      saved["bounce.actions"].constructor.count === 4,
    "full-map-projection",
  );
  for (const [key, value] of Object.entries(headers))
    check(
      Object.hasOwn(saved.smtp[0].email_headers[0], key) &&
        saved.smtp[0].email_headers[0][key] === value,
      `header-${key}`,
    );
  const replacement = JSON.parse('{"__proto__":{"count":9,"action":"blocklist"}}');
  check(
    (await request("/api/settings/bounce.actions", "PUT", replacement)).status === 200,
    "key-map-write",
  );
  check((await read())["bounce.actions"].__proto__.count === 9, "key-map-projection");

  const secrets = candidate();
  const first = "first-synthetic";
  const last = "last-synthetic-secret";
  const server = { ...secrets.smtp[0], name: "", uuid: "m12-council-duplicate", enabled: true };
  secrets.smtp = [
    { ...server, password: first },
    { ...server, password: last },
  ];
  check((await request("/api/settings", "PUT", secrets)).status === 200, "duplicate-uuid-write");
  const masked = await read();
  check(
    masked.smtp[0].password === "•".repeat(first.length) &&
      masked.smtp[1].password === "•".repeat(last.length),
    "duplicate-uuid-initial-masks",
  );
  secrets.smtp = [{ ...server, password: "" }];
  check((await request("/api/settings", "PUT", secrets)).status === 200, "retain-secret-write");
  check((await read()).smtp[0].password === "•".repeat(last.length), "retain-last-secret-mask");
  check((await request("/api/settings", "PUT", candidate())).status === 200, "restore-config");
}
