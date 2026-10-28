// Public parser regressions: listmonk cmd/settings.go at 6fcd95f.
import { settingsFetch } from "@/test/contract/settings-reference-fetch";
import type { Credentials, Mode } from "@/test/contract/types";

export async function runSettingsCouncilParser(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
}) {
  const auth = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const request = (value?: unknown) =>
    settingsFetch(
      `${target.baseUrl}/api/settings`,
      {
        method: value === undefined ? "GET" : "PUT",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      },
      target.mode === "reference",
    );
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`FAIL settings-council-parser-${label}`);
  };
  const read = async () => {
    const response = await request();
    check(response.status === 200, "read");
    return (await response.json()).data as Record<string, any>;
  };
  const original = await read();
  const candidate = (snapshot: Record<string, any>) => {
    const value = structuredClone(snapshot);
    for (const key of ["smtp", "messengers", "bounce.mailboxes"])
      for (const item of value[key]) item.password = "";
    return value;
  };
  async function accepted(key: string, value: unknown, label: string) {
    const before = await read();
    const next = candidate(before);
    next[key] = value;
    if (key === "app.cache_slow_queries_interval") next["app.cache_slow_queries"] = true;
    const response = await request(next);
    const result = await response.json();
    check(response.status === 200 && JSON.stringify(result) === '{"data":true}', `${label}-status`);
    const after = await read();
    check(JSON.stringify(after[key]) === JSON.stringify(value), `${label}-stored`);
  }
  async function rejected(
    key: string,
    value: unknown,
    message: string,
    label: string,
    enabled = false,
  ) {
    const before = await read();
    const next = candidate(before);
    next[key] = value;
    if (enabled) next["app.cache_slow_queries"] = true;
    next["app.site_name"] = "parser rollback sentinel";
    const response = await request(next);
    check(response.status === 400, `${label}-status`);
    const body = await response.json();
    check(JSON.stringify(body) === JSON.stringify({ message }), `${label}-error`);
    check(JSON.stringify(await read()) === JSON.stringify(before), `${label}-rollback`);
  }
  for (const [label, url] of [
    ["url-no-authority", "http:example.invalid"],
    ["url-backslash", "http://example.invalid\\evil"],
    ["url-bad-port", "http://example.invalid:bad"],
    ["url-bad-path-escape", "https://example.invalid/%zz"],
    ["url-escaped-host-ascii", "https://%65xample.invalid"],
    ["url-fragment-escape", "https://example.invalid/#%xx"],
    ["url-invalid-brackets", "http://[127.0.0.1]"],
  ])
    await rejected(
      "security.trusted_urls",
      [url],
      `Invalid data: invalid trusted URL: ${url}`,
      label!,
    );
  for (const [label, url] of [
    ["url-normal", "https://example.invalid:443/a%20b?q=%zz"],
    ["url-user", "http://user:pass@example.invalid/path#fragment"],
    ["url-empty-port", "http://example.invalid:"],
    ["url-port-only", "http://:80"],
    ["url-uppercase-scheme", "HTTP://example.invalid"],
    ["url-ipv6", "http://[::1]:8080/"],
    ["url-wildcard", "*"],
  ])
    await accepted("security.trusted_urls", [url], label!);
  for (const [label, address] of [
    ["mapped-loopback", "a@[::ffff:127.0.0.1]"],
    ["mapped-testnet", "a@[::ffff:192.0.2.1]"],
    ["mapped-hex", "a@[::ffff:c000:201]"],
    ["phrase-previous-word", "Good =?x-bad?b?YQ==?= <a@example.invalid>"],
    ["prefixed-ipv6", "a@[IPv6:::1]"],
    ["malformed-q-unicode", "=?x-bad?q?ż?= <a@example.invalid>"],
    ["empty-then-valid-phrase", "=?utf-8?b??= Good <a@example.invalid>"],
    ["comment-supported-escaped", "a@example.invalid (=?utf-8?b?YQ\\==?=)"],
  ])
    await accepted("app.from_email", [address], label!);
  for (const [label, address] of [
    ["raw-ipv6", "a@[::1]"],
    ["ipv4-compatible", "a@[::192.0.2.1]"],
    ["unknown-first-word", "=?x-bad?b?YQ==?= <a@example.invalid>"],
    ["empty-before-unknown", "=?utf-8?b??= =?x-bad?b?YQ==?= <a@example.invalid>"],
    ["comment-escaped-base64", "a@example.invalid (=?x-bad?b?YQ\\==?=)"],
    ["comment-escaped-ending", "a@example.invalid (=?x-bad?b?YQ==?\\=)"],
  ])
    await rejected("app.from_email", [address], `invalid from email address: ${address}`, label!);
  for (const [label, cron] of [
    ["cron-local", "TZ=Local 0 0 * * *"],
    ["cron-utc", "TZ=UTC 0 0 * * *"],
    ["cron-gmt", "TZ=GMT 0 0 * * *"],
    ["cron-warsaw", "TZ=Europe/Warsaw 0 0 * * *"],
    ["cron-us-eastern-alias", "TZ=US/Eastern 0 0 * * *"],
    ["cron-us-eastern-prefix", "CRON_TZ=US/Eastern 0 0 * * *"],
    ["cron-etc-offset", "TZ=Etc/GMT+1 0 0 * * *"],
    ["cron-empty-zone", "TZ= 0 0 * * *"],
    ["cron-nel", "0\u00850\u0085*\u0085*\u0085*"],
    ["cron-large-step", "*/9007199254740992 0 * * *"],
    ["cron-max-step", "*/9223372036854775807 0 * * *"],
    ["cron-last-day-valid", "0 0 L-30 * *"],
    ["cron-nth-weekday-valid", "0 0 * * MON#5"],
    ["cron-nearest-weekday-valid", "0 0 31W * *"],
    ["cron-last-weekday-valid", "0 0 * * MONL"],
    ["cron-duration-valid", "@every 1s"],
  ])
    await accepted("app.cache_slow_queries_interval", cron, label!);
  for (const [label, cron, error] of [
    ...["utc", "gmt", "europe/warsaw", "us/eastern", "+01:00", "Europe/Warsaw\nEurope/Zagreb"].map(
      (zone, index) => [
        `cron-bad-zone-${index}`,
        `TZ=${zone} 0 0 * * *`,
        `provided bad location ${zone}: unknown time zone ${zone}`,
      ],
    ),
    [
      "cron-named-occurrence",
      "0 0 * * MON#mon",
      'failed to parse int from mon: strconv.Atoi: parsing "mon": invalid syntax',
    ],
    ["cron-weekday-last-range", "0 0 * * L-6", "L-6: invalid expression"],
    ["cron-weekday-near-range", "0 0 32W * *", "32W: value 32 out of valid range [1, 31]"],
    [
      "cron-weekday-near-syntax",
      "0 0 xW * *",
      'failed to parse int from x: strconv.Atoi: parsing "x": invalid syntax',
    ],
    [
      "cron-last-big",
      "0 0 L-9007199254740992 * *",
      "L-9007199254740992: invalid amount of days subtracted",
    ],
    ["cron-weekday-near-zero", "0 0 0W * *", "0W: value 0 out of valid range [1, 31]"],
    [
      "cron-occurrence-big",
      "0 0 * * MON#9007199254740992",
      "MON#9007199254740992: value 9007199254740992 out of valid range [1, 5]",
    ],
    [
      "cron-duration-missing-unit",
      "@every 1",
      'failed to parse duration @every 1: time: missing unit in duration "1"',
    ],
    [
      "cron-duration-fraction",
      "@every 1.5s",
      "delay must be a multiple of one second but was 1.5s",
    ],
    [
      "cron-duration-unit",
      "@every 1z",
      'failed to parse duration @every 1z: time: unknown unit "z" in duration "1z"',
    ],
    [
      "cron-bom",
      "\ufeff0 0 * * *",
      'failed to parse int from \ufeff0: strconv.Atoi: parsing "\\ufeff0": invalid syntax',
    ],
    ["cron-last-day", "0 0 L-31 * *", "L-31: invalid amount of days subtracted"],
    ["cron-nth-weekday", "0 0 * * MON#6", "MON#6: value 6 out of valid range [1, 5]"],
    [
      "cron-overflow",
      "*/9223372036854775808 0 * * *",
      'failed to parse int from 9223372036854775808: strconv.Atoi: parsing "9223372036854775808": value out of range',
    ],
  ])
    await rejected(
      "app.cache_slow_queries_interval",
      cron,
      `Invalid data: slow query cron: ${error}`,
      label!,
      true,
    );
  const disabled = candidate(await read());
  disabled["app.cache_slow_queries"] = false;
  disabled["app.cache_slow_queries_interval"] = "\ufeffnot a cron";
  check((await request(disabled)).status === 200, "cron-disabled");
  check(
    (await read())["app.cache_slow_queries_interval"] ===
      disabled["app.cache_slow_queries_interval"],
    "cron-disabled-stored",
  );
  check((await request(candidate(original))).status === 200, "restore");
}
