// Public settings boundary regressions for D46; pinned listmonk 6fcd95f.
import { withBlankPasswords } from "@/test/contract/settings-candidate";
import { listmonkEnvelope } from "@/test/contract/envelope";
import { assertReloadable } from "@/test/contract/settings-reference-fetch";
import type { Credentials, Mode } from "@/test/contract/types";
import { asBody } from "@/test/read-body";

function check(value: unknown, label: string): asserts value {
  if (!value) {
    throw new Error(`FAIL settings-D46-${label}`);
  }
}

export async function runSettingsNul(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
}) {
  const auth = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const request = (path = "/api/settings", method = "GET", body?: string) =>
    fetch(target.baseUrl + path, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body }),
    });
  async function read() {
    const response = await request();
    check(response.status === 200, "read");
    return asBody<Record<string, any>>((await response.json()).data);
  }
  const before = await read();
  function candidate() {
    const out = withBlankPasswords(before);
    out["app.batch_size"] = 11;
    return out;
  }
  for (const [i, change] of [
    (out: Record<string, any>) => {
      out["app.site_name"] = "A\0B";
    },
    (out: Record<string, any>) => {
      out.smtp[0].password = "fixture\0secret";
    },
    (out: Record<string, any>) => {
      out.smtp[0].email_headers = [{ "X-Test": "A\0B" }];
    },
    (out: Record<string, any>) => {
      out.smtp[0].email_headers = [{ "X\0Test": "value" }];
    },
  ].entries()) {
    const out = candidate();
    change(out);
    const response = await request("/api/settings", "PUT", JSON.stringify(out));
    check(response.status === (target.mode === "reference" ? 500 : 400), `full-${i}`);
    if (target.mode === "normal") {
      check(
        JSON.stringify(listmonkEnvelope(await response.json(), target.mode, response.status)) ===
          '{"message":"Invalid data."}',
        "safe-error",
      );
    }
    check(JSON.stringify(await read()) === JSON.stringify(before), `full-${i}-no-write`);
  }
  for (const [key, value] of [
    ["app.site_name", "A\0B"],
    ["smtp", [{ ...candidate().smtp[0], email_headers: [{ "X\0Test": "value" }] }]],
  ]) {
    const response = await request(`/api/settings/${key}`, "PUT", JSON.stringify(value));
    check(response.status === (target.mode === "reference" ? 500 : 400), `key-${key}`);
    check(JSON.stringify(await read()) === JSON.stringify(before), `key-${key}-no-write`);
  }
  const out = candidate();
  out.smtp[0].name = "Normalized\0 Name";
  const body =
    JSON.stringify(out).slice(0, -1) +
    String.raw`,"app.site_name":"bad\u0000name","APP.SITE_NAME":"Final bound value",` +
    String.raw`"unconsumed_metadata":{"bad":"discarded\u0000value"}}`;
  const response = await request("/api/settings", "PUT", body);
  check(response.status === 200, "final-bound-write");
  await assertReloadable(target.mode === "reference", "final-bound-write");
  const after = await read();
  check(after["app.site_name"] === "Final bound value", "overwritten-and-ignored");
  check(after.smtp[0].name === "email-normalized--name", "normalized-value");
}
